import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  hashCanonicalLakehouseTable,
  parseLakehouseTableSql,
  type LoadedLakehouseTablesDefinition,
} from "../src/fabric/lakehouse-tables-definition";
import {
  buildLakehouseTableCreateOperations,
  createLakehouseTablesSessionName,
  FABRIC_TABLE_DESIRED_HASH_PROPERTY,
  FABRIC_TABLE_OWNER_ID_PROPERTY,
  FABRIC_TABLE_OWNER_SCHEME_PROPERTY,
  FABRIC_TABLE_OPERATION_HASH_PROPERTY,
  FABRIC_TABLE_OWNER_SCHEME_V1,
  FABRIC_TABLE_SOURCE_HASH_PROPERTY,
  generateCreateTableSql,
  LakehouseTableAdoptionRequiredError,
  LakehouseTablesAdapter,
  PHASE3_DELTA_PROTOCOL_POLICY,
  quoteSparkIdentifier,
  quoteSparkStringLiteral,
  type LakehouseTableObservation,
  type LakehouseTableOwnershipEvidence,
  type LakehouseTablesExecutionContext,
} from "../src/fabric/lakehouse-tables";

const tokenProvider = {
  getToken: async () => "token",
};

const EXECUTION: LakehouseTablesExecutionContext = {
  sourceHash: "b".repeat(64),
  attemptId: "attempt-1",
  deploymentId: "deployment",
  bundleLogicalId: "tables",
  targetLakehouseLogicalId: "lakehouse",
};
const SESSION_UUID = "11111111-1111-4111-8111-111111111111";
const SESSION_PATH_PATTERN =
  /\/sessions\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sessionUuid(index: number): string {
  return `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`;
}

function definition(
  entries: Array<{ logicalId: string; sql: string }>,
  adoptExisting = false,
): LoadedLakehouseTablesDefinition {
  const tables = entries.map((entry, index) => {
    const table = parseLakehouseTableSql(entry.sql);
    return {
      logicalId: entry.logicalId,
      file: `tables/${String(index + 1).padStart(3, "0")}-${entry.logicalId}.sql`,
      dependsOn: index === 0 ? [] : [entries[index - 1]!.logicalId],
      sql: entry.sql,
      table,
      desiredHash: hashCanonicalLakehouseTable(table),
    };
  });
  return {
    apiVersion: "fabric.deploy/tables/v1alpha1",
    kind: "LakehouseTables",
    adoptExisting,
    tables,
    sourceHash: "b".repeat(64),
    desiredHash: "a".repeat(64),
  };
}

function observation(
  table: ReturnType<typeof parseLakehouseTableSql>,
  options: {
    ownership?: LakehouseTableOwnershipEvidence;
    overrides?: Partial<LakehouseTableObservation>;
  } = {},
): LakehouseTableObservation {
  const sparkTypes: Record<string, string> = {
    boolean: "boolean",
    tinyint: "byte",
    smallint: "short",
    int: "integer",
    bigint: "long",
    float: "float",
    double: "double",
    string: "string",
    binary: "binary",
    date: "date",
    timestamp: "timestamp",
  };
  const ownershipProperties: Record<string, string> = {};
  if (options.ownership) {
    ownershipProperties[FABRIC_TABLE_OWNER_SCHEME_PROPERTY] =
      options.ownership.ownerScheme;
    ownershipProperties[FABRIC_TABLE_OWNER_ID_PROPERTY] =
      options.ownership.ownerId;
    ownershipProperties[FABRIC_TABLE_DESIRED_HASH_PROPERTY] =
      options.ownership.desiredHash;
  }
  return {
    schemaExists: true,
    exists: true,
    provider: "delta",
    tableType: "MANAGED",
    managed: true,
    columns: table.columns.map((column) => ({
      name: column.name,
      dataType: sparkTypes[column.dataType] ?? column.dataType,
      nullable: column.nullable,
      ...(column.comment === undefined
        ? {}
        : { comment: column.comment }),
    })),
    partitionColumns: table.partitionColumns,
    ...(table.comment === undefined ? {} : { comment: table.comment }),
    properties: {
      ...table.properties,
      ...ownershipProperties,
    },
    minReaderVersion: 1,
    minWriterVersion: 2,
    tableFeatures: [...PHASE3_DELTA_PROTOCOL_POLICY.allowedTableFeatures],
    ...(options.overrides ?? {}),
  };
}

function absentObservation(schemaExists = true): LakehouseTableObservation {
  return { schemaExists, exists: false };
}

function statementAvailable(
  value: LakehouseTableObservation,
  extraOutput = "",
) {
  return {
    state: "available",
    output: {
      status: "ok",
      data: {
        "text/plain": `${extraOutput}FABRIC_DEPLOY_TABLE_RESULT:${JSON.stringify(
          value,
        )}\n`,
      },
    },
  };
}

function createAdapter(
  fetchImpl: FetchLike,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): LakehouseTablesAdapter {
  return new LakehouseTablesAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: options.sleep,
      now: options.now,
      requestTimeoutMs: 1_000,
    }),
    {
      sessionPollIntervalMs: 1,
      statementPollIntervalMs: 1,
      sessionTimeoutMs: 100,
      statementTimeoutMs: 100,
      sleep: options.sleep,
      now: options.now,
    },
  );
}

function singleObservationAdapter(
  desired: LoadedLakehouseTablesDefinition,
  observed: LakehouseTableObservation,
): LakehouseTablesAdapter {
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/sessions")) {
        return new Response(JSON.stringify({ id: SESSION_UUID }), {
          status: 202,
        });
      }
      if (method === "GET" && url.endsWith(`/sessions/${SESSION_UUID}`)) {
        return new Response(JSON.stringify({ state: "idle" }), {
          status: 200,
        });
      }
      if (method === "POST" && url.endsWith("/statements")) {
        return new Response(JSON.stringify({ id: 0, state: "waiting" }), {
          status: 200,
        });
      }
      if (method === "GET" && url.endsWith("/statements/0")) {
        return new Response(
          JSON.stringify(statementAvailable(observed)),
          { status: 200 },
        );
      }
      if (method === "DELETE") {
        return new Response(undefined, { status: 200 });
      }
      return new Response(
        JSON.stringify({
          errorCode: "UnexpectedRequest",
          message: `${method} ${url}`,
        }),
        { status: 400 },
      );
    },
  );
  void desired;
  return createAdapter(fetchImpl);
}

function orderedObservationAdapter(
  observed: LakehouseTableObservation[],
): LakehouseTablesAdapter {
  let nextStatementId = 0;
  const fetchImpl = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/sessions")) {
        return new Response(JSON.stringify({ id: SESSION_UUID }), {
          status: 202,
        });
      }
      if (
        method === "GET" &&
        url.endsWith(`/sessions/${SESSION_UUID}`)
      ) {
        return new Response(JSON.stringify({ state: "idle" }), {
          status: 200,
        });
      }
      if (method === "POST" && url.endsWith("/statements")) {
        const id = nextStatementId++;
        return new Response(JSON.stringify({ id, state: "waiting" }), {
          status: 200,
        });
      }
      const statementMatch = url.match(/\/statements\/(\d+)$/);
      if (method === "GET" && statementMatch) {
        const id = Number(statementMatch[1]);
        const value = observed[id];
        if (!value) {
          return new Response("missing observation", { status: 404 });
        }
        return new Response(
          JSON.stringify(statementAvailable(value)),
          { status: 200 },
        );
      }
      if (method === "DELETE") {
        return new Response(undefined, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    },
  );
  return createAdapter(fetchImpl);
}

describe("LakehouseTables Livy adapter", () => {
  it("uses deterministic attempts, lifecycle hooks, owned CREATE DDL, polling, and sanitized results", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: `
          CREATE TABLE IF NOT EXISTS sales.orders (
            order_id BIGINT NOT NULL,
            order_date DATE
          )
          USING DELTA
          PARTITIONED BY (order_date)
        `,
      },
      {
        logicalId: "orderLines",
        sql: `
          CREATE TABLE IF NOT EXISTS sales.order_lines (
            line_id INT,
            order_id BIGINT
          )
          USING DELTA
        `,
      },
    ]);
    const operations = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    );
    const requests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    const acceptedStatementCodes = new Map<number, string>();
    const statementPollCounts = new Map<number, number>();
    let nextStatementId = 0;
    let sessionPolls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        requests.push({ method, url, ...(body ? { body } : {}) });
        if (method === "POST" && url.endsWith("/sessions")) {
          return new Response(
            JSON.stringify({ id: SESSION_UUID, state: "starting" }),
            { status: 202 },
          );
        }
        if (method === "GET" && url.endsWith(`/sessions/${SESSION_UUID}`)) {
          sessionPolls += 1;
          return new Response(
            JSON.stringify({
              state: sessionPolls === 1 ? "starting" : "idle",
            }),
            { status: 200 },
          );
        }
        if (method === "POST" && url.endsWith("/statements")) {
          const id = nextStatementId++;
          acceptedStatementCodes.set(id, String(body?.code ?? ""));
          return new Response(
            JSON.stringify({ id, state: "waiting" }),
            { status: 200 },
          );
        }
        if (method === "GET" && /\/statements\/\d+$/.test(url)) {
          const id = Number(url.split("/").at(-1));
          const count = (statementPollCounts.get(id) ?? 0) + 1;
          statementPollCounts.set(id, count);
          if (count === 1) {
            return new Response(
              JSON.stringify({ id, state: "running" }),
              { status: 200 },
            );
          }
          const code = acceptedStatementCodes.get(id) ?? "";
          const isCreate = code.includes("CREATE TABLE IF NOT EXISTS");
          const isOrders = code.includes("`sales`.`orders`");
          const operation = isOrders ? operations[0]! : operations[1]!;
          const observed = isCreate
            ? observation(operation.table, {
                ownership: operation.ownership,
              })
            : absentObservation(true);
          return new Response(
            JSON.stringify(
              statementAvailable(
                observed,
                "Bearer very-secret-token raw stdout must not escape\n",
              ),
            ),
            { status: 200 },
          );
        }
        if (method === "DELETE" && url.endsWith(`/sessions/${SESSION_UUID}`)) {
          return new Response(undefined, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const adapter = createAdapter(fetchImpl, {
      now: () => now,
      sleep,
    });
    const lifecycle: string[] = [];

    const result = await adapter.apply(
      "workspace id",
      "lakehouse/id",
      desired,
      EXECUTION,
      {
        onSessionSubmitting: () => {
          lifecycle.push("session-submitting");
        },
        onSessionAccepted: () => {
          lifecycle.push("session-accepted");
        },
        onStatementSubmitting: (context) => {
          lifecycle.push(`statement-submitting:${context.purpose}`);
        },
        onStatementAccepted: (context) => {
          lifecycle.push(`statement-accepted:${context.purpose}`);
        },
        onOperationSubmitting: () => {
          lifecycle.push("operation-submitting");
        },
        onOperationAccepted: () => {
          lifecycle.push("operation-accepted");
        },
        onOperationVerified: () => {
          lifecycle.push("operation-verified");
        },
      },
    );

    const expectedSessionName = createLakehouseTablesSessionName(
      "workspace id",
      "lakehouse/id",
      desired.desiredHash,
      EXECUTION,
    );
    expect(requests[0]?.url).toBe(
      "https://api.fabric.microsoft.com/v1/workspaces/workspace%20id/lakehouses/lakehouse%2Fid/livyApi/versions/2023-12-01/sessions",
    );
    expect(requests[0]?.body).toMatchObject({
      name: expectedSessionName,
      driverMemory: "28g",
      driverCores: 4,
      executorMemory: "28g",
      executorCores: 4,
      tags: {
        "fabric.deploy.attemptId": EXECUTION.attemptId,
        "fabric.deploy.desiredHash": desired.desiredHash,
        "fabric.deploy.requestHash": expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const statementCodes = requests
      .filter(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith("/statements"),
      )
      .map((request) => String(request.body?.code));
    expect(statementCodes).toHaveLength(4);
    expect(statementCodes.slice(0, 2).every((code) =>
      !code.includes("CREATE TABLE"),
    )).toBe(true);
    expect(statementCodes.slice(2).every((code) =>
      !code.includes("CREATE SCHEMA"),
    )).toBe(true);
    expect(statementCodes[2]).toContain(
      `'${FABRIC_TABLE_OWNER_SCHEME_PROPERTY}' = '${FABRIC_TABLE_OWNER_SCHEME_V1}'`,
    );
    expect(statementCodes[2]).toContain(
      `'${FABRIC_TABLE_OWNER_ID_PROPERTY}' = '${operations[0]!.ownership.ownerId}'`,
    );
    expect(statementCodes[2]).not.toContain(
      FABRIC_TABLE_SOURCE_HASH_PROPERTY,
    );
    expect(statementCodes[2]).not.toContain(
      FABRIC_TABLE_OPERATION_HASH_PROPERTY,
    );
    expect(statementCodes[2]).toContain(
      `'${FABRIC_TABLE_DESIRED_HASH_PROPERTY}' = '${operations[0]!.desiredHash}'`,
    );
    expect(result.operations.map((operation) => operation.logicalId)).toEqual([
      "orders",
      "orderLines",
    ]);
    expect(Object.hasOwn(result.operations[0]!, "output")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("very-secret-token");
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: expect.stringContaining(`/sessions/${SESSION_UUID}`),
    });
    expect(lifecycle.slice(0, 2)).toEqual([
      "session-submitting",
      "session-accepted",
    ]);
    expect(lifecycle.filter((value) =>
      value === "operation-submitting",
    )).toHaveLength(2);
    expect(lifecycle.filter((value) =>
      value === "operation-accepted",
    )).toHaveLength(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("observes schema existence and blocks planning/apply without creating it", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS missing_schema.orders (id BIGINT) USING DELTA",
      },
    ]);
    const postedCodes: string[] = [];
    let sessionId = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (method === "POST" && url.endsWith("/sessions")) {
          sessionId += 1;
          return new Response(
            JSON.stringify({ id: sessionUuid(sessionId) }),
            {
            status: 202,
            },
          );
        }
        if (method === "GET" && SESSION_PATH_PATTERN.test(url)) {
          return new Response(JSON.stringify({ state: "idle" }), {
            status: 200,
          });
        }
        if (method === "POST" && url.endsWith("/statements")) {
          const body = JSON.parse(String(init?.body));
          postedCodes.push(String(body.code));
          return new Response(JSON.stringify({ id: 1, state: "waiting" }), {
            status: 200,
          });
        }
        if (method === "GET" && url.endsWith("/statements/1")) {
          return new Response(
            JSON.stringify(statementAvailable(absentObservation(false))),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          return new Response(undefined, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const plan = await adapter.plan(
      "workspace",
      "lakehouse",
      desired,
      EXECUTION,
    );
    expect(plan.action).toBe("blocked");
    expect(plan.tables[0]?.reason).toContain("does not exist");

    await expect(
      adapter.apply(
        "workspace",
        "lakehouse",
        desired,
        EXECUTION,
      ),
    ).rejects.toThrow("does not exist");
    expect(postedCodes.every((code) => !code.includes("CREATE SCHEMA"))).toBe(
      true,
    );
    expect(postedCodes.every((code) => !code.includes("CREATE TABLE"))).toBe(
      true,
    );
  });

  it("enforces ownership and models adoption as a separate non-executed operation", async () => {
    const unownedDefinition = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const table = unownedDefinition.tables[0]!.table;
    const unowned = observation(table);

    const blockedPlan = await singleObservationAdapter(
      unownedDefinition,
      unowned,
    ).plan(
      "workspace",
      "lakehouse",
      unownedDefinition,
      EXECUTION,
    );
    expect(blockedPlan.action).toBe("blocked");
    expect(blockedPlan.tables[0]?.ownershipState).toBe("unowned");

    const adoptDefinition = {
      ...unownedDefinition,
      adoptExisting: true,
    };
    const adoptAdapter = singleObservationAdapter(
      adoptDefinition,
      unowned,
    );
    const adoptPlan = await adoptAdapter.plan(
      "workspace",
      "lakehouse",
      adoptDefinition,
      EXECUTION,
    );
    expect(adoptPlan.action).toBe("adopt");
    expect(adoptPlan.tables[0]?.adoptionOperation).toMatchObject({
      kind: "adopt-table-ownership",
      identifier: "sales.orders",
    });
    expect(
      adoptPlan.tables[0]?.adoptionOperation?.operationHash,
    ).toBe(
      buildLakehouseTableCreateOperations(
        adoptDefinition,
        EXECUTION,
      )[0]?.operationHash,
    );
    await expect(
      adoptAdapter.apply(
        "workspace",
        "lakehouse",
        adoptDefinition,
        EXECUTION,
      ),
    ).rejects.toBeInstanceOf(LakehouseTableAdoptionRequiredError);
  });

  it("accepts exact ownership and blocks conflicting ownership", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const ownedPlan = await singleObservationAdapter(
      desired,
      observation(operation.table, {
        ownership: operation.ownership,
      }),
    ).plan("workspace", "lakehouse", desired, EXECUTION);
    expect(ownedPlan.action).toBe("no-op");
    expect(ownedPlan.tables[0]?.ownershipState).toBe("owned");

    const conflicting = observation(operation.table, {
      ownership: {
        ...operation.ownership,
        ownerId: "c".repeat(64),
      },
    });
    const conflictingPlan = await singleObservationAdapter(
      { ...desired, adoptExisting: true },
      conflicting,
    ).plan(
      "workspace",
      "lakehouse",
      { ...desired, adoptExisting: true },
      EXECUTION,
    );
    expect(conflictingPlan.action).toBe("blocked");
    expect(conflictingPlan.tables[0]?.ownershipState).toBe("conflicting");
  });

  it("keeps stable ownership across SQL formatting, comments, and file renames", async () => {
    const original = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const originalOperation = buildLakehouseTableCreateOperations(
      original,
      EXECUTION,
    )[0]!;
    const reformatted = definition([
      {
        logicalId: "orders",
        sql: `
          -- formatting-only source comment
          CREATE TABLE IF NOT EXISTS sales.orders (
            id BIGINT
          )
          USING DELTA
        `,
      },
    ]);
    reformatted.tables[0]!.file = "tables/renamed-orders.sql";
    reformatted.sourceHash = "c".repeat(64);
    const changedExecution = {
      ...EXECUTION,
      sourceHash: reformatted.sourceHash,
      attemptId: "attempt-2",
    };
    const changedOperation = buildLakehouseTableCreateOperations(
      reformatted,
      changedExecution,
    )[0]!;

    expect(changedOperation.desiredHash).toBe(
      originalOperation.desiredHash,
    );
    expect(changedOperation.ownership).toEqual(
      originalOperation.ownership,
    );
    expect(changedOperation.operationHash).not.toBe(
      originalOperation.operationHash,
    );
    const plan = await singleObservationAdapter(
      reformatted,
      observation(originalOperation.table, {
        ownership: originalOperation.ownership,
      }),
    ).plan(
      "workspace",
      "lakehouse",
      reformatted,
      changedExecution,
    );
    expect(plan.action).toBe("no-op");
    expect(plan.tables[0]?.ownershipState).toBe("owned");
  });

  it("keeps an existing table owned and no-op when another table is added", async () => {
    const original = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const originalOperation = buildLakehouseTableCreateOperations(
      original,
      EXECUTION,
    )[0]!;
    const expanded = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
      {
        logicalId: "audit",
        sql: "CREATE TABLE IF NOT EXISTS sales.audit (id BIGINT) USING DELTA",
      },
    ]);
    expanded.sourceHash = "d".repeat(64);
    const expandedExecution = {
      ...EXECUTION,
      sourceHash: expanded.sourceHash,
      attemptId: "attempt-expanded",
    };
    const expandedOperations = buildLakehouseTableCreateOperations(
      expanded,
      expandedExecution,
    );
    expect(expandedOperations[0]!.ownership).toEqual(
      originalOperation.ownership,
    );

    const plan = await orderedObservationAdapter([
      observation(originalOperation.table, {
        ownership: originalOperation.ownership,
      }),
      absentObservation(true),
    ]).plan(
      "workspace",
      "lakehouse",
      expanded,
      expandedExecution,
    );
    expect(plan.action).toBe("create");
    expect(plan.tables.map((table) => table.action)).toEqual([
      "no-op",
      "create",
    ]);
  });

  it("conflicts for a different stable owner and for legacy hash ownership", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const originalOperation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const differentOwnerExecution = {
      ...EXECUTION,
      bundleLogicalId: "otherTables",
      attemptId: "attempt-other-owner",
    };
    const differentOwnerPlan = await singleObservationAdapter(
      desired,
      observation(originalOperation.table, {
        ownership: originalOperation.ownership,
      }),
    ).plan(
      "workspace",
      "lakehouse",
      desired,
      differentOwnerExecution,
    );
    expect(differentOwnerPlan.action).toBe("blocked");
    expect(differentOwnerPlan.tables[0]?.ownershipState).toBe(
      "conflicting",
    );

    const renamedLogicalOwner = definition([
      {
        logicalId: "renamedOrders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const renamedLogicalPlan = await singleObservationAdapter(
      renamedLogicalOwner,
      observation(originalOperation.table, {
        ownership: originalOperation.ownership,
      }),
    ).plan(
      "workspace",
      "lakehouse",
      renamedLogicalOwner,
      {
        ...EXECUTION,
        attemptId: "attempt-other-table-owner",
      },
    );
    expect(renamedLogicalPlan.action).toBe("blocked");
    expect(renamedLogicalPlan.tables[0]?.ownershipState).toBe(
      "conflicting",
    );

    const legacy = observation(originalOperation.table, {
      overrides: {
        properties: {
          [FABRIC_TABLE_SOURCE_HASH_PROPERTY]: "b".repeat(64),
          [FABRIC_TABLE_OPERATION_HASH_PROPERTY]: "c".repeat(64),
          [FABRIC_TABLE_DESIRED_HASH_PROPERTY]:
            originalOperation.desiredHash,
        },
      },
    });
    const legacyPlan = await singleObservationAdapter(
      desired,
      legacy,
    ).plan("workspace", "lakehouse", desired, EXECUTION);
    expect(legacyPlan.action).toBe("blocked");
    expect(legacyPlan.tables[0]?.ownershipState).toBe("conflicting");
  });

  it("fails closed on unsupported Delta protocol versions and table features", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const incompatible = observation(operation.table, {
      ownership: operation.ownership,
      overrides: {
        minReaderVersion: 3,
        minWriterVersion: 7,
        tableFeatures: ["deletionVectors"],
      },
    });
    const plan = await singleObservationAdapter(
      desired,
      incompatible,
    ).plan("workspace", "lakehouse", desired, EXECUTION);

    expect(plan.action).toBe("blocked");
    expect(plan.tables[0]?.protocolCompatible).toBe(false);
    expect(plan.tables[0]?.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("minReaderVersion"),
        expect.stringContaining("minWriterVersion"),
        expect.stringContaining("deletionVectors"),
      ]),
    );
  });

  it("accepts Fabric's legacy writer-v2 table feature metadata", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const compatible = observation(operation.table, {
      ownership: operation.ownership,
    });
    const plan = await singleObservationAdapter(
      desired,
      compatible,
    ).plan("workspace", "lakehouse", desired, EXECUTION);

    expect(plan.action).toBe("no-op");
    expect(plan.tables[0]?.protocolCompatible).toBe(true);
    expect(plan.tables[0]?.differences).toEqual([]);
  });

  it("fails on sanitized Spark errors and preserves cleanup behavior", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const methods: string[] = [];
    let statement = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        methods.push(method);
        const url = String(input);
        if (method === "POST" && url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ id: SESSION_UUID }), {
            status: 202,
          });
        }
        if (method === "GET" && url.endsWith(`/sessions/${SESSION_UUID}`)) {
          return new Response(JSON.stringify({ state: "idle" }), {
            status: 200,
          });
        }
        if (method === "POST" && url.endsWith("/statements")) {
          return new Response(
            JSON.stringify({ id: statement++, state: "waiting" }),
            { status: 200 },
          );
        }
        if (method === "GET" && url.endsWith("/statements/0")) {
          return new Response(
            JSON.stringify(statementAvailable(absentObservation(true))),
            { status: 200 },
          );
        }
        if (method === "GET" && url.endsWith("/statements/1")) {
          return new Response(
            JSON.stringify({
              state: "available",
              output: {
                status: "error",
                ename: "AnalysisException",
                evalue:
                  "Bearer extremely-secret-token " + "x".repeat(3_000),
              },
            }),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          return new Response(undefined, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const error = await adapter
      .apply("workspace", "lakehouse", desired, EXECUTION)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("AnalysisException");
    expect((error as Error).message).not.toContain(
      "extremely-secret-token",
    );
    expect((error as Error).message.length).toBeLessThan(1_200);
    expect(methods.at(-1)).toBe("DELETE");
  });

  it("fails when a session terminates and preserves the primary error if cleanup also fails", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "POST") {
          return new Response(JSON.stringify({ id: SESSION_UUID }), {
            status: 202,
          });
        }
        if (method === "GET") {
          return new Response(
            JSON.stringify({
              state: "dead",
              log: ["capacity unavailable"],
            }),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          return new Response(
            JSON.stringify({
              errorCode: "CleanupFailed",
              message: "delete failed",
            }),
            { status: 500 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const error = await adapter
      .apply("workspace", "lakehouse", desired, EXECUTION)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain(
      "capacity unavailable",
    );
    expect((error as AggregateError).errors).toHaveLength(2);
  });

  it("discovers exact-name sessions and exposes fail-closed ambiguous statement recovery without POST", async () => {
    const sessionName = "fabric-deploy-tables-exact";
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        requests.push({ method, url });
        if (
          method === "GET" &&
          url.includes("/sessions?$top=100&$skip=0")
        ) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  name: sessionName,
                  livyState: "idle",
                },
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  name: "other",
                  livyState: "idle",
                },
              ],
              totalCountOfMatchedItems: 2,
              pageSize: 2,
            }),
            { status: 200 },
          );
        }
        if (method === "GET" && url.endsWith("/statements/7")) {
          return new Response(
            JSON.stringify({ id: 7, state: "running" }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.discoverSessionsByExactName(
        "workspace",
        "lakehouse",
        sessionName,
      ),
    ).resolves.toMatchObject({
      outcome: "single",
      session: {
        id: "11111111-1111-4111-8111-111111111111",
        name: sessionName,
      },
    });
    await expect(
      adapter.assessAmbiguousStatement("workspace", "lakehouse", {
        sessionName,
      }),
    ).resolves.toMatchObject({
      outcome: "fail-closed",
      reason: expect.stringContaining("will not resubmit"),
    });
    await expect(
      adapter.assessAmbiguousStatement("workspace", "lakehouse", {
        sessionName,
        statementId: 7,
      }),
    ).resolves.toMatchObject({
      outcome: "monitor",
      statementId: 7,
      state: "running",
    });
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("discovers one exact tagged session across pages and matches one statement marker/hash", async () => {
    const sessionName = "fabric-deploy-tables-recovery";
    const attemptId = "attempt-recovery";
    const requestHash = "c".repeat(64);
    const statementAttemptName =
      "fabric-deploy-statement-recovery";
    const codeHash = "d".repeat(64);
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (
          method === "GET" &&
          url.includes("/sessions?$top=100&$skip=0")
        ) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: SESSION_UUID,
                  name: sessionName,
                  livyState: "idle",
                  submittedDateTime: "2026-01-01T00:00:00.000Z",
                  tags: {
                    "fabric.deploy.attemptId": attemptId,
                    "fabric.deploy.requestHash": requestHash,
                  },
                },
              ],
              totalCountOfMatchedItems: 2,
              pageSize: 1,
            }),
            { status: 200 },
          );
        }
        if (
          method === "GET" &&
          url.includes("/sessions?$top=100&$skip=1")
        ) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  name: sessionName,
                  livyState: "idle",
                  submittedDateTime: "2026-01-01T00:00:00.000Z",
                  tags: {
                    "fabric.deploy.attemptId": "other",
                    "fabric.deploy.requestHash": requestHash,
                  },
                },
              ],
              totalCountOfMatchedItems: 2,
              pageSize: 1,
            }),
            { status: 200 },
          );
        }
        if (
          method === "GET" &&
          url.endsWith(`/sessions/${SESSION_UUID}`)
        ) {
          return new Response(
            JSON.stringify({
              id: SESSION_UUID,
              name: sessionName,
              state: "idle",
              tags: {
                "fabric.deploy.attemptId": attemptId,
                "fabric.deploy.requestHash": requestHash,
              },
            }),
            { status: 200 },
          );
        }
        if (method === "GET" && url.endsWith("/statements")) {
          return new Response(
            JSON.stringify({
              statements: [
                {
                  id: 3,
                  state: "running",
                  code: [
                    `_fabric_deploy_statement_attempt_name = ${JSON.stringify(
                      statementAttemptName,
                    )}`,
                    `_fabric_deploy_statement_code_hash = ${JSON.stringify(
                      codeHash,
                    )}`,
                    "print('safe')",
                  ].join("\n"),
                },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.discoverSessionAttempt("workspace", "lakehouse", {
        sessionName,
        attemptId,
        requestHash,
        submittedAfter: "2025-12-31T23:59:00.000Z",
        submittedBefore: "2026-01-01T00:01:00.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "single",
      session: {
        id: SESSION_UUID,
        name: sessionName,
        state: "idle",
      },
    });
    await expect(
      adapter.discoverStatementByMarker(
        "workspace",
        "lakehouse",
        SESSION_UUID,
        statementAttemptName,
        codeHash,
      ),
    ).resolves.toEqual({
      outcome: "single",
      statementId: 3,
      state: "running",
    });
  });

  it("parses one marker line even when metadata contains the marker substring and rejects multiple marker lines", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA COMMENT 'contains FABRIC_DEPLOY_TABLE_RESULT: safely'",
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const matching = observation(operation.table, {
      ownership: operation.ownership,
    });
    await expect(
      singleObservationAdapter(desired, matching).plan(
        "workspace",
        "lakehouse",
        desired,
        EXECUTION,
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      tables: [
        {
          observation: {
            comment:
              "contains FABRIC_DEPLOY_TABLE_RESULT: safely",
          },
        },
      ],
    });

    const markerPayload = JSON.stringify(absentObservation(true));
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "POST" && url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ id: SESSION_UUID }), {
            status: 202,
          });
        }
        if (
          method === "GET" &&
          url.endsWith(`/sessions/${SESSION_UUID}`)
        ) {
          return new Response(JSON.stringify({ state: "idle" }), {
            status: 200,
          });
        }
        if (method === "POST" && url.endsWith("/statements")) {
          return new Response(
            JSON.stringify({ id: 0, state: "waiting" }),
            { status: 200 },
          );
        }
        if (method === "GET" && url.endsWith("/statements/0")) {
          return new Response(
            JSON.stringify({
              state: "available",
              output: {
                status: "ok",
                data: {
                  "text/plain": [
                    `FABRIC_DEPLOY_TABLE_RESULT:${markerPayload}`,
                    `FABRIC_DEPLOY_TABLE_RESULT:${markerPayload}`,
                  ].join("\n"),
                },
              },
            }),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          return new Response(undefined, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    await expect(
      createAdapter(fetchImpl).verify(
        "workspace",
        "lakehouse",
        desired,
        EXECUTION,
      ),
    ).rejects.toThrow("multiple Fabric table verification marker lines");
  });

  it("rejects prototype-sensitive keys in observed property maps", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: "CREATE TABLE IF NOT EXISTS sales.orders (id BIGINT) USING DELTA",
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const properties = JSON.parse(
      `{"__proto__":"unsafe","${FABRIC_TABLE_OWNER_SCHEME_PROPERTY}":"${operation.ownership.ownerScheme}","${FABRIC_TABLE_OWNER_ID_PROPERTY}":"${operation.ownership.ownerId}","${FABRIC_TABLE_DESIRED_HASH_PROPERTY}":"${operation.ownership.desiredHash}"}`,
    ) as Record<string, string>;
    const observed = observation(operation.table, {
      ownership: operation.ownership,
      overrides: { properties },
    });

    await expect(
      singleObservationAdapter(desired, observed).plan(
        "workspace",
        "lakehouse",
        desired,
        EXECUTION,
      ),
    ).rejects.toThrow("contains unsafe key '__proto__'");
  });

  it("quotes apostrophes deterministically and rejects unsafe runtime literals defensively", () => {
    const table = parseLakehouseTableSql(`
      CREATE TABLE IF NOT EXISTS sales.orders (
        id BIGINT COMMENT 'customer''s identifier'
      )
      USING DELTA
      COMMENT 'team''s table'
      TBLPROPERTIES ('owner' = 'data''s team')
    `);

    expect(generateCreateTableSql(table)).toBe(
      [
        "CREATE TABLE IF NOT EXISTS `sales`.`orders` (",
        "  `id` BIGINT COMMENT 'customer''s identifier'",
        ")",
        "USING DELTA",
        "COMMENT 'team''s table'",
        "TBLPROPERTIES ('owner' = 'data''s team')",
      ].join("\n"),
    );
    expect(quoteSparkIdentifier("a`b")).toBe("`a``b`");
    expect(quoteSparkStringLiteral("a'b")).toBe("'a''b'");
    expect(() => quoteSparkStringLiteral("unsafe\\literal")).toThrow(
      "unsafe character",
    );
  });

  it("reports structural verification mismatches without submitting CREATE", async () => {
    const desired = definition([
      {
        logicalId: "orders",
        sql: `
          CREATE TABLE IF NOT EXISTS sales.orders (
            id BIGINT,
            order_date DATE
          )
          USING DELTA
          PARTITIONED BY (order_date)
          TBLPROPERTIES ('layer'='silver')
        `,
      },
    ]);
    const operation = buildLakehouseTableCreateOperations(
      desired,
      EXECUTION,
    )[0]!;
    const postedCodes: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        if (method === "POST" && url.endsWith("/sessions")) {
          return new Response(JSON.stringify({ id: SESSION_UUID }), {
            status: 202,
          });
        }
        if (method === "GET" && url.endsWith(`/sessions/${SESSION_UUID}`)) {
          return new Response(JSON.stringify({ state: "idle" }), {
            status: 200,
          });
        }
        if (method === "POST" && url.endsWith("/statements")) {
          const body = JSON.parse(String(init?.body));
          postedCodes.push(String(body.code));
          return new Response(JSON.stringify({ id: 1, state: "waiting" }), {
            status: 200,
          });
        }
        if (method === "GET" && url.endsWith("/statements/1")) {
          return new Response(
            JSON.stringify(
              statementAvailable(
                observation(operation.table, {
                  ownership: operation.ownership,
                  overrides: {
                    tableType: "EXTERNAL",
                    managed: false,
                    columns: [
                      {
                        name: "id",
                        dataType: "string",
                        nullable: true,
                      },
                    ],
                    partitionColumns: [],
                    properties: {
                      [FABRIC_TABLE_OWNER_SCHEME_PROPERTY]:
                        operation.ownership.ownerScheme,
                      [FABRIC_TABLE_OWNER_ID_PROPERTY]:
                        operation.ownership.ownerId,
                      [FABRIC_TABLE_DESIRED_HASH_PROPERTY]:
                        operation.ownership.desiredHash,
                      layer: "bronze",
                    },
                  },
                }),
              ),
            ),
            { status: 200 },
          );
        }
        if (method === "DELETE") {
          return new Response(undefined, { status: 200 });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const verification = await adapter.verify(
      "workspace",
      "lakehouse",
      desired,
      EXECUTION,
    );

    expect(verification.matches).toBe(false);
    expect(verification.tables[0]?.differences).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected MANAGED"),
        expect.stringContaining("column count"),
        expect.stringContaining("type is 'string'"),
        expect.stringContaining("partition columns"),
        expect.stringContaining("property 'layer'"),
      ]),
    );
    expect(postedCodes).toHaveLength(1);
    expect(postedCodes[0]).not.toContain("CREATE TABLE");
    expect(postedCodes[0]).not.toContain("CREATE SCHEMA");
  });
});
