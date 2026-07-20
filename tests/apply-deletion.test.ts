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
import { sha256, stableJson } from "../src/hash";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { oldNotebook: "content" },
  itemDirectories: {
    oldNotebook: "items/notebooks/old",
  },
  itemDefinitions: {
    oldNotebook: {
      displayName: "Old Notebook",
      desiredState: "absent",
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
    metadata: { deploymentId: "delete-notebook" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "oldNotebook",
        type: "Notebook",
        path: "items/notebooks/old",
        desiredState: "absent",
      },
    ],
  },
};

function makePlan(
  action: Extract<PlannedAction, "delete" | "no-op">,
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
    observedStateHash:
      action === "delete"
        ? "a".repeat(64)
        : sha256(stableJson(null)),
    ...(action === "delete"
      ? { physicalId: "notebook-1" }
      : {}),
  };
  return rehashPlan(plan);
}

const lakehouseLoaded: LoadedManifest = {
  ...loaded,
  itemContentHashes: { retiredLakehouse: "content" },
  itemDirectories: {
    retiredLakehouse: "items/lakehouses/retired",
  },
  itemDefinitions: {
    retiredLakehouse: {
      displayName: "Retired_Lakehouse",
      desiredState: "absent",
    },
  },
  manifest: {
    ...loaded.manifest,
    metadata: { deploymentId: "delete-lakehouse" },
    items: [
      {
        logicalId: "retiredLakehouse",
        type: "Lakehouse",
        path: "items/lakehouses/retired",
        desiredState: "absent",
      },
    ],
  },
};

function makeLakehousePlan(): DeploymentPlan {
  const plan = buildPlan(lakehouseLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: "delete",
    reason: "delete",
    observedStateHash: "c".repeat(64),
    physicalId: "lakehouse-1",
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-delete-"));
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
    verify: fail,
    resumeCreate: fail,
  };
}

describe("guarded item deletion", () => {
  it("requires the independent Lakehouse data-loss safeguard", async () => {
    const plan = makeLakehousePlan();
    const output = files();
    const deletion = {
      plan: vi.fn(async () => ({
        action: "delete" as const,
        reason: "delete",
        physicalId: "lakehouse-1",
        observedStateHash: "c".repeat(64),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => "unchanged" as const,
      ),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: lakehouseLoaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: deletion,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: true,
        allowLakehouseDataLoss: false,
        ...output,
      }),
    ).rejects.toThrow("allow-lakehouse-data-loss is false");

    expect(deletion.delete).not.toHaveBeenCalled();
  });

  it("deletes an approved Lakehouse only when both safeguards are enabled", async () => {
    const plan = makeLakehousePlan();
    const output = files();
    const deletion = {
      plan: vi
        .fn()
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "delete",
          physicalId: "lakehouse-1",
          observedStateHash: "c".repeat(64),
        })
        .mockResolvedValue({
          action: "no-op" as const,
          reason: "absent",
          observedStateHash: sha256(stableJson(null)),
        }),
      delete: vi.fn(
        async (
          _workspaceId: string,
          _itemId: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
        },
      ),
      verifyApprovedIdentity: vi
        .fn()
        .mockResolvedValueOnce("unchanged" as const)
        .mockResolvedValueOnce("absent" as const),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: lakehouseLoaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      itemDeletionAdapter: deletion,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      allowLakehouseDataLoss: true,
      ...output,
    });

    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "deleted",
      physicalId: "lakehouse-1",
    });
  });

  it("requires allow-delete before dispatching a deletion", async () => {
    const plan = makePlan("delete");
    const output = files();
    const deletion = {
      plan: vi.fn(async () => ({
        action: "delete" as const,
        reason: "delete",
        physicalId: "notebook-1",
        observedStateHash: "a".repeat(64),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => "unchanged" as const,
      ),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: deletion,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        ...output,
      }),
    ).rejects.toThrow("allow-delete is false");

    expect(deletion.delete).not.toHaveBeenCalled();
  });

  it("records deletion intent before dispatch and completes exact-ID absence", async () => {
    const plan = makePlan("delete");
    const output = files();
    const states = ["unchanged", "absent"] as const;
    let stateIndex = 0;
    const deletion = {
      plan: vi
        .fn()
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "delete",
          physicalId: "notebook-1",
          observedStateHash: "a".repeat(64),
        })
        .mockResolvedValue({
          action: "no-op" as const,
          reason: "absent",
          observedStateHash: sha256(stableJson(null)),
        }),
      delete: vi.fn(
        async (
          _workspaceId: string,
          _itemId: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
          const checkpoint = JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          );
          expect(checkpoint.pendingDeletes.oldNotebook).toMatchObject({
            action: "delete",
            physicalId: "notebook-1",
            observedStateHash: "a".repeat(64),
          });
        },
      ),
      verifyApprovedIdentity: vi.fn(
        async () => states[stateIndex++] ?? "absent",
      ),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      itemDeletionAdapter: deletion,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "deleted",
      physicalId: "notebook-1",
    });
    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingDeletes).toEqual({});
    expect(checkpoint.completedItems.oldNotebook).toMatchObject({
      action: "delete",
      physicalId: "notebook-1",
    });
  });

  it("recovers an accepted deletion without resubmitting when the exact ID is absent", async () => {
    const approved = makePlan("delete");
    const current = makePlan("no-op");
    const output = files();
    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingDeletes.oldNotebook = {
      logicalId: "oldNotebook",
      action: "delete",
      physicalId: "notebook-1",
      observedStateHash: "a".repeat(64),
      submittedAt: new Date(0).toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const deletion = {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "absent",
        observedStateHash: sha256(stableJson(null)),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => "absent" as const,
      ),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      itemDeletionAdapter: deletion,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    expect(deletion.delete).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "resumed",
      physicalId: "notebook-1",
    });
  });

  it("retries a durable pending deletion when the exact approved item is unchanged", async () => {
    const plan = makePlan("delete");
    const output = files();
    const interrupted = {
      plan: vi.fn(async () => ({
        action: "delete" as const,
        reason: "delete",
        physicalId: "notebook-1",
        observedStateHash: "a".repeat(64),
      })),
      delete: vi.fn(
        async (
          _workspaceId: string,
          _itemId: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
          throw new Error("connection lost");
        },
      ),
      verifyApprovedIdentity: vi.fn(
        async () => "unchanged" as const,
      ),
    };
    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: interrupted,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: true,
        ...output,
      }),
    ).rejects.toThrow("connection lost");
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .pendingDeletes.oldNotebook,
    ).toBeDefined();

    const states = [
      "unchanged",
      "absent",
      "absent",
    ] as const;
    let stateIndex = 0;
    const recovered = {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "absent",
        observedStateHash: sha256(stableJson(null)),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => states[stateIndex++] ?? "absent",
      ),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      itemDeletionAdapter: recovered,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    expect(recovered.delete).toHaveBeenCalledWith(
      "workspace",
      "notebook-1",
    );
    expect(result.items[0]?.status).toBe("resumed");
  });

  it("rejects pending deletion checkpoint proof tampering", async () => {
    const plan = makePlan("delete");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingDeletes.oldNotebook = {
      logicalId: "oldNotebook",
      action: "delete",
      physicalId: "notebook-1",
      observedStateHash: "b".repeat(64),
      submittedAt: new Date(0).toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const deletion = {
      plan: vi.fn(),
      delete: vi.fn(),
      verifyApprovedIdentity: vi.fn(),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: deletion,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: true,
        ...output,
      }),
    ).rejects.toThrow(
      "Checkpoint delete intent 'oldNotebook' does not match",
    );

    expect(deletion.delete).not.toHaveBeenCalled();
  });

  it("checkpoints an already-absent no-op without inventing a physical ID", async () => {
    const plan = makePlan("no-op");
    const output = files();
    const deletion = {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "absent",
        observedStateHash: sha256(stableJson(null)),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => "absent" as const,
      ),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      itemDeletionAdapter: deletion,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: false,
      ...output,
    });

    expect(result.items[0]).toMatchObject({
      action: "no-op",
      status: "verified",
    });
    expect(result.items[0]).not.toHaveProperty("physicalId");
    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.completedItems.oldNotebook).not.toHaveProperty(
      "physicalId",
    );
  });

  it("fails closed when deletion identity metadata changes after approval", async () => {
    const plan = makePlan("delete");
    const output = files();
    const deletion = {
      plan: vi.fn(async () => ({
        action: "delete" as const,
        reason: "changed",
        physicalId: "notebook-1",
        observedStateHash: "b".repeat(64),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(
        async () => "unchanged" as const,
      ),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: deletion,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: true,
        ...output,
      }),
    ).rejects.toThrow("Fabric state drifted after approval");

    expect(deletion.delete).not.toHaveBeenCalled();
  });

  it("does not delete a replacement item that appears under the same identity", async () => {
    const plan = makePlan("delete");
    const output = files();
    const deletion = {
      plan: vi
        .fn()
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "approved item",
          physicalId: "notebook-1",
          observedStateHash: "a".repeat(64),
        })
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "replacement",
          physicalId: "notebook-2",
          observedStateHash: "b".repeat(64),
        }),
      delete: vi.fn(
        async (
          _workspaceId: string,
          _itemId: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
        },
      ),
      verifyApprovedIdentity: vi
        .fn()
        .mockResolvedValueOnce("unchanged" as const)
        .mockResolvedValueOnce("absent" as const),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        itemDeletionAdapter: deletion,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: true,
        ...output,
      }),
    ).rejects.toThrow("Generate a new plan before deleting it");

    expect(deletion.delete).toHaveBeenCalledOnce();
    expect(deletion.delete).toHaveBeenCalledWith(
      "workspace",
      "notebook-1",
      expect.any(Function),
    );
  });
});
