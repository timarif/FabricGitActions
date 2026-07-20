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
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const poolDefinition = {
  nodeFamily: "MemoryOptimized" as const,
  nodeSize: "Small" as const,
  autoScale: {
    enabled: true,
    minNodeCount: 1,
    maxNodeCount: 2,
  },
  dynamicExecutorAllocation: {
    enabled: true,
    minExecutors: 1,
    maxExecutors: 1,
  },
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { pool: "content" },
  itemDirectories: { pool: "items/pool" },
  itemDefinitions: {
    pool: { displayName: "Batch Small" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: { pool: poolDefinition },
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "pool",
        type: "SparkCustomPool",
        path: "items/pool",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
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
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-spark-pool-apply-"),
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

function poolAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash =
    plannedAction === "create" ? "absent" : "observed",
  physicalId = "pool-existing",
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
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkCustomPoolDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("pool-created");
        return {
          id: "pool-created",
          name: "Batch Small",
          type: "Workspace",
          ...poolDefinition,
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkCustomPoolDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onMutationAccepted?.(id);
        return {
          id,
          name: "Batch Small",
          type: "Workspace",
          ...poolDefinition,
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      name: "Batch Small",
      type: "Workspace",
      ...poolDefinition,
    })),
  };
}

describe("guarded Spark custom pool apply", () => {
  it("creates and checkpoints a Spark custom pool", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = poolAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkCustomPoolAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems.pool.physicalId,
    ).toBe("pool-created");
  });

  it("updates through the Spark custom pool adapter", async () => {
    const plan = makePlan("update", "before", "pool-existing");
    const output = files();
    const adapter = poolAdapter(
      "update",
      "before",
      "pool-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkCustomPoolAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("clears a definitively rejected synchronous update intent", async () => {
    const plan = makePlan("update", "before", "pool-existing");
    const output = files();
    const adapter = poolAdapter(
      "update",
      "before",
      "pool-existing",
    );
    adapter.update.mockImplementation(
      async (
        _workspace: string,
        _id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkCustomPoolDefinitions"][string],
        _onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
        onUpdateRejected?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onUpdateRejected?.();
        throw new Error("Workspace Admin required.");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        sparkCustomPoolAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("Workspace Admin required");

    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).pendingUpdates.pool,
    ).toBeUndefined();
  });

  it("verifies a no-op Spark custom pool", async () => {
    const plan = makePlan(
      "no-op",
      "observed",
      "pool-existing",
    );
    const output = files();
    const adapter = poolAdapter(
      "no-op",
      "observed",
      "pool-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkCustomPoolAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("reissues an interrupted update only from the approved pre-state", async () => {
    const plan = makePlan("update", "before", "pool-existing");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingUpdates.pool = {
      logicalId: "pool",
      action: "update",
      physicalId: "pool-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = poolAdapter(
      "update",
      "before",
      "pool-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkCustomPoolAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});
