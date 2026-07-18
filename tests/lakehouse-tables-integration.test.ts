import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { loadManifest } from "../src/manifest";
import { loadApprovedPlan } from "../src/plan-artifact";
import { buildPlan, rehashPlan } from "../src/planner";
import type { ApplyCheckpoint } from "../src/types";

function createFixture(): {
  root: string;
  manifestPath: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-integration-"));
  const lakehouse = path.join(root, "items/lakehouse");
  const tables = path.join(root, "items/tables");
  mkdirSync(path.join(tables, "definition/tables"), {
    recursive: true,
  });
  mkdirSync(lakehouse, { recursive: true });
  writeFileSync(
    path.join(lakehouse, "item.yaml"),
    [
      "displayName: DdlLakehouse",
      "desiredState: present",
      "enableSchemas: true",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(tables, "item.yaml"),
    [
      "displayName: Managed tables",
      "desiredState: present",
      "references:",
      "  lakehouse: lakehouse",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(tables, "definition/tables.yaml"),
    [
      "apiVersion: fabric.deploy/tables/v1alpha1",
      "kind: LakehouseTables",
      "defaultSchema: dbo",
      "adoptExisting: false",
      "tables:",
      "  - logicalId: helloWorld",
      "    file: tables/001-hello.sql",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(tables, "definition/tables/001-hello.sql"),
    [
      "CREATE TABLE IF NOT EXISTS dbo.hello_world (",
      "  id BIGINT NOT NULL,",
      "  message STRING",
      ")",
      "USING DELTA;",
      "",
    ].join("\n"),
    "utf8",
  );
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(
    manifestPath,
    [
      "apiVersion: fabric.deploy/v1alpha1",
      "kind: FabricDeployment",
      "metadata:",
      "  deploymentId: ddl-integration",
      "workspace:",
      "  id: workspace-1",
      "items:",
      "  - logicalId: lakehouse",
      "    type: Lakehouse",
      "    path: items/lakehouse",
      "  - logicalId: tables",
      "    type: LakehouseTables",
      "    path: items/tables",
      "    dependsOn:",
      "      - lakehouse",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, manifestPath };
}

function otherAdapters() {
  const fail = async () => {
    throw new Error("Unexpected adapter call.");
  };
  return {
    environment: { plan: fail },
    notebook: { plan: fail },
    sparkJob: { plan: fail },
    pipeline: { plan: fail },
    sparkCustomPool: { plan: fail },
  };
}

async function createExistingTargetPlan(
  manifestPath: string,
  tableAction: "create" | "no-op" = "create",
) {
  const loaded = loadManifest(manifestPath);
  const definition = loaded.lakehouseTablesDefinitions!.tables!;
  const offline = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  const online = await enrichPlanWithFabric(offline, loaded, {
    ...otherAdapters(),
    lakehouse: {
      plan: async () => ({
        action: "no-op" as const,
        reason: "exists",
        physicalId: "lakehouse-physical",
        observedStateHash: "lakehouse-state",
      }),
    },
    lakehouseTables: {
      plan: async () =>
        ({
          action: tableAction,
          reason:
            tableAction === "create"
              ? "missing table"
              : "table matches",
          physicalId: "lakehouse-physical",
          observedStateHash: "table-state",
          desiredHash: definition.desiredHash,
          tables: definition.tables.map((table) => ({
            logicalId: table.logicalId,
            identifier: `${table.table.schema}.${table.table.name}`,
            desiredHash: table.desiredHash,
            observedHash:
              tableAction === "create"
                ? "absent"
                : table.desiredHash,
            observation: {
              schemaExists: true,
              exists: tableAction === "no-op",
            },
            expectedOwnership: {
              ownerScheme: "v1" as const,
              ownerId: "a".repeat(64),
              desiredHash: table.desiredHash,
            },
            ownershipState:
              tableAction === "create" ? "unowned" : "owned",
            structureMatches: tableAction === "no-op",
            ownershipMatches: tableAction === "no-op",
            protocolCompatible: true,
            matches: tableAction === "no-op",
            differences:
              tableAction === "create" ? ["table is absent"] : [],
            action: tableAction,
            reason:
              tableAction === "create" ? "absent" : "matches",
          })),
        }) as any,
    },
  });
  return { loaded, online };
}

function addSecondTable(root: string): void {
  writeFileSync(
    path.join(root, "items/tables/definition/tables.yaml"),
    [
      "apiVersion: fabric.deploy/tables/v1alpha1",
      "kind: LakehouseTables",
      "defaultSchema: dbo",
      "adoptExisting: false",
      "tables:",
      "  - logicalId: helloWorld",
      "    file: tables/001-hello.sql",
      "  - logicalId: auditLog",
      "    file: tables/002-audit.sql",
      "    dependsOn:",
      "      - helloWorld",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(
      root,
      "items/tables/definition/tables/002-audit.sql",
    ),
    [
      "CREATE TABLE IF NOT EXISTS dbo.audit_log (",
      "  id BIGINT NOT NULL,",
      "  event STRING",
      ")",
      "USING DELTA;",
      "",
    ].join("\n"),
    "utf8",
  );
}

function addManagedSalesSchema(root: string): void {
  writeFileSync(
    path.join(root, "items/tables/definition/tables.yaml"),
    [
      "apiVersion: fabric.deploy/tables/v1alpha1",
      "kind: LakehouseTables",
      "adoptExisting: false",
      "schemas:",
      "  - logicalId: salesSchema",
      "    name: sales",
      "tables:",
      "  - logicalId: helloWorld",
      "    file: tables/001-hello.sql",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(
      root,
      "items/tables/definition/tables/001-hello.sql",
    ),
    [
      "CREATE TABLE IF NOT EXISTS sales.hello_world (",
      "  id BIGINT NOT NULL,",
      "  message STRING",
      ")",
      "USING DELTA;",
      "",
    ].join("\n"),
    "utf8",
  );
}

function addSchemaBundle(
  root: string,
  directoryName: string,
  targetLakehouseLogicalId: string,
  schemaLogicalId: string,
  schemaName: string,
): void {
  const directory = path.join(root, "items", directoryName);
  mkdirSync(path.join(directory, "definition"), {
    recursive: true,
  });
  writeFileSync(
    path.join(directory, "item.yaml"),
    [
      `displayName: ${directoryName}`,
      "desiredState: present",
      "references:",
      `  lakehouse: ${targetLakehouseLogicalId}`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(directory, "definition/tables.yaml"),
    [
      "apiVersion: fabric.deploy/tables/v1alpha1",
      "kind: LakehouseTables",
      "schemas:",
      `  - logicalId: ${schemaLogicalId}`,
      `    name: ${schemaName}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function addTableBundle(
  root: string,
  directoryName: string,
  targetLakehouseLogicalId: string,
  tableLogicalId: string,
): void {
  const directory = path.join(root, "items", directoryName);
  mkdirSync(path.join(directory, "definition/tables"), {
    recursive: true,
  });
  writeFileSync(
    path.join(directory, "item.yaml"),
    [
      `displayName: ${directoryName}`,
      "desiredState: present",
      "references:",
      `  lakehouse: ${targetLakehouseLogicalId}`,
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(directory, "definition/tables.yaml"),
    [
      "apiVersion: fabric.deploy/tables/v1alpha1",
      "kind: LakehouseTables",
      "defaultSchema: dbo",
      "adoptExisting: false",
      "tables:",
      `  - logicalId: ${tableLogicalId}`,
      "    file: tables/001-hello.sql",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(directory, "definition/tables/001-hello.sql"),
    [
      "CREATE TABLE IF NOT EXISTS dbo.hello_world (",
      "  id BIGINT NOT NULL,",
      "  message STRING",
      ")",
      "USING DELTA;",
      "",
    ].join("\n"),
    "utf8",
  );
}

function recoveryLakehouseAdapter() {
  return {
    plan: vi.fn(async () => ({
      action: "no-op" as const,
      reason: "exists",
      physicalId: "lakehouse-physical",
      observedStateHash: "lakehouse-state",
    })),
    create: vi.fn(),
    update: vi.fn(),
    resumeCreate: vi.fn(),
    verify: vi.fn(async () => ({
      id: "lakehouse-physical",
      displayName: "DdlLakehouse",
    })),
  };
}

function checkpointDdlState(
  online: Awaited<ReturnType<typeof createExistingTargetPlan>>["online"],
): NonNullable<ApplyCheckpoint["lakehouseTables"]>[string] {
  const item = online.items.find(
    (candidate) => candidate.logicalId === "tables",
  )!;
  return {
    logicalId: "tables",
    targetLakehouseLogicalId: "lakehouse",
    targetLakehouseId: "lakehouse-physical",
    desiredHash: item.lakehouseTables!.desiredHash,
    sourceHash: item.lakehouseTables!.sourceHash,
    attemptId: "ddl-recovery-attempt",
    sessionName: "ddl-recovery-session",
    sessionRequestHash: "c".repeat(64),
    sessionPhase: "submitting" as const,
    sessionSubmittedAt: "2026-01-01T00:00:00.000Z",
    completedOperationHashes: [],
    operationReceipts: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("LakehouseTables integration", () => {
  it("loads an immutable canonical snapshot and enforces the item contract", () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const definition = loaded.lakehouseTablesDefinitions?.tables;

    expect(definition?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(definition?.desiredHash).toMatch(/^[a-f0-9]{64}$/);
    expect(definition?.tables[0]?.table).toMatchObject({
      schema: "dbo",
      name: "hello_world",
      provider: "delta",
      managed: true,
    });

    writeFileSync(
      path.join(fixture.root, "items/tables/item.yaml"),
      [
        "displayName: Managed tables",
        "references:",
        "  lakehouse: lakehouse",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "must explicitly set desiredState",
    );
  });

  it("rejects duplicate canonical tables across bundles targeting the same Lakehouse", () => {
    const fixture = createFixture();
    addTableBundle(
      fixture.root,
      "tables-two",
      "lakehouse",
      "otherHello",
    );
    writeFileSync(
      fixture.manifestPath,
      `${readFileSync(fixture.manifestPath, "utf8")}
  - logicalId: tablesTwo
    type: LakehouseTables
    path: items/tables-two
    dependsOn:
      - lakehouse
`,
      "utf8",
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "bundles 'tables' table 'helloWorld' and 'tablesTwo' table 'otherHello'",
    );
  });

  it("rejects duplicate managed schemas across bundles targeting the same Lakehouse", () => {
    const fixture = createFixture();
    addManagedSalesSchema(fixture.root);
    addSchemaBundle(
      fixture.root,
      "schemas-two",
      "lakehouse",
      "otherSalesSchema",
      "sales",
    );
    writeFileSync(
      fixture.manifestPath,
      `${readFileSync(fixture.manifestPath, "utf8")}
  - logicalId: schemasTwo
    type: LakehouseTables
    path: items/schemas-two
    dependsOn:
      - lakehouse
`,
      "utf8",
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "bundles 'tables' schema 'salesSchema' and 'schemasTwo' schema 'otherSalesSchema'",
    );
  });

  it("permits the same canonical table identity on different Lakehouses", () => {
    const fixture = createFixture();
    const secondLakehouse = path.join(
      fixture.root,
      "items/lakehouse-two",
    );
    mkdirSync(secondLakehouse, { recursive: true });
    writeFileSync(
      path.join(secondLakehouse, "item.yaml"),
      [
        "displayName: SecondDdlLakehouse",
        "desiredState: present",
        "enableSchemas: true",
        "",
      ].join("\n"),
      "utf8",
    );
    addTableBundle(
      fixture.root,
      "tables-two",
      "lakehouseTwo",
      "otherHello",
    );
    writeFileSync(
      fixture.manifestPath,
      `${readFileSync(fixture.manifestPath, "utf8")}
  - logicalId: lakehouseTwo
    type: Lakehouse
    path: items/lakehouse-two
  - logicalId: tablesTwo
    type: LakehouseTables
    path: items/tables-two
    dependsOn:
      - lakehouseTwo
`,
      "utf8",
    );

    const loaded = loadManifest(fixture.manifestPath);
    expect(
      loaded.lakehouseTablesDefinitions?.tablesTwo?.tables[0]?.table,
    ).toMatchObject({
      schema: "dbo",
      name: "hello_world",
    });
  });

  it("rejects extra references, bindings, missing dependencies, and wrong target types", () => {
    const extraReference = createFixture();
    writeFileSync(
      path.join(extraReference.root, "items/tables/item.yaml"),
      [
        "displayName: Managed tables",
        "desiredState: present",
        "references:",
        "  lakehouse: lakehouse",
        "  extra: lakehouse",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadManifest(extraReference.manifestPath)).toThrow(
      "must declare exactly one references.lakehouse",
    );

    const binding = createFixture();
    writeFileSync(
      path.join(binding.root, "items/tables/item.yaml"),
      [
        "displayName: Managed tables",
        "desiredState: present",
        "references:",
        "  lakehouse: lakehouse",
        "bindings:",
        "  - target: /unsupported",
        "    valueFrom: items.lakehouse.id",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadManifest(binding.manifestPath)).toThrow(
      "does not support bindings",
    );

    const dependency = createFixture();
    writeFileSync(
      dependency.manifestPath,
      readFileSync(dependency.manifestPath, "utf8").replace(
        "    dependsOn:\n      - lakehouse\n",
        "",
      ),
      "utf8",
    );
    expect(() => loadManifest(dependency.manifestPath)).toThrow(
      "dependsOn does not include it",
    );

    const wrongType = createFixture();
    writeFileSync(
      wrongType.manifestPath,
      readFileSync(wrongType.manifestPath, "utf8").replace(
        "    type: Lakehouse\n",
        "    type: Notebook\n",
      ),
      "utf8",
    );
    writeFileSync(
      path.join(wrongType.root, "items/lakehouse/item.yaml"),
      "displayName: Not a Lakehouse\ndesiredState: present\n",
      "utf8",
    );
    mkdirSync(
      path.join(wrongType.root, "items/lakehouse/definition"),
      { recursive: true },
    );
    writeFileSync(
      path.join(
        wrongType.root,
        "items/lakehouse/definition/notebook-content.py",
      ),
      "print('hello')\n",
      "utf8",
    );
    expect(() => loadManifest(wrongType.manifestPath)).toThrow(
      "requires type 'Lakehouse'",
    );
  });

  it("plans deterministic symbolic creates for a same-plan Lakehouse", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const ddlPlan = vi.fn();
    const online = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: ddlPlan },
    });

    const tables = online.items.find(
      (item) => item.logicalId === "tables",
    );
    expect(tables).toMatchObject({
      action: "create",
      lakehouseTables: {
        targetLakehouseLogicalId: "lakehouse",
        targetBinding: "symbolic",
        operations: [
          {
            action: "create",
            logicalId: "helloWorld",
            identifier: "dbo.hello_world",
          },
        ],
      },
    });
    expect(ddlPlan).not.toHaveBeenCalled();
  });

  it("plans managed schemas before tables for a same-plan schema-enabled Lakehouse", async () => {
    const fixture = createFixture();
    addManagedSalesSchema(fixture.root);
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const online = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });

    expect(
      online.items.find((item) => item.logicalId === "tables")
        ?.lakehouseTables?.operations,
    ).toMatchObject([
      {
        resourceKind: "schema",
        logicalId: "salesSchema",
        identifier: "sales",
        action: "create",
        order: 0,
      },
      {
        resourceKind: "table",
        logicalId: "helloWorld",
        identifier: "sales.hello_world",
        action: "create",
        order: 1,
      },
    ]);

    writeFileSync(
      path.join(fixture.root, "items/lakehouse/item.yaml"),
      "displayName: DdlLakehouse\ndesiredState: present\n",
      "utf8",
    );
    const disabled = loadManifest(fixture.manifestPath);
    const disabledOffline = buildPlan(disabled, {
      mode: "plan",
      environment: "dev",
    });
    const blocked = await enrichPlanWithFabric(
      disabledOffline,
      disabled,
      {
        ...otherAdapters(),
        lakehouse: {
          plan: async () => ({
            action: "create" as const,
            reason: "missing",
            observedStateHash: "absent",
          }),
        },
        lakehouseTables: { plan: vi.fn() },
      },
    );
    expect(
      blocked.items.find((item) => item.logicalId === "tables"),
    ).toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("enableSchemas: true"),
    });
  });

  it("binds every table operation into the approved artifact and validates nested structure", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const online = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const planPath = path.join(fixture.root, "approved-plan.json");
    const tampered = JSON.parse(JSON.stringify(online));
    tampered.items[1].lakehouseTables.operations[0].reason =
      "tampered after approval";
    writeFileSync(planPath, JSON.stringify(tampered), "utf8");
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "Approved plan hash is invalid",
    );

    tampered.items[1].lakehouseTables.operations[0].order = 7;
    const malformed = rehashPlan(tampered);
    writeFileSync(planPath, JSON.stringify(malformed), "utf8");
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    tampered.items[1].lakehouseTables.operations[0].order = 0;
    tampered.items[1].lakehouseTables.operations[0].resourceKind =
      "database";
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(tampered)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("rejects LakehouseTables checkpoint hashes that do not match the approved plan", async () => {
    const fixture = createFixture();
    const { online } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const checkpoint = createCheckpoint(online);
    checkpoint.lakehouseTables = {
      tables: {
        ...checkpointDdlState(online),
        sourceHash: "f".repeat(64),
      },
    };
    const checkpointPath = path.join(fixture.root, "checkpoint.json");
    writeCheckpoint(checkpointPath, checkpoint);

    expect(() => loadCheckpoint(checkpointPath, online)).toThrow(
      "does not match the approved deployment plan",
    );
  });

  it("rejects completed LakehouseTables IDs outside the approved target binding", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const symbolic = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const symbolicCheckpoint = createCheckpoint(symbolic);
    symbolicCheckpoint.completedItems.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    symbolicCheckpoint.completedItems.tables = {
      logicalId: "tables",
      action: "create",
      physicalId: "tampered-lakehouse",
      completedAt: "2026-01-01T00:00:01.000Z",
    };
    const symbolicPath = path.join(
      fixture.root,
      "symbolic-checkpoint.json",
    );
    writeCheckpoint(symbolicPath, symbolicCheckpoint);
    expect(() => loadCheckpoint(symbolicPath, symbolic)).toThrow(
      "exact completed target dependency",
    );

    const { online: physical } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const physicalCheckpoint = createCheckpoint(physical);
    physicalCheckpoint.completedItems.tables = {
      logicalId: "tables",
      action: "create",
      physicalId: "tampered-lakehouse",
      completedAt: "2026-01-01T00:00:01.000Z",
    };
    const physicalPath = path.join(
      fixture.root,
      "physical-checkpoint.json",
    );
    writeCheckpoint(physicalPath, physicalCheckpoint);
    expect(() => loadCheckpoint(physicalPath, physical)).toThrow(
      "approved target",
    );
  });

  it("plans existing targets through Livy and preserves per-table approval details", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const definition = loaded.lakehouseTablesDefinitions!.tables!;
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const ddlPlan = vi.fn(async () => ({
      action: "create" as const,
      reason: "one create",
      physicalId: "lakehouse-physical",
      observedStateHash: "observed-tables",
      desiredHash: definition.desiredHash,
      tables: definition.tables.map((table) => ({
        logicalId: table.logicalId,
        identifier: `${table.table.schema}.${table.table.name}`,
        desiredHash: table.desiredHash,
        observedHash: "absent",
        observation: { schemaExists: true, exists: false },
        expectedOwnership: {
          ownerScheme: "v1" as const,
          ownerId: "a".repeat(64),
          desiredHash: table.desiredHash,
        },
        ownershipState: "unowned" as const,
        structureMatches: false,
        ownershipMatches: false,
        protocolCompatible: true,
        matches: false,
        differences: ["table is absent"],
        action: "create" as const,
        reason: "absent",
      })),
    }));
    const online = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "no-op" as const,
          reason: "exists",
          physicalId: "lakehouse-physical",
          observedStateHash: "lakehouse-state",
        }),
      },
      lakehouseTables: { plan: ddlPlan },
    });

    expect(ddlPlan).toHaveBeenCalledOnce();
    expect(
      online.items.find((item) => item.logicalId === "tables")
        ?.lakehouseTables,
    ).toMatchObject({
      targetBinding: "physical",
      targetLakehousePhysicalId: "lakehouse-physical",
      desiredHash: definition.desiredHash,
      sourceHash: definition.sourceHash,
      operations: [
        {
          action: "create",
          logicalId: "helloWorld",
          identifier: "dbo.hello_world",
        },
      ],
    });
  });

  it("requires independent authorization and materializes the same-apply Lakehouse ID", async () => {
    const fixture = createFixture();
    addManagedSalesSchema(fixture.root);
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const online = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: {
        plan: async () => {
          throw new Error("Symbolic planning must not call Livy.");
        },
      },
    });
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-apply-"));
    const lakehouseAdapter = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      })),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: unknown,
          onMutationAccepted?: (id: string) => void,
        ) => {
          onMutationAccepted?.("created-lakehouse-id");
          return {
            id: "created-lakehouse-id",
            displayName: "DdlLakehouse",
          };
        },
      ),
      update: vi.fn(),
      verify: vi.fn(),
      resumeCreate: vi.fn(),
    };
    const ddlApply = vi.fn(
      async (
        _workspace: string,
        lakehouseId: string,
        definition: NonNullable<
          typeof loaded.lakehouseTablesDefinitions
        >[string],
        _execution: unknown,
        hooks: Record<string, (value: any) => Promise<void> | void>,
      ) => {
        const submittedAt = "2026-01-01T00:00:00.000Z";
        const session = {
          workspaceId: "workspace-1",
          lakehouseId,
          sessionName: "session-name",
          sessionsPath: "/sessions",
          attemptId: "attempt",
          requestHash: "c".repeat(64),
          submittedAt,
          sessionId: "11111111-1111-4111-8111-111111111111",
        };
        await hooks.onSessionSubmitting?.(session);
        await hooks.onSessionAccepted?.(session);
        await hooks.onSessionCreated?.(session);
        await hooks.onSessionCleanupSubmitting?.(session);
        await hooks.onSessionCleanupComplete?.(session);
        return {
          physicalId: lakehouseId,
          desiredHash: definition.desiredHash,
          observedStateHash: "verified-state",
          operations: [],
          tables: [],
        };
      },
    );
    const ddlAdapter = {
      apply: ddlApply,
      verify: vi.fn(),
      plan: vi.fn(),
      discoverSessionAttempt: vi.fn(),
      discoverStatementByMarker: vi.fn(),
      resumeAcceptedStatement: vi.fn(),
      deleteSessionById: vi.fn(),
    };
    const common = {
      approvedPlan: online,
      currentPlan: online,
      loadedManifest: loaded,
      lakehouseAdapter,
      lakehouseTablesAdapter: ddlAdapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile: path.join(root, "checkpoint.json"),
      resultFile: path.join(root, "result.json"),
    };

    await expect(
      applyApprovedPlan({
        ...common,
        allowLakehouseSchemaCreate: false,
        allowLakehouseTableCreate: true,
      }),
    ).rejects.toThrow("allow-lakehouse-schema-create is false");
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();

    await expect(
      applyApprovedPlan({
        ...common,
        checkpointFile: path.join(root, "checkpoint-table-blocked.json"),
        resultFile: path.join(root, "result-table-blocked.json"),
        allowLakehouseSchemaCreate: true,
        allowLakehouseTableCreate: false,
      }),
    ).rejects.toThrow("allow-lakehouse-table-create is false");
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();

    const result = await applyApprovedPlan({
      ...common,
      checkpointFile: path.join(root, "checkpoint-allowed.json"),
      resultFile: path.join(root, "result-allowed.json"),
      allowLakehouseSchemaCreate: true,
      allowLakehouseTableCreate: true,
    });
    expect(ddlApply).toHaveBeenCalledWith(
      "workspace-1",
      "created-lakehouse-id",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
    expect(
      result.items.find((item) => item.logicalId === "tables"),
    ).toMatchObject({
      status: "created",
      physicalId: "created-lakehouse-id",
      lakehouseTables: {
        desiredHash:
          loaded.lakehouseTablesDefinitions!.tables!.desiredHash,
        observedStateHash: "verified-state",
      },
    });
    const checkpoint = JSON.parse(
      readFileSync(
        path.join(root, "checkpoint-allowed.json"),
        "utf8",
      ),
    );
    expect(checkpoint.lakehouseTables.tables).toMatchObject({
      targetLakehouseId: "created-lakehouse-id",
      sessionPhase: "cleanup-complete",
    });
    expect(JSON.stringify(checkpoint)).not.toContain("stdout");
  });

  it("fails closed without resubmitting an ambiguous lost session POST", async () => {
    const fixture = createFixture();
    const { loaded, online } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(online);
    checkpoint.lakehouseTables = {
      tables: checkpointDdlState(online),
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const ddlApply = vi.fn();
    const ddlAdapter = {
      apply: ddlApply,
      verify: vi.fn(),
      plan: vi.fn(),
      discoverSessionAttempt: vi.fn(async () => ({
        outcome: "none" as const,
        sessionName: "ddl-recovery-session",
      })),
      discoverStatementByMarker: vi.fn(),
      resumeAcceptedStatement: vi.fn(),
      deleteSessionById: vi.fn(),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: online,
        currentPlan: online,
        loadedManifest: loaded,
        lakehouseAdapter: recoveryLakehouseAdapter(),
        lakehouseTablesAdapter: ddlAdapter,
        allowCreate: false,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow("Do not resubmit automatically");
    expect(ddlApply).not.toHaveBeenCalled();
  });

  it("recovers a symbolic approved target after replanning it as the completed physical Lakehouse", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.completedItems.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    checkpoint.lakehouseTables = {
      tables: checkpointDdlState(approved),
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const ddlApply = vi.fn();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: recoveryLakehouseAdapter(),
        lakehouseTablesAdapter: {
          apply: ddlApply,
          verify: vi.fn(),
          plan: vi.fn(),
          discoverSessionAttempt: vi.fn(async () => ({
            outcome: "none" as const,
            sessionName: "ddl-recovery-session",
          })),
          discoverStatementByMarker: vi.fn(),
          resumeAcceptedStatement: vi.fn(),
          deleteSessionById: vi.fn(),
        },
        allowCreate: true,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow("Unresolved LakehouseTables session POST");
    expect(ddlApply).not.toHaveBeenCalled();
  });

  it("materializes a symbolic target after the Lakehouse checkpoint but before a bundle checkpoint", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.completedItems.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const ddlApply = vi.fn(async () => {
      throw new Error("bundle apply reached");
    });

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: recoveryLakehouseAdapter(),
        lakehouseTablesAdapter: {
          apply: ddlApply,
          verify: vi.fn(),
          plan: vi.fn(),
          discoverSessionAttempt: vi.fn(),
          discoverStatementByMarker: vi.fn(),
          resumeAcceptedStatement: vi.fn(),
          deleteSessionById: vi.fn(),
        },
        allowCreate: true,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow("bundle apply reached");
    expect(ddlApply).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("recovers a pending synchronous Lakehouse create before checking its symbolic table bundle", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingCreates.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      submittedAt: "2026-01-01T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const lakehouseAdapter = recoveryLakehouseAdapter();
    const ddlApply = vi.fn(async () => {
      throw new Error("bundle apply reached after create recovery");
    });

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter,
        lakehouseTablesAdapter: {
          apply: ddlApply,
          verify: vi.fn(),
          plan: vi.fn(),
          discoverSessionAttempt: vi.fn(),
          discoverStatementByMarker: vi.fn(),
          resumeAcceptedStatement: vi.fn(),
          deleteSessionById: vi.fn(),
        },
        allowCreate: true,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow("bundle apply reached after create recovery");

    const recovered = loadCheckpoint(checkpointFile, approved)!;
    expect(recovered.pendingCreates.lakehouse).toBeUndefined();
    expect(recovered.completedItems.lakehouse).toMatchObject({
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
    });
    expect(lakehouseAdapter.plan).toHaveBeenCalled();
    expect(lakehouseAdapter.verify).toHaveBeenCalled();
    expect(ddlApply).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("resumes a pending Lakehouse LRO before checking its symbolic table bundle", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingOperations.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      operationId: "operation-1",
      location: "/operations/operation-1",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const lakehouseAdapter = recoveryLakehouseAdapter();
    lakehouseAdapter.resumeCreate = vi.fn(
      async (
        _workspace: string,
        _desired: unknown,
        operation: { operationId?: string; location?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        expect(operation).toEqual({
          operationId: "operation-1",
          location: "/operations/operation-1",
        });
        onMutationAccepted?.("lakehouse-physical");
        return {
          id: "lakehouse-physical",
          displayName: "DdlLakehouse",
        };
      },
    );
    const ddlApply = vi.fn(async () => {
      throw new Error("bundle apply reached after LRO recovery");
    });

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter,
        lakehouseTablesAdapter: {
          apply: ddlApply,
          verify: vi.fn(),
          plan: vi.fn(),
          discoverSessionAttempt: vi.fn(),
          discoverStatementByMarker: vi.fn(),
          resumeAcceptedStatement: vi.fn(),
          deleteSessionById: vi.fn(),
        },
        allowCreate: true,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow("bundle apply reached after LRO recovery");

    const recovered = loadCheckpoint(checkpointFile, approved)!;
    expect(recovered.pendingOperations.lakehouse).toBeUndefined();
    expect(recovered.completedItems.lakehouse).toMatchObject({
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
    });
    expect(lakehouseAdapter.resumeCreate).toHaveBeenCalledOnce();
    expect(ddlApply).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects a recovered pending target whose physical ID differs from the current binding", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingCreates.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      submittedAt: "2026-01-01T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const ddlApply = vi.fn();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(async () => ({
            action: "no-op" as const,
            reason: "exists",
            physicalId: "different-lakehouse",
            observedStateHash: "different-state",
          })),
          create: vi.fn(),
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(async () => ({
            id: "different-lakehouse",
            displayName: "DdlLakehouse",
          })),
        },
        lakehouseTablesAdapter: {
          apply: ddlApply,
          verify: vi.fn(),
          plan: vi.fn(),
          discoverSessionAttempt: vi.fn(),
          discoverStatementByMarker: vi.fn(),
          resumeAcceptedStatement: vi.fn(),
          deleteSessionById: vi.fn(),
        },
        allowCreate: true,
        allowUpdate: false,
        allowLakehouseTableCreate: true,
        checkpointFile,
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow(
      "did not materialize to the exact checkpointed Lakehouse ID",
    );
    expect(ddlApply).not.toHaveBeenCalled();
  });

  it("rejects mismatched pending target checkpoints instead of deferring symbolic binding", async () => {
    const fixture = createFixture();
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });

    const createCheckpointState = createCheckpoint(approved);
    createCheckpointState.pendingCreates.lakehouse = {
      logicalId: "tables",
      action: "create",
      submittedAt: "2026-01-01T00:00:00.000Z",
    };
    const createPath = path.join(
      fixture.root,
      "tampered-create-checkpoint.json",
    );
    writeCheckpoint(createPath, createCheckpointState);
    expect(() => loadCheckpoint(createPath, approved)).toThrow(
      "invalid structure",
    );

    const operationCheckpointState = createCheckpoint(approved);
    operationCheckpointState.pendingOperations.lakehouse = {
      logicalId: "tables",
      action: "create",
      operationId: "operation-1",
      acceptedAt: "2026-01-01T00:00:00.000Z",
    };
    const operationPath = path.join(
      fixture.root,
      "tampered-operation-checkpoint.json",
    );
    writeCheckpoint(operationPath, operationCheckpointState);
    expect(() => loadCheckpoint(operationPath, approved)).toThrow(
      "invalid structure",
    );
  });

  it("resumes a completed multi-table bundle when live creates become no-ops", async () => {
    const fixture = createFixture();
    addSecondTable(fixture.root);
    const loaded = loadManifest(fixture.manifestPath);
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    const approved = await enrichPlanWithFabric(offline, loaded, {
      ...otherAdapters(),
      lakehouse: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
        }),
      },
      lakehouseTables: { plan: vi.fn() },
    });
    const { online: current } = await createExistingTargetPlan(
      fixture.manifestPath,
      "no-op",
    );
    expect(
      approved.items.find((item) => item.logicalId === "tables")
        ?.lakehouseTables?.operations,
    ).toHaveLength(2);
    expect(
      current.items
        .find((item) => item.logicalId === "tables")
        ?.lakehouseTables?.operations.map(
          (operation) => operation.action,
        ),
    ).toEqual(["no-op", "no-op"]);

    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(approved);
    checkpoint.completedItems.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      physicalId: "lakehouse-physical",
      completedAt: "2026-01-01T00:00:00.000Z",
    };
    checkpoint.completedItems.tables = {
      logicalId: "tables",
      action: "create",
      physicalId: "lakehouse-physical",
      completedAt: "2026-01-01T00:00:01.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const verify = vi.fn(async () => ({
      matches: true,
      observedStateHash: "verified-resume",
      tables: [],
    }));
    const ddlApply = vi.fn();

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: recoveryLakehouseAdapter(),
      lakehouseTablesAdapter: {
        apply: ddlApply,
        verify,
        plan: vi.fn(),
        discoverSessionAttempt: vi.fn(),
        discoverStatementByMarker: vi.fn(),
        resumeAcceptedStatement: vi.fn(),
        deleteSessionById: vi.fn(),
      },
      allowCreate: true,
      allowUpdate: false,
      allowLakehouseTableCreate: true,
      checkpointFile,
      resultFile: path.join(root, "result.json"),
    });

    expect(verify).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      expect.any(Object),
      expect.any(Object),
    );
    expect(ddlApply).not.toHaveBeenCalled();
    expect(
      result.items.find((item) => item.logicalId === "tables"),
    ).toMatchObject({
      status: "resumed",
      physicalId: "lakehouse-physical",
    });
  });

  it("adopts exactly one available candidate for a lost statement POST", async () => {
    const fixture = createFixture();
    const { loaded, online } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(online);
    const state = checkpointDdlState(online);
    state.sessionId = "11111111-1111-4111-8111-111111111111";
    state.sessionPhase = "accepted";
    state.statement = {
      statementAttemptName: "statement-attempt",
      purpose: "create",
      tableLogicalId: "helloWorld",
      operationHash:
        online.items.find((item) => item.logicalId === "tables")!
          .lakehouseTables!.operations[0]!.operationHash,
      codeHash: "d".repeat(64),
      phase: "submitting",
      submittedAt: "2026-01-01T00:00:01.000Z",
    };
    checkpoint.lakehouseTables = { tables: state };
    writeCheckpoint(checkpointFile, checkpoint);
    const resume = vi.fn(async () => ({ statementId: 7 }));
    const cleanup = vi.fn(async () => undefined);
    const ddlApply = vi.fn(
      async (
        _workspace: string,
        lakehouseId: string,
        definition: NonNullable<
          typeof loaded.lakehouseTablesDefinitions
        >[string],
        _execution: unknown,
        hooks: Record<string, (value: any) => Promise<void> | void>,
      ) => {
        const session = {
          workspaceId: "workspace-1",
          lakehouseId,
          sessionName: "continued-session",
          sessionsPath: "/sessions",
          attemptId: "continued-attempt",
          requestHash: "e".repeat(64),
          submittedAt: "2026-01-01T00:01:00.000Z",
          sessionId: "22222222-2222-4222-8222-222222222222",
        };
        await hooks.onSessionSubmitting?.(session);
        await hooks.onSessionAccepted?.(session);
        await hooks.onSessionCreated?.(session);
        await hooks.onSessionCleanupSubmitting?.(session);
        await hooks.onSessionCleanupComplete?.(session);
        return {
          physicalId: lakehouseId,
          desiredHash: definition.desiredHash,
          observedStateHash: "verified-after-available-recovery",
          operations: [],
          tables: [],
        };
      },
    );

    await applyApprovedPlan({
      approvedPlan: online,
      currentPlan: online,
      loadedManifest: loaded,
      lakehouseAdapter: recoveryLakehouseAdapter(),
      lakehouseTablesAdapter: {
        apply: ddlApply,
        verify: vi.fn(),
        plan: vi.fn(),
        discoverSessionAttempt: vi.fn(),
        discoverStatementByMarker: vi.fn(async () => ({
          outcome: "single" as const,
          statementId: 7,
          state: "available",
        })),
        resumeAcceptedStatement: resume,
        deleteSessionById: cleanup,
      },
      allowCreate: false,
      allowUpdate: false,
      allowLakehouseTableCreate: true,
      checkpointFile,
      resultFile: path.join(root, "result.json"),
    });
    expect(resume).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      "11111111-1111-4111-8111-111111111111",
      7,
      expect.objectContaining({
        logicalId: "helloWorld",
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(ddlApply).toHaveBeenCalledOnce();
  });

  it("resumes an accepted statement, cleans up, verifies, and then continues safely", async () => {
    const fixture = createFixture();
    const { loaded, online } = await createExistingTargetPlan(
      fixture.manifestPath,
    );
    const root = mkdtempSync(path.join(tmpdir(), "fabric-ddl-recovery-"));
    const checkpointFile = path.join(root, "checkpoint.json");
    const checkpoint = createCheckpoint(online);
    const state = checkpointDdlState(online);
    const approvedOperation =
      online.items.find((item) => item.logicalId === "tables")!
        .lakehouseTables!.operations[0]!;
    state.sessionId = "11111111-1111-4111-8111-111111111111";
    state.sessionPhase = "accepted";
    state.sessionAcceptedAt = "2026-01-01T00:00:01.000Z";
    state.statement = {
      statementAttemptName: "statement-attempt",
      purpose: "create",
      tableLogicalId: "helloWorld",
      operationHash: approvedOperation.operationHash,
      codeHash: "d".repeat(64),
      phase: "accepted",
      statementId: 7,
      submittedAt: "2026-01-01T00:00:02.000Z",
      acceptedAt: "2026-01-01T00:00:03.000Z",
    };
    checkpoint.lakehouseTables = { tables: state };
    writeCheckpoint(checkpointFile, checkpoint);
    const resume = vi.fn(async () => ({ statementId: 7 }));
    const cleanup = vi.fn(async () => undefined);
    const apply = vi.fn(
      async (
        _workspace: string,
        lakehouseId: string,
        definition: NonNullable<
          typeof loaded.lakehouseTablesDefinitions
        >[string],
        _execution: unknown,
        hooks: Record<string, (value: any) => Promise<void> | void>,
      ) => {
        const session = {
          workspaceId: "workspace-1",
          lakehouseId,
          sessionName: "new-session",
          sessionsPath: "/sessions",
          attemptId: "new-attempt",
          requestHash: "e".repeat(64),
          submittedAt: "2026-01-01T00:01:00.000Z",
          sessionId: "22222222-2222-4222-8222-222222222222",
        };
        await hooks.onSessionSubmitting?.(session);
        await hooks.onSessionAccepted?.(session);
        await hooks.onSessionCreated?.(session);
        await hooks.onSessionCleanupSubmitting?.(session);
        await hooks.onSessionCleanupComplete?.(session);
        return {
          physicalId: lakehouseId,
          desiredHash: definition.desiredHash,
          observedStateHash: "verified-after-recovery",
          operations: [],
          tables: [],
        };
      },
    );
    const result = await applyApprovedPlan({
      approvedPlan: online,
      currentPlan: online,
      loadedManifest: loaded,
      lakehouseAdapter: recoveryLakehouseAdapter(),
      lakehouseTablesAdapter: {
        apply,
        verify: vi.fn(),
        plan: vi.fn(),
        discoverSessionAttempt: vi.fn(),
        discoverStatementByMarker: vi.fn(),
        resumeAcceptedStatement: resume,
        deleteSessionById: cleanup,
      },
      allowCreate: false,
      allowUpdate: false,
      allowLakehouseTableCreate: true,
      checkpointFile,
      resultFile: path.join(root, "result.json"),
    });

    expect(resume).toHaveBeenCalledWith(
      "workspace-1",
      "lakehouse-physical",
      "11111111-1111-4111-8111-111111111111",
      7,
      expect.objectContaining({
        operationHash: approvedOperation.operationHash,
      }),
    );
    expect(cleanup).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(
      result.items.find((item) => item.logicalId === "tables"),
    ).toMatchObject({
      status: "created",
      physicalId: "lakehouse-physical",
    });
  });
});
