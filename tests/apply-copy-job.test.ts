/**
 * Tests for the Copy Job apply dispatch and checkpoint recovery.
 *
 * Tests cover:
 * - create and checkpoint a Copy Job
 * - update through the Copy Job adapter
 * - verify a no-op Copy Job
 * - recover an interrupted definition update (checkpoint recovery)
 * - blocked action is surfaced correctly
 * - apply is not invoked for absent (deletion) items without deletion adapter
 * - CopyJob deletion: safeguard, execute, checkpoint, recovery
 */

import {
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
import {
  hashCopyJobDefinition,
} from "../src/fabric/copy-job-definition";
import { sha256, stableJson } from "../src/hash";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

import type { FabricDefinition } from "../src/fabric/definition";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const copyJobDefinition: FabricDefinition = {
  parts: [
    {
      path: "copyjob-content.json",
      payload: Buffer.from(
        JSON.stringify({ properties: { jobMode: "Batch" } }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { copyJob: "content" },
  itemDirectories: { copyJob: "items/copy-jobs/my-job" },
  itemDefinitions: {
    copyJob: { displayName: "MyJob", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  copyJobDefinitions: { copyJob: copyJobDefinition },
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "copyJob",
        type: "CopyJob",
        path: "items/copy-jobs/my-job",
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
    path.join(tmpdir(), "fabric-copyjob-apply-"),
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

function copyJobAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash = plannedAction === "create" ? "absent" : "observed",
  physicalId = "copyjob-existing",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: unknown,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: unknown,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("copyjob-created");
        return {
          id: "copyjob-created",
          displayName: "MyJob",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: unknown,
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateCheckpoint?: (state?: unknown) => void,
      ) => {
        // PATCH-only: bare checkpoint, no phase, no definition staging
        onUpdateCheckpoint?.();
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "MyJob",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: unknown,
        _operation: unknown,
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("copyjob-created");
        return {
          id: "copyjob-created",
          displayName: "MyJob",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "MyJob",
      description: "Desired",
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("guarded Copy Job apply", () => {
  it("creates and checkpoints a Copy Job", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = copyJobAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .completedItems.copyJob.physicalId,
    ).toBe("copyjob-created");
  });

  it("updates through the Copy Job adapter", async () => {
    const plan = makePlan("update", "before", "copyjob-existing");
    const output = files();
    const adapter = copyJobAdapter("update", "before", "copyjob-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("verifies a no-op Copy Job", async () => {
    const plan = makePlan("no-op", "observed", "copyjob-existing");
    const output = files();
    const adapter = copyJobAdapter("no-op", "observed", "copyjob-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("refuses to apply a blocked action (throws at preflight)", async () => {
    const plan = makePlan("blocked", "observed", "copyjob-existing");
    const output = files();
    const adapter = copyJobAdapter("no-op");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        copyJobAdapter: adapter,
        allowCreate: true,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow(/cannot be applied while action is 'blocked'/);

    expect(adapter.create).not.toHaveBeenCalled();
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("recovers an interrupted metadata-only update (PATCH-only path)", async () => {
    // Scenario: PATCH succeeded (description updated), verify was interrupted.
    // Recovery detects: live.observedStateHash differs from approved (PATCH ran)
    // + live.managedMetadataMatches === true + live.stagedDefinitionHash stable
    // → hasCopyJobRecoveryProof branch 2 → re-run update (idempotent PATCH) + verify.
    const approvedPlan = makePlan("update", "before", "copyjob-existing");
    const expectedHash = hashCopyJobDefinition(copyJobDefinition, false);
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    // Bare checkpoint: onUpdateCheckpoint?.() fired before PATCH; no phase.
    checkpoint.pendingUpdates.copyJob = {
      logicalId: "copyJob",
      action: "update",
      physicalId: "copyjob-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    // Live re-plan after PATCH: observedStateHash changed, metadata matches,
    // definition hash unchanged (PATCH doesn't touch definition).
    const adapter = copyJobAdapter(
      "update",
      "after-patch",  // different from approved "before" → skips branch 1
      "copyjob-existing",
      expectedHash,   // matches desired hash → branch 2 fires
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan: makePlan("update", "after-patch", "copyjob-existing"),
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("throws when Copy Job adapter is not initialized for create", async () => {
    const plan = makePlan("create", "absent");
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        // copyJobAdapter intentionally omitted
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Copy Job adapter was not initialized");
  });
});

// ---------------------------------------------------------------------------
// CopyJob deletion — guarded delete path and checkpoint recovery
// ---------------------------------------------------------------------------

/**
 * Absent-state manifest fixture: the item has desiredState: absent so
 * copyJobDefinitions is empty (no copyjob-content.json required) and the
 * item definition carries only displayName + desiredState.
 */
const absentLoaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { copyJob: "content" },
  itemDirectories: { copyJob: "items/copy-jobs/my-job" },
  itemDefinitions: {
    copyJob: { displayName: "MyJob", desiredState: "absent" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  // absent item is NOT in copyJobDefinitions — mirrors manifest.ts behaviour
  copyJobDefinitions: {},
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "delete-copyjob" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "copyJob",
        type: "CopyJob",
        path: "items/copy-jobs/my-job",
        desiredState: "absent",
      },
    ],
  },
};

function makeDeletePlan(
  action: "delete" | "no-op",
): DeploymentPlan {
  const plan = buildPlan(absentLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash:
      action === "delete" ? "a".repeat(64) : sha256(stableJson(null)),
    ...(action === "delete" ? { physicalId: "copyjob-1" } : {}),
  };
  return rehashPlan(plan);
}

function deletionAdapter(
  verifySequence: Array<"unchanged" | "absent"> = [
    "unchanged",
    "absent",
  ],
) {
  let vIdx = 0;
  return {
    // First plan() call: assertFreshItemHasNotDrifted — must return "delete"
    // so the live state matches the approved plan (item still present).
    // Subsequent calls: assertDeletionIdentityIsAbsent — must return "no-op"
    // to confirm the exact identity is truly gone.
    plan: vi
      .fn()
      .mockResolvedValueOnce({
        action: "delete" as const,
        reason: "exists",
        physicalId: "copyjob-1",
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
      },
    ),
    verifyApprovedIdentity: vi.fn(
      async () => verifySequence[vIdx++] ?? "absent",
    ),
  };
}

describe("guarded CopyJob deletion", () => {
  it("blocks deletion when allow-delete is false", async () => {
    const plan = makeDeletePlan("delete");
    const output = files();
    const del = deletionAdapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: absentLoaded,
        lakehouseAdapter: lakehouseAdapter(),
        itemDeletionAdapter: del,
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        ...output,
      }),
    ).rejects.toThrow("allow-delete is false");

    expect(del.delete).not.toHaveBeenCalled();
  });

  it("deletes an approved CopyJob and clears the checkpoint", async () => {
    const plan = makeDeletePlan("delete");
    const output = files();
    const del = deletionAdapter(["unchanged", "absent", "absent"]);

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: absentLoaded,
      lakehouseAdapter: lakehouseAdapter(),
      itemDeletionAdapter: del,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "deleted",
      physicalId: "copyjob-1",
    });
    expect(del.delete).toHaveBeenCalledWith(
      "workspace",
      "copyjob-1",
      expect.any(Function),
    );
    const ckpt = JSON.parse(readFileSync(output.checkpointFile, "utf8"));
    expect(ckpt.pendingDeletes).toEqual({});
    expect(ckpt.completedItems.copyJob).toMatchObject({
      action: "delete",
      physicalId: "copyjob-1",
    });
  });

  it("writes pendingDeletes checkpoint before dispatching the DELETE request", async () => {
    const plan = makeDeletePlan("delete");
    const output = files();
    const verifyStates: Array<"unchanged" | "absent"> = [
      "unchanged",
      "absent",
    ];
    let vIdx = 0;
    const del = {
      plan: vi
        .fn()
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "exists",
          physicalId: "copyjob-1",
          observedStateHash: "a".repeat(64),
        })
        .mockResolvedValue({
          action: "no-op" as const,
          reason: "absent",
          observedStateHash: sha256(stableJson(null)),
        }),
      delete: vi.fn(
        async (
          _wid: string,
          _id: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
          // Inspect the checkpoint synchronously after onDispatch fires.
          const ckpt = JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          );
          expect(ckpt.pendingDeletes.copyJob).toMatchObject({
            action: "delete",
            physicalId: "copyjob-1",
            observedStateHash: "a".repeat(64),
          });
        },
      ),
      verifyApprovedIdentity: vi.fn(
        async () => verifyStates[vIdx++] ?? "absent",
      ),
    };

    await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: absentLoaded,
      lakehouseAdapter: lakehouseAdapter(),
      itemDeletionAdapter: del,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    expect(del.delete).toHaveBeenCalledOnce();
  });

  it("recovers an accepted CopyJob deletion without resubmitting when the exact ID is already absent", async () => {
    const approved = makeDeletePlan("delete");
    const current = makeDeletePlan("no-op");
    const output = files();

    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingDeletes.copyJob = {
      logicalId: "copyJob",
      action: "delete",
      physicalId: "copyjob-1",
      observedStateHash: "a".repeat(64),
      submittedAt: new Date(0).toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    const del = {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "absent",
        observedStateHash: sha256(stableJson(null)),
      })),
      delete: vi.fn(async () => undefined),
      verifyApprovedIdentity: vi.fn(async () => "absent" as const),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: absentLoaded,
      lakehouseAdapter: lakehouseAdapter(),
      itemDeletionAdapter: del,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...output,
    });

    // Deletion was already accepted; no re-dispatch required.
    expect(del.delete).not.toHaveBeenCalled();
    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "resumed",
      physicalId: "copyjob-1",
    });
  });
});
