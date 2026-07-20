import {
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import type { FabricDefinition } from "../src/fabric/definition";
import {
  materializeReportDefinitionWithProof,
  validateLogicalReferenceDeclarations,
} from "../src/fabric/logical-references";
import { reportBindingConnectionString } from "../src/fabric/report-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  ItemDefinition,
  LoadedManifest,
  PlannedItem,
} from "../src/types";

function jsonPart(
  partPath: string,
  value: Record<string, unknown>,
) {
  return {
    path: partPath,
    payload: Buffer.from(JSON.stringify(value)).toString("base64"),
    payloadType: "InlineBase64" as const,
  };
}

const semanticModelDefinition: FabricDefinition = {
  format: "TMSL",
  parts: [
    jsonPart("model.bim", {
      compatibilityLevel: 1702,
      model: { culture: "en-US", tables: [] },
    }),
    jsonPart("definition.pbism", {
      version: "5.0",
      settings: {},
    }),
  ],
};

const reportDefinition: FabricDefinition = {
  format: "PBIR",
  parts: [
    jsonPart("definition.pbir", {
      $schema:
        "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
      version: "4.0",
      datasetReference: {
        byConnection: {
          connectionString: "semanticmodelid=source-placeholder",
        },
      },
    }),
    jsonPart("definition/report.json", {
      themeCollection: {},
    }),
    jsonPart("definition/version.json", {
      version: "1.0.0",
    }),
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: {
    salesModel: "model-content",
    salesReport: "report-content",
  },
  itemDirectories: {
    salesModel: "items/model",
    salesReport: "items/report",
  },
  itemDefinitions: {
    salesModel: {
      displayName: "Sales Model",
    },
    salesReport: {
      displayName: "Sales Report",
      references: { semanticModel: "salesModel" },
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {
    salesModel: semanticModelDefinition,
  },
  reportDefinitions: {
    salesReport: reportDefinition,
  },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "report-apply" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "salesModel",
        type: "SemanticModel",
        path: "items/model",
      },
      {
        logicalId: "salesReport",
        type: "Report",
        path: "items/report",
        dependsOn: ["salesModel"],
      },
    ],
  },
};

function plan() {
  const result = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit",
  });
  result.items = result.items.map(
    (item): PlannedItem => ({
      ...item,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    }),
  );
  return rehashPlan(result);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-report-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  const fail = async () => {
    throw new Error("Lakehouse adapter should not be called.");
  };
  return {
    plan: vi.fn(fail),
    create: vi.fn(fail),
    update: vi.fn(fail),
    resumeCreate: vi.fn(fail),
    verify: vi.fn(fail),
  };
}

describe("guarded Report apply", () => {
  it("waits for a same-apply Semantic Model, materializes its ID, and checkpoints proof before Report dispatch", async () => {
    const approved = plan();
    const output = files();
    const semanticModelAdapter = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "create",
        observedStateHash: "absent",
      })),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          _definition: FabricDefinition,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: unknown,
          onCreateSubmitting?: () => void,
        ) => {
          onCreateSubmitting?.();
          onMutationAccepted?.("semantic-model-created");
          return {
            id: "semantic-model-created",
            displayName: "Sales Model",
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: "semantic-model-created",
        displayName: "Sales Model",
      })),
    };
    const reportAdapter = {
      plan: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          definition: FabricDefinition,
        ) => {
          expect(reportBindingConnectionString(definition)).toBe(
            "semanticmodelid=semantic-model-created",
          );
          return {
            action: "create" as const,
            reason: "create",
            observedStateHash: "absent",
          };
        },
      ),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          definition: FabricDefinition,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: unknown,
          onCreateSubmitting?: () => void,
        ) => {
          expect(reportBindingConnectionString(definition)).toBe(
            "semanticmodelid=semantic-model-created",
          );
          onCreateSubmitting?.();
          const checkpoint = JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          );
          expect(
            checkpoint.pendingCreates.salesReport
              .materializedDefinitionHash,
          ).toMatch(/^[0-9a-f]{64}$/);
          expect(
            checkpoint.pendingCreates.salesReport
              .resolvedBindingsHash,
          ).toMatch(/^[0-9a-f]{64}$/);
          onMutationAccepted?.("report-created");
          return {
            id: "report-created",
            displayName: "Sales Report",
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: "report-created",
        displayName: "Sales Report",
      })),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter,
      reportAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items.map((item) => item.status)).toEqual([
      "created",
      "created",
    ]);
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems,
    ).toMatchObject({
      salesModel: { physicalId: "semantic-model-created" },
      salesReport: { physicalId: "report-created" },
    });
  });

  it("keeps Report creation gated by allow-create", async () => {
    const approved = plan();
    const output = files();
    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        semanticModelAdapter: {
          plan: vi.fn(async () => ({
            action: "create" as const,
            reason: "create",
            observedStateHash: "absent",
          })),
          create: vi.fn(),
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        reportAdapter: {
          plan: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-create is false");
  });

  it("recovers an interrupted Report update with the exact materialized binding proof", async () => {
    const bindings = validateLogicalReferenceDeclarations({
      item: loaded.manifest.items[1]!,
      definition: loaded.itemDefinitions.salesReport!,
      itemGraph: loaded.manifest.items,
    });
    const materialized = materializeReportDefinitionWithProof(
      reportDefinition,
      bindings,
      { salesModel: "semantic-model-existing" },
    );
    const approved = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit",
    });
    approved.items = approved.items.map((item) =>
      item.logicalId === "salesModel"
        ? {
            ...item,
            action: "no-op" as const,
            reason: "matches",
            observedStateHash: "model-observed",
            physicalId: "semantic-model-existing",
          }
        : {
            ...item,
            action: "update" as const,
            reason: "update",
            observedStateHash: "report-before",
            physicalId: "report-existing",
            materializedDefinitionHash:
              materialized.materializedDefinitionHash,
            resolvedBindingsHash:
              materialized.resolvedBindingsHash,
          },
    );
    const approvedPlan = rehashPlan(approved);
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.salesReport = {
      logicalId: "salesReport",
      action: "update",
      physicalId: "report-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash: "b".repeat(64),
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const update = vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        definition: FabricDefinition,
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        expect(reportBindingConnectionString(definition)).toBe(
          "semanticmodelid=semantic-model-existing",
        );
        onMutationAccepted?.(id);
        return { id, displayName: "Sales Report" };
      },
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan: approvedPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: {
        plan: vi.fn(async () => ({
          action: "no-op" as const,
          reason: "matches",
          observedStateHash: "model-observed",
          physicalId: "semantic-model-existing",
        })),
        create: vi.fn(),
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(async () => ({
          id: "semantic-model-existing",
          displayName: "Sales Model",
        })),
      },
      reportAdapter: {
        plan: vi.fn(async () => ({
          action: "update" as const,
          reason: "update",
          observedStateHash: "report-before",
          physicalId: "report-existing",
          stagedDefinitionHash: "b".repeat(64),
          managedMetadataMatches: true,
        })),
        create: vi.fn(),
        update,
        resumeCreate: vi.fn(),
        verify: vi.fn(async () => ({
          id: "report-existing",
          displayName: "Sales Report",
        })),
      },
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items.find((item) => item.logicalId === "salesReport"))
      .toMatchObject({ status: "resumed" });
    expect(update).toHaveBeenCalledOnce();
  });

  it("continues a symbolic Report create after its same-apply Semantic Model was checkpointed", async () => {
    const approvedPlan = plan();
    const bindings = validateLogicalReferenceDeclarations({
      item: loaded.manifest.items[1]!,
      definition: loaded.itemDefinitions.salesReport!,
      itemGraph: loaded.manifest.items,
    });
    const materialized = materializeReportDefinitionWithProof(
      reportDefinition,
      bindings,
      { salesModel: "semantic-model-created" },
    );
    const currentPlan = rehashPlan({
      ...approvedPlan,
      items: approvedPlan.items.map((item) =>
        item.logicalId === "salesModel"
          ? {
              ...item,
              action: "no-op" as const,
              reason: "matches",
              physicalId: "semantic-model-created",
              observedStateHash: "model-live",
            }
          : {
              ...item,
              materializedDefinitionHash:
                materialized.materializedDefinitionHash,
              resolvedBindingsHash:
                materialized.resolvedBindingsHash,
            },
      ),
    });
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.completedItems.salesModel = {
      logicalId: "salesModel",
      action: "create",
      physicalId: "semantic-model-created",
      completedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const reportCreate = vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        definition: FabricDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: unknown,
        onCreateSubmitting?: () => void,
      ) => {
        expect(reportBindingConnectionString(definition)).toBe(
          "semanticmodelid=semantic-model-created",
        );
        onCreateSubmitting?.();
        onMutationAccepted?.("report-created");
        return { id: "report-created", displayName: "Sales Report" };
      },
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: {
        plan: vi.fn(async () => ({
          action: "no-op" as const,
          reason: "matches",
          observedStateHash: "model-live",
          physicalId: "semantic-model-created",
        })),
        create: vi.fn(),
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(async () => ({
          id: "semantic-model-created",
          displayName: "Sales Model",
        })),
      },
      reportAdapter: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "create",
          observedStateHash: "absent",
        })),
        create: reportCreate,
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(),
      },
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items).toMatchObject([
      { logicalId: "salesModel", status: "resumed" },
      { logicalId: "salesReport", status: "created" },
    ]);
    expect(reportCreate).toHaveBeenCalledOnce();
  });
});
