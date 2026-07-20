import { mkdtempSync, readFileSync } from "node:fs";
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
  LoadedManifest,
  PlannedAction,
} from "../src/types";
import type {
  DesiredWorkspace,
  WorkspaceLifecycleCallbacks,
  WorkspaceMutationMask,
} from "../src/fabric/workspace";
import { applyManagedWorkspace } from "../src/workspace-apply";

const desired: DesiredWorkspace = {
  displayName: "Fabric Deploy Analytics",
  description: "Managed workspace",
  capacityId: "capacity-1",
};

function makePlan(
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op"
  >,
  options: {
    physicalId?: string;
    metadataUpdateRequired?: boolean;
    capacityAssignmentRequired?: boolean;
  } = {},
): DeploymentPlan {
  const loaded: LoadedManifest = {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: {},
    itemDirectories: {},
    itemDefinitions: {},
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: {},
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "workspace-only" },
      workspace: desired,
      items: [],
    },
  };
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  plan.workspace = {
    ...plan.workspace!,
    action,
    reason: action,
    observedStateHash: "observed",
    ...(options.physicalId
      ? { physicalId: options.physicalId }
      : {}),
    ...(options.metadataUpdateRequired === undefined
      ? {}
      : {
          metadataUpdateRequired:
            options.metadataUpdateRequired,
        }),
    ...(options.capacityAssignmentRequired === undefined
      ? {}
      : {
          capacityAssignmentRequired:
            options.capacityAssignmentRequired,
        }),
  };
  if (options.physicalId) {
    plan.workspaceId = options.physicalId;
  }
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-workspace-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function loadedWithLakehouse(): LoadedManifest {
  return {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: { lakehouse: "content" },
    itemDirectories: { lakehouse: "items/lakehouse" },
    itemDefinitions: {
      lakehouse: { displayName: "Bronze" },
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
      metadata: { deploymentId: "managed-workspace" },
      workspace: desired,
      items: [
        {
          logicalId: "lakehouse",
          type: "Lakehouse",
          path: "items/lakehouse",
        },
      ],
    },
  };
}

function adapter() {
  return {
    create: vi.fn(
      async (
        _desired: DesiredWorkspace,
        callbacks: WorkspaceLifecycleCallbacks = {},
      ) => {
        callbacks.onCreateSubmitting?.();
        callbacks.onCreateAccepted?.("workspace-created");
        callbacks.onCapacityAssignmentSubmitting?.(
          "workspace-created",
          "capacity-1",
        );
        callbacks.onCapacityAssignmentAccepted?.(
          "workspace-created",
          "capacity-1",
        );
        return {
          id: "workspace-created",
          displayName: "Fabric Deploy Analytics",
          type: "Workspace" as const,
          description: "Managed workspace",
          capacityId: "capacity-1",
          capacityAssignmentProgress: "Completed" as const,
        };
      },
    ),
    resumeCreate: vi.fn(async () => ({
      id: "workspace-created",
      displayName: "Fabric Deploy Analytics",
      type: "Workspace" as const,
      description: "Managed workspace",
      capacityId: "capacity-1",
      capacityAssignmentProgress: "Completed" as const,
    })),
    update: vi.fn(
      async (
        workspaceId: string,
        _desired: DesiredWorkspace,
        callbacks: WorkspaceLifecycleCallbacks = {},
        _mutationMask?: WorkspaceMutationMask,
      ) => {
        callbacks.onMetadataUpdateSubmitting?.();
        callbacks.onMetadataUpdateAccepted?.(workspaceId);
        return {
          id: workspaceId,
          displayName: "Fabric Deploy Analytics",
          type: "Workspace" as const,
          description: "Managed workspace",
          capacityId: "capacity-1",
          capacityAssignmentProgress: "Completed" as const,
        };
      },
    ),
    resumeUpdate: vi.fn(
      async (workspaceId: string) => ({
        id: workspaceId,
        displayName: "Fabric Deploy Analytics",
        type: "Workspace" as const,
        description: "Managed workspace",
        capacityId: "capacity-1",
        capacityAssignmentProgress: "Completed" as const,
      }),
    ),
    verify: vi.fn(async (workspaceId: string) => ({
      id: workspaceId,
      displayName: "Fabric Deploy Analytics",
      type: "Workspace" as const,
      description: "Managed workspace",
      capacityId: "capacity-1",
      capacityAssignmentProgress: "Completed" as const,
    })),
  };
}

describe("managed workspace apply", () => {
  it("creates, checkpoints, and requires an item replan", async () => {
    const plan = makePlan("create", {
      capacityAssignmentRequired: true,
    });
    const output = files();
    const checkpoint = createCheckpoint(plan);
    writeCheckpoint(output.checkpointFile, checkpoint);

    const outcome = await applyManagedWorkspace({
      approvedPlan: plan,
      currentPlan: plan,
      desired,
      adapter: adapter(),
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowWorkspaceCreate: true,
      allowWorkspaceUpdate: false,
      allowCapacityAssignment: true,
    });

    expect(outcome).toMatchObject({
      workspaceId: "workspace-created",
      requiresItemReplan: true,
      result: { status: "created" },
    });
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).workspace,
    ).toMatchObject({
      action: "create",
      state: "completed",
      physicalId: "workspace-created",
    });
  });

  it("requires independent workspace and capacity authorization", async () => {
    const plan = makePlan("create", {
      capacityAssignmentRequired: true,
    });
    const output = files();
    const checkpoint = createCheckpoint(plan);

    await expect(
      applyManagedWorkspace({
        approvedPlan: plan,
        currentPlan: plan,
        desired,
        adapter: adapter(),
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowWorkspaceCreate: false,
        allowWorkspaceUpdate: false,
        allowCapacityAssignment: true,
      }),
    ).rejects.toThrow("allow-workspace-create is false");

    await expect(
      applyManagedWorkspace({
        approvedPlan: plan,
        currentPlan: plan,
        desired,
        adapter: adapter(),
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowWorkspaceCreate: true,
        allowWorkspaceUpdate: false,
        allowCapacityAssignment: false,
      }),
    ).rejects.toThrow("allow-capacity-assignment is false");
  });

  it("resumes a create from its checkpoint without calling create", async () => {
    const plan = makePlan("create");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.workspace = {
      action: "create",
      state: "create-submitting",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const workspaceAdapter = adapter();

    const outcome = await applyManagedWorkspace({
      approvedPlan: plan,
      currentPlan: plan,
      desired: { displayName: desired.displayName },
      adapter: workspaceAdapter,
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowWorkspaceCreate: true,
      allowWorkspaceUpdate: false,
      allowCapacityAssignment: false,
    });

    expect(outcome.result?.status).toBe("resumed");
    expect(workspaceAdapter.resumeCreate).toHaveBeenCalledOnce();
    expect(workspaceAdapter.create).not.toHaveBeenCalled();
  });

  it("updates metadata only with workspace update authorization", async () => {
    const plan = makePlan("update", {
      physicalId: "workspace-1",
      metadataUpdateRequired: true,
      capacityAssignmentRequired: false,
    });
    const output = files();
    const checkpoint = createCheckpoint(plan);
    const workspaceAdapter = adapter();

    const outcome = await applyManagedWorkspace({
      approvedPlan: plan,
      currentPlan: plan,
      desired,
      adapter: workspaceAdapter,
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowWorkspaceCreate: false,
      allowWorkspaceUpdate: true,
      allowCapacityAssignment: false,
    });

    expect(outcome.result?.status).toBe("updated");
    expect(workspaceAdapter.update).toHaveBeenCalledOnce();
    expect(workspaceAdapter.update.mock.calls[0]?.[3]).toEqual({
      metadataUpdate: true,
      capacityAssignment: false,
    });
  });

  it("allows capacity-only updates without metadata authorization", async () => {
    const plan = makePlan("update", {
      physicalId: "workspace-1",
      metadataUpdateRequired: false,
      capacityAssignmentRequired: true,
    });
    const output = files();
    const checkpoint = createCheckpoint(plan);

    const workspaceAdapter = adapter();
    await expect(
      applyManagedWorkspace({
        approvedPlan: plan,
        currentPlan: plan,
        desired,
        adapter: workspaceAdapter,
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowWorkspaceCreate: false,
        allowWorkspaceUpdate: false,
        allowCapacityAssignment: true,
      }),
    ).resolves.toMatchObject({
      workspaceId: "workspace-1",
      requiresItemReplan: false,
    });
    expect(workspaceAdapter.update.mock.calls[0]?.[3]).toEqual({
      metadataUpdate: false,
      capacityAssignment: true,
    });
  });

  it("verifies a no-op managed workspace", async () => {
    const plan = makePlan("no-op", {
      physicalId: "workspace-1",
      metadataUpdateRequired: false,
      capacityAssignmentRequired: false,
    });
    const output = files();
    const checkpoint = createCheckpoint(plan);
    const workspaceAdapter = adapter();

    const outcome = await applyManagedWorkspace({
      approvedPlan: plan,
      currentPlan: plan,
      desired,
      adapter: workspaceAdapter,
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowWorkspaceCreate: false,
      allowWorkspaceUpdate: false,
      allowCapacityAssignment: false,
    });

    expect(outcome).toMatchObject({
      workspaceId: "workspace-1",
      requiresItemReplan: false,
      result: { status: "verified" },
    });
    expect(workspaceAdapter.verify).toHaveBeenCalledOnce();
  });

  it("provisions a missing workspace without mutating blocked child items", async () => {
    const loaded = loadedWithLakehouse();
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    plan.workspace = {
      ...plan.workspace!,
      action: "create",
      reason: "missing",
      observedStateHash: "absent",
      capacityAssignmentRequired: true,
    };
    plan.items[0] = {
      ...plan.items[0]!,
      action: "blocked",
      reason: "workspace bootstrap",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(plan);
    const output = files();
    const fail = vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    });

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      workspaceAdapter: adapter(),
      lakehouseAdapter: {
        plan: fail,
        create: fail,
        update: fail,
        resumeCreate: fail,
        verify: fail,
      },
      allowCreate: true,
      allowUpdate: false,
      allowWorkspaceCreate: true,
      allowWorkspaceUpdate: false,
      allowCapacityAssignment: true,
      ...output,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      workspaceId: "workspace-created",
      requiresItemReplan: true,
      workspace: { status: "created" },
      items: [],
    });
    expect(fail).not.toHaveBeenCalled();
  });

  it("deploys child items into the resolved managed workspace", async () => {
    const loaded = loadedWithLakehouse();
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    plan.workspaceId = "workspace-1";
    plan.workspace = {
      ...plan.workspace!,
      action: "no-op",
      reason: "matches",
      physicalId: "workspace-1",
      observedStateHash: "workspace-state",
      metadataUpdateRequired: false,
      capacityAssignmentRequired: false,
    };
    plan.items[0] = {
      ...plan.items[0]!,
      action: "create",
      reason: "missing",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(plan);
    const output = files();
    const create = vi.fn(
      async (
        workspaceId: string,
        _desired: { displayName: string },
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: unknown) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("lakehouse-created");
        return {
          id: "lakehouse-created",
          displayName: "Bronze",
          type: "Lakehouse" as const,
        };
      },
    );
    const planLakehouse = vi.fn(async (workspaceId: string) => ({
      action: "create" as const,
      reason: workspaceId,
      observedStateHash: "absent",
    }));

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      workspaceAdapter: adapter(),
      lakehouseAdapter: {
        plan: planLakehouse,
        create,
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(),
      },
      allowCreate: true,
      allowUpdate: false,
      allowWorkspaceCreate: false,
      allowWorkspaceUpdate: false,
      allowCapacityAssignment: false,
      ...output,
    });

    expect(result.workspaceId).toBe("workspace-1");
    expect(result.items[0]?.status).toBe("created");
    expect(create.mock.calls[0]?.[0]).toBe("workspace-1");
  });
});
