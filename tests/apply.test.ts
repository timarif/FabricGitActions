import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import { FabricOperationFailedError } from "../src/fabric/client";
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
  itemContentHashes: { lakehouse: "content" },
  itemDirectories: { lakehouse: "items/lakehouse" },
  itemDefinitions: {
    lakehouse: { displayName: "Bronze", description: "Desired" },
  },
  environmentDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "lakehouse",
        type: "Lakehouse",
        path: "items/lakehouse",
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
  const root = mkdtempSync(path.join(tmpdir(), "fabric-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function adapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash = plannedAction === "create" ? "absent" : "observed",
  physicalId = "lh-existing",
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
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
        _onCreateRejected?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("lh-created");
        return {
          id: "lh-created",
          displayName: "Bronze",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        _physicalId: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
        _onUpdateRejected?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onMutationAccepted?.("lh-existing");
        return {
          id: "lh-existing",
          displayName: "Bronze",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _operation: { operationId?: string; location?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("lh-created");
        return {
          id: "lh-created",
          displayName: "Bronze",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Bronze",
      description: "Desired",
    })),
  };
}

describe("guarded apply", () => {
  it("requires allow-create before creating a Lakehouse", async () => {
    const plan = makePlan("create", "absent");
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-create is false");

    expect(JSON.parse(readFileSync(output.resultFile, "utf8")).status).toBe(
      "failed",
    );
  });

  it("creates and checkpoints a Lakehouse", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const lakehouseAdapter = adapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(lakehouseAdapter.create).toHaveBeenCalledOnce();
    expect(existsSync(output.checkpointFile)).toBe(true);
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8")).completedItems
        .lakehouse.physicalId,
    ).toBe("lh-created");
  });

  it("updates only when allow-update is enabled", async () => {
    const plan = makePlan("update", "before", "lh-existing");
    const output = files();
    const lakehouseAdapter = adapter("update", "before", "lh-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(lakehouseAdapter.update).toHaveBeenCalledWith(
      "workspace",
      "lh-existing",
      loaded.itemDefinitions.lakehouse,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("blocks updates when allow-update is false", async () => {
    const plan = makePlan("update", "before", "lh-existing");
    const output = files();
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-update is false");

    expect(lakehouseAdapter.update).not.toHaveBeenCalled();
  });

  it("verifies no-op items without mutating them", async () => {
    const plan = makePlan("no-op", "same", "lh-existing");
    const output = files();
    const lakehouseAdapter = adapter("no-op", "same", "lh-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
    expect(lakehouseAdapter.update).not.toHaveBeenCalled();
    expect(lakehouseAdapter.verify).toHaveBeenCalledOnce();
  });

  it("rejects Fabric drift after plan approval", async () => {
    const approved = makePlan("update", "before", "lh-existing");
    const current = makePlan("update", "changed", "lh-existing");
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("Fabric state drifted after approval");
  });

  it("rechecks Fabric state immediately before mutation", async () => {
    const approved = makePlan("update", "before", "lh-existing");
    const output = files();
    const lakehouseAdapter = adapter(
      "update",
      "changed-after-preflight",
      "lh-existing",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("Fabric state drifted after approval");

    expect(lakehouseAdapter.update).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace", { workspaceId: "other-workspace" }],
    ["environment", { environment: "prod" }],
    ["source", { sourceHash: "different-source" }],
    ["commit", { sourceCommit: "commit-2" }],
  ])("rejects a %s mismatch", async (_name, changes) => {
    const approved = makePlan("no-op", "same", "lh-existing");
    const current = rehashPlan({ ...approved, ...changes });
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("approved plan does not match");

    expect(JSON.parse(readFileSync(output.resultFile, "utf8")).status).toBe(
      "failed",
    );
  });

  it("preflights every item before the first mutation", async () => {
    const withUnsupported: LoadedManifest = {
      ...loaded,
      itemContentHashes: {
        ...loaded.itemContentHashes,
        zzzUnsupported: "unsupported",
      },
      itemDirectories: {
        ...loaded.itemDirectories,
        zzzUnsupported: "items/notebook",
      },
      itemDefinitions: {
        ...loaded.itemDefinitions,
        zzzUnsupported: { displayName: "Notebook" },
      },
      manifest: {
        ...loaded.manifest,
        items: [
          ...loaded.manifest.items,
          {
            logicalId: "zzzUnsupported",
            type: "Notebook",
            path: "items/notebook",
          },
        ],
      },
    };
    const approved = buildPlan(withUnsupported, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    approved.items[0] = {
      ...approved.items[0]!,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    };
    const current = rehashPlan(approved);
    const output = files();
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: current,
        currentPlan: current,
        loadedManifest: withUnsupported,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Apply is not implemented");

    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("resumes a completed create by verifying the checkpointed item", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    const firstAdapter = adapter();
    await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: firstAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    const current = makePlan("no-op", "created", "lh-created");
    const secondAdapter = adapter();
    const resumed = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: secondAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(resumed.items[0]?.status).toBe("resumed");
    expect(secondAdapter.create).not.toHaveBeenCalled();
    expect(secondAdapter.verify).toHaveBeenCalledWith(
      "workspace",
      "lh-created",
      loaded.itemDefinitions.lakehouse,
    );
  });

  it("rejects a checkpoint item that does not match the approved plan", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    const checkpoint = {
      schemaVersion: "1",
      deploymentId: approved.deploymentId,
      workspaceId: approved.workspaceId,
      environment: approved.environment,
      planHash: approved.planHash,
      sourceCommit: approved.sourceCommit,
      completedItems: {
        lakehouse: {
          logicalId: "lakehouse",
          action: "update",
          physicalId: "lh-created",
          completedAt: new Date().toISOString(),
        },
      },
    };
    writeFileSync(
      output.checkpointFile,
      JSON.stringify(checkpoint),
      "utf8",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("does not match the approved deployment plan");
  });

  it("rejects apply artifacts inside a deployable item directory", async () => {
    const approved = makePlan("create", "absent");
    const root = mkdtempSync(path.join(tmpdir(), "fabric-apply-path-"));
    const itemDirectory = path.join(root, "items/lakehouse");
    mkdirSync(itemDirectory, { recursive: true });

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: true,
        allowUpdate: false,
        checkpointFile: path.join(itemDirectory, "checkpoint.json"),
        resultFile: path.join(root, "result.json"),
        itemDirectories: [itemDirectory],
      }),
    ).rejects.toThrow(
      "Checkpoint file must not be written inside a deployable item directory",
    );
  });

  it("rejects a shared checkpoint and result path", async () => {
    const approved = makePlan("create", "absent");
    const root = mkdtempSync(path.join(tmpdir(), "fabric-apply-alias-"));
    const artifact = path.join(root, "artifact.json");

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: true,
        allowUpdate: false,
        checkpointFile: artifact,
        resultFile: artifact,
      }),
    ).rejects.toThrow("must not use the same path");
  });

  it("does not treat inherited checkpoint keys as completed items", async () => {
    const constructorLoaded: LoadedManifest = {
      ...loaded,
      itemContentHashes: { constructor: "content" },
      itemDirectories: { constructor: "items/constructor" },
      itemDefinitions: {
        constructor: { displayName: "Constructor Lakehouse" },
      },
      manifest: {
        ...loaded.manifest,
        items: [
          {
            logicalId: "constructor",
            type: "Lakehouse",
            path: "items/constructor",
          },
        ],
      },
    };
    const plan = buildPlan(constructorLoaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    plan.items[0] = {
      ...plan.items[0]!,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(plan);
    const output = files();
    const lakehouseAdapter = adapter();

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: constructorLoaded,
      lakehouseAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(lakehouseAdapter.create).toHaveBeenCalledOnce();
  });

  it("verifies all checkpointed items before any pending mutation", async () => {
    const twoItems: LoadedManifest = {
      ...loaded,
      itemContentHashes: { first: "first", second: "second" },
      itemDirectories: {
        first: "items/first",
        second: "items/second",
      },
      itemDefinitions: {
        first: { displayName: "First" },
        second: { displayName: "Second" },
      },
      manifest: {
        ...loaded.manifest,
        items: [
          { logicalId: "first", type: "Lakehouse", path: "items/first" },
          { logicalId: "second", type: "Lakehouse", path: "items/second" },
        ],
      },
    };
    const plan = buildPlan(twoItems, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    plan.items = plan.items.map((item) => ({
      ...item,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    }));
    const approved = rehashPlan(plan);
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {
          second: {
            logicalId: "second",
            action: "create",
            physicalId: "invalid-second",
            completedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const lakehouseAdapter = adapter();
    lakehouseAdapter.verify.mockRejectedValueOnce(
      new Error("Checkpoint verification failed"),
    );

    const current = rehashPlan({
      ...approved,
      items: approved.items.map((item) =>
        item.logicalId === "second"
          ? {
              ...item,
              action: "no-op",
              reason: "no-op",
              physicalId: "invalid-second",
              observedStateHash: "current-second",
            }
          : item,
      ),
    });

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: twoItems,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Checkpoint verification failed");

    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint whose item is not a current no-op", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            physicalId: "lh-created",
            completedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("is not a no-op");
  });

  it("rejects source changes for a checkpointed item", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            physicalId: "lh-created",
            completedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const current = makePlan("no-op", "current", "lh-created");
    current.items[0] = {
      ...current.items[0]!,
      contentHash: "changed-content",
    };
    const rehashedCurrent = rehashPlan(current);

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: rehashedCurrent,
        loadedManifest: loaded,
        lakehouseAdapter: adapter(),
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Source content changed after approval");
  });

  it("persists a mutation checkpoint before read-back verification fails", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    const failingAdapter = adapter();
    failingAdapter.create.mockImplementationOnce(
      async (_workspace, _desired, onMutationAccepted) => {
        onMutationAccepted?.("lh-created");
        throw new Error("Read-back verification failed");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: failingAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Read-back verification failed");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.completedItems.lakehouse.physicalId).toBe("lh-created");

    const current = makePlan("no-op", "created", "lh-created");
    const resumed = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: adapter(),
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });
    expect(resumed.items[0]?.status).toBe("resumed");
  });

  it("checks checkpoint writability before starting a mutation", async () => {
    const approved = makePlan("create", "absent");
    const root = mkdtempSync(path.join(tmpdir(), "fabric-checkpoint-write-"));
    const blockingFile = path.join(root, "not-a-directory");
    writeFileSync(blockingFile, "blocked", "utf8");
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile: path.join(blockingFile, "checkpoint.json"),
        resultFile: path.join(root, "result.json"),
      }),
    ).rejects.toThrow();

    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("resumes an accepted create operation instead of reissuing it", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const lakehouseAdapter = adapter();

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(lakehouseAdapter.resumeCreate).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.lakehouse,
      { operationId: "operation-1" },
      expect.any(Function),
    );
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("rejects source changes before resuming an accepted operation", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const current = rehashPlan({
      ...approved,
      items: [{ ...approved.items[0]!, contentHash: "changed-content" }],
    });
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Source content changed after approval");

    expect(lakehouseAdapter.resumeCreate).not.toHaveBeenCalled();
  });

  it("reconciles an expired operation from live Lakehouse state", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
        pendingCreates: {},
      }),
      "utf8",
    );
    const lakehouseAdapter = adapter("no-op", "visible", "lh-created");
    lakehouseAdapter.resumeCreate.mockRejectedValueOnce(
      new Error("Operation result expired"),
    );

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
    expect(lakehouseAdapter.verify).toHaveBeenCalled();
  });

  it("clears a terminally failed operation after confirming absence", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
        pendingCreates: {},
        pendingUpdates: {},
      }),
      "utf8",
    );
    const lakehouseAdapter = adapter();
    lakehouseAdapter.resumeCreate.mockRejectedValueOnce(
      new FabricOperationFailedError("Fabric operation failed"),
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Fabric operation failed");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingOperations).toEqual({});
  });

  it("clears a terminal operation during the initial create attempt", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    const lakehouseAdapter = adapter();
    lakehouseAdapter.create.mockImplementationOnce(
      async (
        _workspace,
        _desired,
        _onMutationAccepted,
        onOperationAccepted,
        onCreateSubmitting,
      ) => {
        onCreateSubmitting?.();
        onOperationAccepted?.({ operationId: "operation-1" });
        throw new FabricOperationFailedError("Fabric operation failed");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Fabric operation failed");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingOperations).toEqual({});
  });

  it("fails closed when a submitted create has no operation reference", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {},
        pendingCreates: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            submittedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("has no resumable operation reference");

    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("reconciles a submitted create after the item becomes visible", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: approved.deploymentId,
        workspaceId: approved.workspaceId,
        environment: approved.environment,
        planHash: approved.planHash,
        sourceCommit: approved.sourceCommit,
        completedItems: {},
        pendingOperations: {},
        pendingCreates: {
          lakehouse: {
            logicalId: "lakehouse",
            action: "create",
            submittedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const current = makePlan("no-op", "visible", "lh-created");
    const lakehouseAdapter = adapter("no-op", "visible", "lh-created");

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
    expect(lakehouseAdapter.verify).toHaveBeenCalled();
  });

  it("checks result writability before starting a mutation", async () => {
    const approved = makePlan("create", "absent");
    const root = mkdtempSync(path.join(tmpdir(), "fabric-result-write-"));
    const blockingFile = path.join(root, "not-a-directory");
    writeFileSync(blockingFile, "blocked", "utf8");
    const lakehouseAdapter = adapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile: path.join(root, "checkpoint.json"),
        resultFile: path.join(blockingFile, "result.json"),
      }),
    ).rejects.toThrow();

    expect(lakehouseAdapter.create).not.toHaveBeenCalled();
  });

  it("clears a pending create after a definitive rejection", async () => {
    const approved = makePlan("create", "absent");
    const output = files();
    const lakehouseAdapter = adapter();
    lakehouseAdapter.create.mockImplementationOnce(
      async (
        _workspace,
        _desired,
        _onMutationAccepted,
        _onOperationAccepted,
        onCreateSubmitting,
        onCreateRejected,
      ) => {
        onCreateSubmitting?.();
        onCreateRejected?.();
        throw new Error("Fabric rejected the create");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Fabric rejected the create");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingCreates).toEqual({});
  });

  it("reconciles an ambiguously completed update without reissuing it", async () => {
    const approved = makePlan("update", "before", "lh-existing");
    const output = files();
    const failingAdapter = adapter("update", "before", "lh-existing");
    failingAdapter.update.mockImplementationOnce(
      async (
        _workspace,
        _physicalId,
        _desired,
        _onMutationAccepted,
        onUpdateSubmitting,
      ) => {
        onUpdateSubmitting?.();
        throw new Error("PATCH response was lost");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: failingAdapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("PATCH response was lost");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingUpdates.lakehouse.physicalId).toBe("lh-existing");

    const current = makePlan("no-op", "updated", "lh-existing");
    const resumedAdapter = adapter("no-op", "updated", "lh-existing");
    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: resumedAdapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(resumedAdapter.update).not.toHaveBeenCalled();
  });

  it("clears a pending update after a definitive rejection", async () => {
    const approved = makePlan("update", "before", "lh-existing");
    const output = files();
    const lakehouseAdapter = adapter("update", "before", "lh-existing");
    lakehouseAdapter.update.mockImplementationOnce(
      async (
        _workspace,
        _physicalId,
        _desired,
        _onMutationAccepted,
        onUpdateSubmitting,
        onUpdateRejected,
      ) => {
        onUpdateSubmitting?.();
        onUpdateRejected?.();
        throw new Error("Fabric rejected the update");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("Fabric rejected the update");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.pendingUpdates).toEqual({});
  });
});
