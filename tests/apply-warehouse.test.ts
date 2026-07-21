import {
  existsSync,
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
  writeCheckpoint,
} from "../src/checkpoint";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { warehouse: "content" },
  itemDirectories: { warehouse: "items/warehouse" },
  itemDefinitions: {
    warehouse: {
      displayName: "Sales",
      description: "Sales data warehouse",
      collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "warehouse-sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "warehouse",
        type: "Warehouse",
        path: "items/warehouse",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash: string,
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash,
    ...(physicalId ? { physicalId } : {}),
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-warehouse-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function unusedLakehouseAdapter() {
  const fail = vi.fn(async () => {
    throw new Error("Lakehouse adapter should not be called.");
  });
  return {
    plan: fail,
    create: fail,
    update: fail,
    resumeCreate: fail,
    verify: fail,
  };
}

function warehouseAdapter(
  plannedAction: "create" | "update" | "no-op",
  observedStateHash: string,
  physicalId = "wh-existing",
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
    })),
    create: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("wh-created");
        return {
          id: "wh-created",
          displayName: "Sales",
          properties: {
            collationType:
              "Latin1_General_100_CI_AS_KS_WS_SC_UTF8" as const,
          },
        };
      },
    ),
    update: vi.fn(
      async (
        _workspaceId: string,
        warehouseId: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onMutationAccepted?.(warehouseId);
        return {
          id: warehouseId,
          displayName: "Sales",
          properties: {
            collationType:
              "Latin1_General_100_CI_AS_KS_WS_SC_UTF8" as const,
          },
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        _operation: { operationId?: string; location?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("wh-created");
        return {
          id: "wh-created",
          displayName: "Sales",
          properties: {
            collationType:
              "Latin1_General_100_CI_AS_KS_WS_SC_UTF8" as const,
          },
        };
      },
    ),
    verify: vi.fn(async (_workspaceId: string, warehouseId: string) => ({
      id: warehouseId,
      displayName: "Sales",
      properties: {
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8" as const,
      },
    })),
  };
}

describe("guarded Warehouse apply", () => {
  it("creates and checkpoints a Warehouse behind allow-create", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = warehouseAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      warehouseAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(existsSync(output.checkpointFile)).toBe(true);
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .completedItems.warehouse.physicalId,
    ).toBe("wh-created");
  });

  it("updates Warehouse metadata behind allow-update", async () => {
    const plan = makePlan("update", "before", "wh-existing");
    const output = files();
    const adapter = warehouseAdapter("update", "before", "wh-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      warehouseAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledWith(
      "workspace",
      "wh-existing",
      loaded.itemDefinitions.warehouse,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("resumes an accepted Warehouse create without reissuing it", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: plan.deploymentId,
        workspaceId: plan.workspaceId,
        environment: plan.environment,
        planHash: plan.planHash,
        sourceCommit: plan.sourceCommit,
        completedItems: {},
        pendingOperations: {
          warehouse: {
            logicalId: "warehouse",
            action: "create",
            operationId: "op-wh-1",
            acceptedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const adapter = warehouseAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      warehouseAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.resumeCreate).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.warehouse,
      { operationId: "op-wh-1" },
      expect.any(Function),
    );
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguously completed Warehouse metadata update", async () => {
    const approvedPlan = makePlan("update", "before", "wh-existing");
    const currentPlan = makePlan("no-op", "after", "wh-existing");
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.warehouse = {
      logicalId: "warehouse",
      action: "update",
      physicalId: "wh-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = warehouseAdapter("no-op", "after", "wh-existing");

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      warehouseAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.verify).toHaveBeenCalledWith(
      "workspace",
      "wh-existing",
      loaded.itemDefinitions.warehouse,
    );
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("reconciles a pending synchronous Warehouse create without reissuing it", async () => {
    // Simulates the crash window where the 201 response was received and
    // onMutationAccepted fired (writing pendingCreates), but the process
    // crashed before the completed-item entry was checkpointed.  On the next
    // run, reconcilePendingCreates must detect the warehouse now exists (no-op
    // on re-plan) and close out the intent without calling create again.
    const approvedPlan = makePlan("create", "absent");
    const currentPlan = makePlan("no-op", "hash-after-create", "wh-created");
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingCreates.warehouse = {
      logicalId: "warehouse",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = warehouseAdapter("no-op", "hash-after-create", "wh-created");

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      warehouseAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    // create must NOT be called — we adopt the already-existing item
    expect(adapter.create).not.toHaveBeenCalled();
    expect(adapter.verify).toHaveBeenCalledWith(
      "workspace",
      "wh-created",
      loaded.itemDefinitions.warehouse,
    );
    // pendingCreates must be cleared and completedItems must record the physicalId
    const saved = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    ) as { pendingCreates: Record<string, unknown>; completedItems: Record<string, { physicalId: string }> };
    expect(saved.pendingCreates).not.toHaveProperty("warehouse");
    expect(saved.completedItems.warehouse?.physicalId).toBe("wh-created");
  });

  it("pre-dispatch update failure leaves no ambiguous pending update in checkpoint", async () => {
    // The adapter's update() method must pass onUpdateSubmitting as onDispatch
    // to FabricClient.request, so that a failure before token acquisition or
    // HTTP dispatch does NOT write a pendingUpdates entry to the checkpoint.
    // This test drives the contract from the apply layer: a mock adapter that
    // throws without calling onUpdateSubmitting must result in a clean checkpoint.
    const plan = makePlan("update", "before", "wh-existing");
    const output = files();
    const adapter = {
      ...warehouseAdapter("update", "before", "wh-existing"),
      update: vi.fn(async () => {
        // Throws without calling onUpdateSubmitting — matches adapter
        // behaviour when FabricClient.request throws before onDispatch fires
        // (e.g., token acquisition error or network failure before dispatch).
        throw new Error("Token acquisition failed before dispatch");
      }),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        warehouseAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("Token acquisition failed before dispatch");

    // The checkpoint must have been created (apply initialises it on start)
    // but must NOT contain a pendingUpdates entry for the warehouse item —
    // the failure was pre-dispatch so no ambiguous state exists.
    const saved = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    ) as { pendingUpdates: Record<string, unknown> };
    expect(saved.pendingUpdates).not.toHaveProperty("warehouse");
  });
});
