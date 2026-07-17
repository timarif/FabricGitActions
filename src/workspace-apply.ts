import { writeCheckpoint } from "./checkpoint";
import type {
  ApplyCheckpoint,
  ApplyWorkspaceResult,
  DeploymentPlan,
  WorkspaceDefinition,
} from "./types";
import type {
  DesiredWorkspace,
  WorkspaceAdapter,
  WorkspaceCreateRecoveryState,
  WorkspaceLifecycleCallbacks,
  WorkspaceMutationMask,
  WorkspaceUpdateRecoveryState,
} from "./fabric/workspace";

export interface ApplyManagedWorkspaceOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  desired: WorkspaceDefinition | undefined;
  adapter?: Pick<
    WorkspaceAdapter,
    "create" | "resumeCreate" | "update" | "resumeUpdate" | "verify"
  >;
  checkpoint: ApplyCheckpoint;
  checkpointFile: string;
  allowWorkspaceCreate: boolean;
  allowWorkspaceUpdate: boolean;
  allowCapacityAssignment: boolean;
  now?: () => number;
}

export interface ManagedWorkspaceOutcome {
  workspaceId: string;
  result?: ApplyWorkspaceResult;
  requiresItemReplan: boolean;
}

export async function applyManagedWorkspace(
  options: ApplyManagedWorkspaceOptions,
): Promise<ManagedWorkspaceOutcome> {
  const planned = options.approvedPlan.workspace;
  if (!planned) {
    if (options.checkpoint.workspace) {
      throw new Error(
        "Checkpoint contains managed workspace state, but the approved plan does not manage a workspace.",
      );
    }
    return {
      workspaceId: options.approvedPlan.workspaceId,
      requiresItemReplan: false,
    };
  }
  if (!options.desired?.displayName) {
    throw new Error(
      "The managed workspace definition is missing displayName.",
    );
  }
  if (!options.adapter) {
    throw new Error(
      "Managed workspace apply requires a workspace adapter.",
    );
  }
  if (
    planned.action !== "create" &&
    planned.action !== "update" &&
    planned.action !== "no-op"
  ) {
    throw new Error(
      `Managed workspace cannot be applied while action is '${planned.action}'.`,
    );
  }
  assertWorkspaceActionAuthorized(options, planned.action);

  const now = options.now ?? Date.now;
  const startedAt = now();
  const desired = options.desired as DesiredWorkspace;
  const callbacks = workspaceCallbacks(options, planned.action, now);
  const pending = options.checkpoint.workspace;
  if (!pending) {
    assertWorkspaceHasNotDrifted(
      planned,
      options.currentPlan.workspace,
    );
  }

  if (pending) {
    if (
      planned.action === "create" &&
      pending.physicalId &&
      options.currentPlan.workspace?.physicalId &&
      pending.physicalId !==
        options.currentPlan.workspace.physicalId
    ) {
      throw new Error(
        "Workspace create checkpoint physical ID does not match current name discovery.",
      );
    }
    const physicalId = requireCheckpointWorkspaceId(
      pending,
      planned.action,
    );
    const verified =
      pending.state === "completed"
        ? await options.adapter.verify(physicalId, desired)
        : planned.action === "create"
          ? await options.adapter.resumeCreate(
              desired,
              createRecoveryState(pending),
              callbacks,
            )
          : planned.action === "update"
            ? await options.adapter.resumeUpdate(
                physicalId,
                desired,
                updateRecoveryState(pending),
                callbacks,
                workspaceMutationMask(options.approvedPlan),
              )
            : await options.adapter.verify(physicalId, desired);
    completeWorkspace(
      options,
      planned.action,
      verified.id,
      now,
    );
    return {
      workspaceId: verified.id,
      result: {
        action: planned.action,
        status: "resumed",
        physicalId: verified.id,
        durationMs: now() - startedAt,
      },
      requiresItemReplan: planned.action === "create",
    };
  }

  function assertWorkspaceHasNotDrifted(
    approved: NonNullable<DeploymentPlan["workspace"]>,
    current: DeploymentPlan["workspace"],
  ): void {
    const comparable = (
      workspace: DeploymentPlan["workspace"],
    ) =>
      workspace
        ? {
            action: workspace.action,
            physicalId: workspace.physicalId,
            observedStateHash: workspace.observedStateHash,
            metadataUpdateRequired:
              workspace.metadataUpdateRequired,
            capacityAssignmentRequired:
              workspace.capacityAssignmentRequired,
          }
        : null;
    if (
      JSON.stringify(comparable(approved)) !==
      JSON.stringify(comparable(current))
    ) {
      throw new Error(
        "Fabric workspace state drifted after approval. Generate a new plan.",
      );
    }
  }

  const actual =
    planned.action === "create"
      ? await options.adapter.create(desired, callbacks)
      : planned.action === "update"
        ? await updateWorkspace(
            options,
            desired,
            callbacks,
            now,
          )
        : await options.adapter.verify(
            requirePlannedWorkspaceId(options.approvedPlan),
            desired,
          );
  completeWorkspace(
    options,
    planned.action,
    actual.id,
    now,
  );
  return {
    workspaceId: actual.id,
    result: {
      action: planned.action,
      status:
        planned.action === "create"
          ? "created"
          : planned.action === "update"
            ? "updated"
            : "verified",
      physicalId: actual.id,
      durationMs: now() - startedAt,
    },
    requiresItemReplan: planned.action === "create",
  };
}

async function updateWorkspace(
  options: ApplyManagedWorkspaceOptions,
  desired: DesiredWorkspace,
  callbacks: WorkspaceLifecycleCallbacks,
  now: () => number,
) {
  const planned = options.approvedPlan.workspace!;
  const physicalId = requirePlannedWorkspaceId(options.approvedPlan);
  if (
    planned.metadataUpdateRequired !== true &&
    planned.capacityAssignmentRequired !== true &&
    desired.capacityId !== undefined
  ) {
    recordWorkspaceState(
      options,
      "capacity-assignment-accepted",
      physicalId,
      now,
    );
  }
  return options.adapter!.update(
    physicalId,
    desired,
    callbacks,
    workspaceMutationMask(options.approvedPlan),
  );
}

function workspaceMutationMask(
  plan: DeploymentPlan,
): WorkspaceMutationMask {
  return {
    metadataUpdate:
      plan.workspace?.metadataUpdateRequired === true,
    capacityAssignment:
      plan.workspace?.capacityAssignmentRequired === true,
  };
}

function workspaceCallbacks(
  options: ApplyManagedWorkspaceOptions,
  action: "create" | "update" | "no-op",
  now: () => number,
): WorkspaceLifecycleCallbacks {
  let workspaceId =
    options.approvedPlan.workspace?.physicalId ??
    options.desired?.id;
  const metadataUpdateRequired =
    options.approvedPlan.workspace?.metadataUpdateRequired === true;

  return {
    onCreateSubmitting: () =>
      recordWorkspaceState(
        options,
        "create-submitting",
        undefined,
        now,
      ),
    onCreateRejected: () => clearWorkspaceState(options),
    onCreateAccepted: (physicalId) => {
      workspaceId = physicalId;
      recordWorkspaceState(
        options,
        "create-accepted",
        physicalId,
        now,
      );
    },
    onMetadataUpdateSubmitting: () =>
      recordWorkspaceState(
        options,
        "metadata-update-submitting",
        requireRuntimeWorkspaceId(workspaceId),
        now,
      ),
    onMetadataUpdateRejected: () => clearWorkspaceState(options),
    onMetadataUpdateAccepted: (physicalId) => {
      workspaceId = physicalId;
      recordWorkspaceState(
        options,
        "metadata-update-accepted",
        physicalId,
        now,
      );
    },
    onCapacityAssignmentSubmitting: (physicalId) => {
      workspaceId = physicalId;
      recordWorkspaceState(
        options,
        "capacity-assignment-submitting",
        physicalId,
        now,
      );
    },
    onCapacityAssignmentRejected: () => {
      if (action === "create") {
        recordWorkspaceState(
          options,
          "create-accepted",
          requireRuntimeWorkspaceId(workspaceId),
          now,
        );
      } else if (metadataUpdateRequired) {
        recordWorkspaceState(
          options,
          "metadata-update-accepted",
          requireRuntimeWorkspaceId(workspaceId),
          now,
        );
      } else {
        clearWorkspaceState(options);
      }
    },
    onCapacityAssignmentAccepted: (physicalId) => {
      workspaceId = physicalId;
      recordWorkspaceState(
        options,
        "capacity-assignment-accepted",
        physicalId,
        now,
      );
    },
  };
}

function assertWorkspaceActionAuthorized(
  options: ApplyManagedWorkspaceOptions,
  action: "create" | "update" | "no-op",
): void {
  const planned = options.approvedPlan.workspace!;
  if (action === "create" && !options.allowWorkspaceCreate) {
    throw new Error(
      "The approved plan requires workspace creation, but allow-workspace-create is false.",
    );
  }
  if (
    action === "update" &&
    planned.metadataUpdateRequired === true &&
    !options.allowWorkspaceUpdate
  ) {
    throw new Error(
      "The approved plan requires a workspace metadata update, but allow-workspace-update is false.",
    );
  }
  if (
    planned.capacityAssignmentRequired === true &&
    !options.allowCapacityAssignment
  ) {
    throw new Error(
      "The approved plan requires a workspace capacity assignment, but allow-capacity-assignment is false.",
    );
  }
}

function createRecoveryState(
  checkpoint: NonNullable<ApplyCheckpoint["workspace"]>,
): WorkspaceCreateRecoveryState {
  if (
    checkpoint.state !== "create-submitting" &&
    checkpoint.state !== "create-accepted" &&
    checkpoint.state !== "capacity-assignment-submitting" &&
    checkpoint.state !== "capacity-assignment-accepted"
  ) {
    throw new Error(
      `Workspace create checkpoint has incompatible state '${checkpoint.state}'.`,
    );
  }
  return {
    phase: checkpoint.state,
    ...(checkpoint.physicalId
      ? { workspaceId: checkpoint.physicalId }
      : {}),
  };
}

function updateRecoveryState(
  checkpoint: NonNullable<ApplyCheckpoint["workspace"]>,
): WorkspaceUpdateRecoveryState {
  if (
    checkpoint.state !== "metadata-update-submitting" &&
    checkpoint.state !== "metadata-update-accepted" &&
    checkpoint.state !== "capacity-assignment-submitting" &&
    checkpoint.state !== "capacity-assignment-accepted"
  ) {
    throw new Error(
      `Workspace update checkpoint has incompatible state '${checkpoint.state}'.`,
    );
  }
  return { phase: checkpoint.state };
}

function requireCheckpointWorkspaceId(
  checkpoint: NonNullable<ApplyCheckpoint["workspace"]>,
  action: "create" | "update" | "no-op",
): string {
  if (
    action === "create" &&
    checkpoint.state === "create-submitting"
  ) {
    return checkpoint.physicalId ?? "";
  }
  return requireRuntimeWorkspaceId(checkpoint.physicalId);
}

function requirePlannedWorkspaceId(plan: DeploymentPlan): string {
  return requireRuntimeWorkspaceId(plan.workspace?.physicalId);
}

function requireRuntimeWorkspaceId(
  workspaceId: string | undefined,
): string {
  if (!workspaceId) {
    throw new Error(
      "Managed workspace operation requires a physical workspace ID.",
    );
  }
  return workspaceId;
}

function recordWorkspaceState(
  options: ApplyManagedWorkspaceOptions,
  state: NonNullable<ApplyCheckpoint["workspace"]>["state"],
  physicalId: string | undefined,
  now: () => number,
): void {
  const action = options.approvedPlan.workspace?.action;
  if (
    action !== "create" &&
    action !== "update" &&
    action !== "no-op"
  ) {
    throw new Error("Managed workspace action is not checkpointable.");
  }
  options.checkpoint.workspace = {
    action,
    state,
    ...(physicalId ? { physicalId } : {}),
    updatedAt: new Date(now()).toISOString(),
  };
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearWorkspaceState(
  options: ApplyManagedWorkspaceOptions,
): void {
  delete options.checkpoint.workspace;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function completeWorkspace(
  options: ApplyManagedWorkspaceOptions,
  action: "create" | "update" | "no-op",
  workspaceId: string,
  now: () => number,
): void {
  options.checkpoint.workspace = {
    action,
    state: "completed",
    physicalId: workspaceId,
    updatedAt: new Date(now()).toISOString(),
  };
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}
