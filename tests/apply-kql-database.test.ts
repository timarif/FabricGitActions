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
import {
  materializeKqlDatabaseCreationWithProof,
  validateLogicalReferenceDeclarations,
} from "../src/fabric/logical-references";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  ItemDefinition,
  LoadedManifest,
  PlannedItem,
} from "../src/types";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: {
    eventhouse: "eventhouse-content",
    database: "database-content",
  },
  itemDirectories: {
    eventhouse: "items/eventhouse",
    database: "items/database",
  },
  itemDefinitions: {
    eventhouse: {
      displayName: "TelemetryEventhouse",
      minimumConsumptionUnits: 2.25,
    },
    database: {
      displayName: "TelemetryDB",
      databaseType: "ReadWrite",
      references: { eventhouse: "eventhouse" },
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  reportDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "kql-apply" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "eventhouse",
        type: "Eventhouse",
        path: "items/eventhouse",
      },
      {
        logicalId: "database",
        type: "KQLDatabase",
        path: "items/database",
        dependsOn: ["eventhouse"],
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
    path.join(tmpdir(), "fabric-kql-apply-"),
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

function eventhouseAdapter(
  action: "create" | "no-op",
  physicalId = "eventhouse-created",
) {
  return {
    plan: vi.fn(async () => ({
      action,
      reason: action,
      observedStateHash:
        action === "create" ? "absent" : "eventhouse-live",
      ...(action === "no-op" ? { physicalId } : {}),
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: unknown,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.(physicalId);
        return {
          id: physicalId,
          displayName: "TelemetryEventhouse",
          properties: { minimumConsumptionUnits: 2.25 },
        };
      },
    ),
    update: vi.fn(),
    resumeCreate: vi.fn(),
    verify: vi.fn(async () => ({
      id: physicalId,
      displayName: "TelemetryEventhouse",
      properties: { minimumConsumptionUnits: 2.25 },
    })),
  };
}

function kqlMaterialization(eventhouseId: string) {
  return materializeKqlDatabaseCreationWithProof(
    loaded.itemDefinitions.database!,
    validateLogicalReferenceDeclarations({
      item: loaded.manifest.items[1]!,
      definition: loaded.itemDefinitions.database!,
      itemGraph: loaded.manifest.items,
    }),
    { eventhouse: eventhouseId },
  );
}

describe("guarded KQL Database apply", () => {
  it("waits for a same-apply Eventhouse, materializes its ID, and checkpoints proof before dispatch", async () => {
    const approved = plan();
    const output = files();
    const kqlDatabaseAdapter = {
      plan: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          materialized: ReturnType<typeof kqlMaterialization>,
        ) => {
          expect(materialized.creationPayload).toEqual({
            databaseType: "ReadWrite",
            parentEventhouseItemId: "eventhouse-created",
          });
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
          materialized: ReturnType<typeof kqlMaterialization>,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: unknown,
          onCreateSubmitting?: () => void,
        ) => {
          expect(materialized.creationPayload.parentEventhouseItemId).toBe(
            "eventhouse-created",
          );
          onCreateSubmitting?.();
          const checkpoint = JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          );
          expect(
            checkpoint.pendingCreates.database
              .materializedDefinitionHash,
          ).toMatch(/^[0-9a-f]{64}$/);
          expect(
            checkpoint.pendingCreates.database
              .resolvedBindingsHash,
          ).toMatch(/^[0-9a-f]{64}$/);
          onMutationAccepted?.("database-created");
          return {
            id: "database-created",
            displayName: "TelemetryDB",
            properties: materialized.creationPayload,
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: "database-created",
        displayName: "TelemetryDB",
        properties: {
          databaseType: "ReadWrite" as const,
          parentEventhouseItemId: "eventhouse-created",
        },
      })),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      eventhouseAdapter: eventhouseAdapter("create"),
      kqlDatabaseAdapter,
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
      eventhouse: { physicalId: "eventhouse-created" },
      database: { physicalId: "database-created" },
    });
  });

  it("resumes an accepted database create only with the checkpointed Eventhouse proof", async () => {
    const approvedPlan = plan();
    const materialized = kqlMaterialization(
      "eventhouse-created",
    );
    const currentPlan = rehashPlan({
      ...approvedPlan,
      items: approvedPlan.items.map((item) =>
        item.logicalId === "eventhouse"
          ? {
              ...item,
              action: "no-op" as const,
              reason: "matches",
              observedStateHash: "eventhouse-live",
              physicalId: "eventhouse-created",
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
    checkpoint.completedItems.eventhouse = {
      logicalId: "eventhouse",
      action: "create",
      physicalId: "eventhouse-created",
      completedAt: new Date().toISOString(),
    };
    checkpoint.pendingOperations.database = {
      logicalId: "database",
      action: "create",
      operationId: "operation-1",
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const resumeCreate = vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        runtimeMaterialized: ReturnType<typeof kqlMaterialization>,
        operation: { operationId?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        expect(runtimeMaterialized).toEqual(materialized);
        expect(operation).toEqual({ operationId: "operation-1" });
        onMutationAccepted?.("database-created");
        return {
          id: "database-created",
          displayName: "TelemetryDB",
          properties: materialized.creationPayload,
        };
      },
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      eventhouseAdapter: eventhouseAdapter("no-op"),
      kqlDatabaseAdapter: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "create",
          observedStateHash: "absent",
        })),
        create: vi.fn(),
        update: vi.fn(),
        resumeCreate,
        verify: vi.fn(async () => ({
          id: "database-created",
          displayName: "TelemetryDB",
          properties: materialized.creationPayload,
        })),
      },
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items).toMatchObject([
      { logicalId: "eventhouse", status: "resumed" },
      { logicalId: "database", status: "resumed" },
    ]);
    expect(resumeCreate).toHaveBeenCalledOnce();
  });
});
