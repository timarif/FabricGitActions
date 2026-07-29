import { writeCheckpoint } from "./checkpoint";
import type {
  WorkspaceIdentity,
  WorkspaceIdentityAdapter,
  WorkspaceIdentityOperationReference,
  WorkspaceIdentityProvisionRecoveryState,
  WorkspaceRoleAssignmentRecoveryState,
} from "./fabric/workspace-identity";
import { stableJson } from "./hash";
import type {
  ApplyCheckpoint,
  ApplyCheckpointWorkspaceIdentity,
  ApplyWorkspaceIdentityResult,
  ApplyWorkspaceIdentityRoleAssignmentResult,
  DeploymentPlan,
  PlannedWorkspaceIdentityRoleAssignment,
  WorkspaceIdentityDefinition,
} from "./types";

export interface ApplyWorkspaceIdentityOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  desired: WorkspaceIdentityDefinition | undefined;
  adapter?: Pick<
    WorkspaceIdentityAdapter,
    | "provision"
    | "resumeProvision"
    | "verifyIdentity"
    | "createRoleAssignment"
    | "resumeRoleAssignment"
    | "verifyRoleAssignment"
  >;
  checkpoint: ApplyCheckpoint;
  checkpointFile: string;
  allowProvision: boolean;
  allowRoleAssign: boolean;
  now?: () => number;
}

export interface WorkspaceIdentityOutcome {
  result?: ApplyWorkspaceIdentityResult;
  requiresItemReplan: boolean;
}

export function preflightWorkspaceIdentity(
  options: ApplyWorkspaceIdentityOptions,
): void {
  const planned = options.approvedPlan.workspaceIdentity;
  if (!planned) {
    if (options.checkpoint.workspaceIdentity) {
      throw new Error(
        "Checkpoint contains workspace identity state, but the approved plan does not manage a workspace identity.",
      );
    }
    return;
  }
  if (!options.desired || options.desired.provision !== true) {
    throw new Error(
      "The workspace identity definition is missing or does not set provision: true.",
    );
  }
  if (!options.adapter) {
    throw new Error(
      "Workspace identity apply requires a workspace identity adapter.",
    );
  }
  if (planned.action === "blocked" || planned.action === "unknown") {
    throw new Error(
      `Workspace identity cannot be applied while action is '${planned.action}': ${planned.reason}`,
    );
  }

  assertWorkspaceIdentityHasNotDrifted(
    planned,
    options.currentPlan.workspaceIdentity,
    options.checkpoint.workspaceIdentity,
  );
  if (planned.action === "create") {
    if (!options.allowProvision) {
      throw new Error(
        "The approved plan requires workspace identity provisioning, but allow-workspace-identity-provision is false.",
      );
    }
    return;
  }
  preflightRoleAssignments(options);
}

export async function applyWorkspaceIdentity(
  options: ApplyWorkspaceIdentityOptions,
): Promise<WorkspaceIdentityOutcome> {
  preflightWorkspaceIdentity(options);
  const planned = options.approvedPlan.workspaceIdentity;
  if (!planned) {
    return { requiresItemReplan: false };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const pending = options.checkpoint.workspaceIdentity;

  if (planned.action === "create") {
    const identity = await provisionIdentity(
      options,
      pending !== undefined,
      now,
    );
    return {
      result: {
        action: planned.action,
        status: pending ? "resumed" : "created",
        applicationId: identity.applicationId,
        servicePrincipalId: identity.servicePrincipalId,
        roleAssignments: [],
        durationMs: now() - startedAt,
      },
      requiresItemReplan: planned.roleAssignments.length > 0,
    };
  }

  const expectedIdentity = requirePlannedIdentity(options.approvedPlan);
  const identity = await options.adapter!.verifyIdentity(
    options.approvedPlan.workspaceId,
    expectedIdentity,
  );

  const roleAssignments: ApplyWorkspaceIdentityRoleAssignmentResult[] = [];
  for (const assignment of planned.roleAssignments) {
    const assignmentStartedAt = now();
    const desired = {
      workspaceId: assignment.targetWorkspaceId,
      role: assignment.role,
    };
    const checkpointAssignment =
      options.checkpoint.workspaceIdentity?.roleAssignments[
        assignment.targetWorkspaceId
      ];

    if (assignment.action === "no-op") {
      const assignmentId = requireAssignmentId(
        assignment.assignmentId,
        assignment.targetWorkspaceId,
      );
      await options.adapter!.verifyRoleAssignment(
        options.approvedPlan.workspaceId,
        identity,
        desired,
        assignmentId,
      );
      roleAssignments.push({
        targetWorkspaceId: assignment.targetWorkspaceId,
        role: assignment.role,
        assignmentId,
        status: "verified",
        durationMs: now() - assignmentStartedAt,
      });
      continue;
    }

    const applied = checkpointAssignment
      ? await resumeRoleAssignment(
          options,
          identity,
          assignment.targetWorkspaceId,
          assignment.role,
          checkpointAssignment,
          now,
        )
      : await createRoleAssignment(
          options,
          identity,
          assignment.targetWorkspaceId,
          assignment.role,
          now,
        );
    roleAssignments.push({
      targetWorkspaceId: assignment.targetWorkspaceId,
      role: assignment.role,
      assignmentId: applied.id,
      status: checkpointAssignment ? "resumed" : "created",
      durationMs: now() - assignmentStartedAt,
    });
  }

  return {
    result: {
      action: planned.action,
      status:
        planned.action === "no-op"
          ? "verified"
          : pending
            ? "resumed"
            : "updated",
      applicationId: identity.applicationId,
      servicePrincipalId: identity.servicePrincipalId,
      roleAssignments,
      durationMs: now() - startedAt,
    },
    requiresItemReplan: false,
  };
}

async function provisionIdentity(
  options: ApplyWorkspaceIdentityOptions,
  resuming: boolean,
  now: () => number,
): Promise<WorkspaceIdentity> {
  const checkpoint = options.checkpoint.workspaceIdentity?.provision;
  let identity: WorkspaceIdentity;
  if (checkpoint?.phase === "verified") {
    identity = await options.adapter!.verifyIdentity(
      options.approvedPlan.workspaceId,
      {
        applicationId: requireNonBlank(
          checkpoint.applicationId,
          "checkpoint workspace identity application ID",
        ),
        servicePrincipalId: requireNonBlank(
          checkpoint.servicePrincipalId,
          "checkpoint workspace identity service principal ID",
        ),
      },
    );
  } else if (checkpoint) {
    identity = await options.adapter!.resumeProvision(
      options.approvedPlan.workspaceId,
      provisionRecoveryState(checkpoint),
    );
  } else {
    identity = await options.adapter!.provision(
      options.approvedPlan.workspaceId,
      {
        onProvisionSubmitting: () =>
          recordProvisionState(
            options,
            {
              phase: "submitting",
              updatedAt: new Date(now()).toISOString(),
            },
          ),
        onProvisionRejected: () => clearProvisionState(options),
        onProvisionAccepted: (operation) => {
          if (!operation) {
            return;
          }
          recordProvisionState(options, {
            phase: "accepted",
            ...(operation.operationId
              ? { operationId: operation.operationId }
              : {}),
            ...(operation.location
              ? { operationLocation: operation.location }
              : {}),
            updatedAt: new Date(now()).toISOString(),
          });
        },
      },
    );
  }
  recordProvisionState(options, {
    phase: "verified",
    applicationId: identity.applicationId,
    servicePrincipalId: identity.servicePrincipalId,
    updatedAt: new Date(now()).toISOString(),
  });
  if (resuming) {
    return options.adapter!.verifyIdentity(
      options.approvedPlan.workspaceId,
      identity,
    );
  }
  return identity;
}

async function createRoleAssignment(
  options: ApplyWorkspaceIdentityOptions,
  identity: WorkspaceIdentity,
  targetWorkspaceId: string,
  role: ApplyWorkspaceIdentityRoleAssignmentResult["role"],
  now: () => number,
) {
  const desiredHash = requirePlannedRoleDesiredHash(
    options.approvedPlan,
    targetWorkspaceId,
  );
  const desired = { workspaceId: targetWorkspaceId, role };
  const assignment = await options.adapter!.createRoleAssignment(
    options.approvedPlan.workspaceId,
    identity,
    desired,
    {
      onRoleAssignmentSubmitting: () =>
        recordRoleAssignmentState(
          options,
          targetWorkspaceId,
          {
            targetWorkspaceId,
            role,
            desiredHash,
            phase: "submitting",
            updatedAt: new Date(now()).toISOString(),
          },
        ),
      onRoleAssignmentRejected: () =>
        clearRoleAssignmentState(options, targetWorkspaceId),
      onRoleAssignmentAccepted: (assignmentId) =>
        recordRoleAssignmentState(
          options,
          targetWorkspaceId,
          {
            targetWorkspaceId,
            role,
            desiredHash,
            phase: "accepted",
            assignmentId,
            updatedAt: new Date(now()).toISOString(),
          },
        ),
    },
  );
  recordRoleAssignmentState(options, targetWorkspaceId, {
    targetWorkspaceId,
    role,
    desiredHash,
    phase: "verified",
    assignmentId: assignment.id,
    updatedAt: new Date(now()).toISOString(),
  });
  return assignment;
}

async function resumeRoleAssignment(
  options: ApplyWorkspaceIdentityOptions,
  identity: WorkspaceIdentity,
  targetWorkspaceId: string,
  role: ApplyWorkspaceIdentityRoleAssignmentResult["role"],
  checkpoint: NonNullable<
    ApplyCheckpoint["workspaceIdentity"]
  >["roleAssignments"][string],
  now: () => number,
) {
  if (
    checkpoint.targetWorkspaceId !== targetWorkspaceId ||
    checkpoint.role !== role
  ) {
    throw new Error(
      `Workspace identity role checkpoint for '${targetWorkspaceId}' does not match the approved assignment.`,
    );
  }
  if (checkpoint.phase === "verified") {
    return options.adapter!.verifyRoleAssignment(
      options.approvedPlan.workspaceId,
      identity,
      { workspaceId: targetWorkspaceId, role },
      requireAssignmentId(checkpoint.assignmentId, targetWorkspaceId),
    );
  }
  const assignment = await options.adapter!.resumeRoleAssignment(
    options.approvedPlan.workspaceId,
    identity,
    { workspaceId: targetWorkspaceId, role },
    roleRecoveryState(checkpoint),
    {
      onRoleAssignmentAccepted: (assignmentId) =>
        recordRoleAssignmentState(
          options,
          targetWorkspaceId,
          {
            ...checkpoint,
            phase: "accepted",
            assignmentId,
            updatedAt: new Date(now()).toISOString(),
          },
        ),
    },
  );
  recordRoleAssignmentState(options, targetWorkspaceId, {
    ...checkpoint,
    phase: "verified",
    assignmentId: assignment.id,
    updatedAt: new Date(now()).toISOString(),
  });
  return assignment;
}

function preflightRoleAssignments(
  options: ApplyWorkspaceIdentityOptions,
): void {
  for (const assignment of
    options.approvedPlan.workspaceIdentity?.roleAssignments ?? []) {
    if (
      assignment.action === "blocked" ||
      assignment.action === "unknown"
    ) {
      throw new Error(
        `Workspace identity role assignment for '${assignment.targetWorkspaceId}' cannot be applied while action is '${assignment.action}': ${assignment.reason}`,
      );
    }
    if (
      assignment.action === "create" &&
      !options.allowRoleAssign
    ) {
      throw new Error(
        `The approved plan requires a workspace identity role assignment in '${assignment.targetWorkspaceId}', but allow-workspace-identity-role-assign is false.`,
      );
    }
  }
}

function assertWorkspaceIdentityHasNotDrifted(
  approved: NonNullable<DeploymentPlan["workspaceIdentity"]>,
  current: DeploymentPlan["workspaceIdentity"],
  pending: ApplyCheckpointWorkspaceIdentity | undefined,
): void {
  const comparable = (
    identity: DeploymentPlan["workspaceIdentity"],
  ) =>
    identity
      ? {
          action: identity.action,
          observedStateHash: identity.observedStateHash,
          applicationId: identity.applicationId,
          servicePrincipalId: identity.servicePrincipalId,
          roleAssignments: identity.roleAssignments.map(
            (assignment) => ({
              targetWorkspaceId: assignment.targetWorkspaceId,
              role: assignment.role,
              desiredHash: assignment.desiredHash,
              observedStateHash: assignment.observedStateHash,
              assignmentId: assignment.assignmentId,
              action: assignment.action,
            }),
          ),
        }
      : null;
  if (!pending) {
    if (
      stableJson(comparable(approved)) !==
      stableJson(comparable(current))
    ) {
      throwWorkspaceIdentityDrift();
    }
    return;
  }
  if (!current || approved.desiredHash !== current.desiredHash) {
    throwWorkspaceIdentityDrift();
  }

  const approvedAssignments = new Map(
    approved.roleAssignments.map((assignment) => [
      assignment.targetWorkspaceId,
      assignment,
    ]),
  );
  const currentAssignments = new Map(
    current.roleAssignments.map((assignment) => [
      assignment.targetWorkspaceId,
      assignment,
    ]),
  );
  if (approvedAssignments.size !== currentAssignments.size) {
    throwWorkspaceIdentityDrift();
  }
  if (
    !pending.provision &&
    (approved.applicationId !== current.applicationId ||
      approved.servicePrincipalId !== current.servicePrincipalId)
  ) {
    throwWorkspaceIdentityDrift();
  }

  for (const [
    targetWorkspaceId,
    approvedAssignment,
  ] of approvedAssignments) {
    const currentAssignment =
      currentAssignments.get(targetWorkspaceId);
    if (!currentAssignment) {
      throwWorkspaceIdentityDrift();
    }
    const checkpointed =
      pending.provision !== undefined ||
      pending.roleAssignments[targetWorkspaceId] !== undefined;
    const approvedComparable = checkpointed
      ? comparableRoleAssignmentDesired(approvedAssignment)
      : comparableRoleAssignment(approvedAssignment);
    const currentComparable = checkpointed
      ? comparableRoleAssignmentDesired(currentAssignment)
      : comparableRoleAssignment(currentAssignment);
    if (
      stableJson(approvedComparable) !==
      stableJson(currentComparable)
    ) {
      throwWorkspaceIdentityDrift();
    }
  }
}

function comparableRoleAssignmentDesired(
  assignment: PlannedWorkspaceIdentityRoleAssignment,
) {
  return {
    targetWorkspaceId: assignment.targetWorkspaceId,
    role: assignment.role,
    desiredHash: assignment.desiredHash,
  };
}

function comparableRoleAssignment(
  assignment: PlannedWorkspaceIdentityRoleAssignment,
) {
  return {
    ...comparableRoleAssignmentDesired(assignment),
    action: assignment.action,
    assignmentId: assignment.assignmentId,
    observedStateHash: assignment.observedStateHash,
  };
}

function throwWorkspaceIdentityDrift(): never {
  throw new Error(
    "Fabric workspace identity state drifted after approval. Generate a new plan.",
  );
}

function provisionRecoveryState(
  checkpoint: NonNullable<
    ApplyCheckpoint["workspaceIdentity"]
  >["provision"] & {},
): WorkspaceIdentityProvisionRecoveryState {
  if (checkpoint.phase === "submitting") {
    return { phase: "submitting" };
  }
  if (checkpoint.phase !== "accepted") {
    throw new Error(
      `Workspace identity provision checkpoint has incompatible phase '${checkpoint.phase}'.`,
    );
  }
  const operationReference: WorkspaceIdentityOperationReference = {
    ...(checkpoint.operationId
      ? { operationId: checkpoint.operationId }
      : {}),
    ...(checkpoint.operationLocation
      ? { location: checkpoint.operationLocation }
      : {}),
  };
  if (
    !operationReference.operationId &&
    !operationReference.location
  ) {
    throw new Error(
      "Accepted workspace identity provision checkpoint has no operation reference.",
    );
  }
  return { phase: "accepted", operationReference };
}

function roleRecoveryState(
  checkpoint: NonNullable<
    ApplyCheckpoint["workspaceIdentity"]
  >["roleAssignments"][string],
): WorkspaceRoleAssignmentRecoveryState {
  if (checkpoint.phase === "submitting") {
    return { phase: "submitting" };
  }
  if (checkpoint.phase !== "accepted") {
    throw new Error(
      `Workspace identity role checkpoint has incompatible phase '${checkpoint.phase}'.`,
    );
  }
  return {
    phase: "accepted",
    assignmentId: requireAssignmentId(
      checkpoint.assignmentId,
      checkpoint.targetWorkspaceId,
    ),
  };
}

function ensureWorkspaceIdentityCheckpoint(
  options: ApplyWorkspaceIdentityOptions,
): ApplyCheckpointWorkspaceIdentity {
  const existing = options.checkpoint.workspaceIdentity;
  if (existing) {
    return existing;
  }
  const planned = options.approvedPlan.workspaceIdentity;
  if (!planned) {
    throw new Error("Workspace identity plan is missing.");
  }
  const created: ApplyCheckpointWorkspaceIdentity = {
    workspaceId: options.approvedPlan.workspaceId,
    desiredHash: planned.desiredHash,
    roleAssignments: {},
  };
  options.checkpoint.workspaceIdentity = created;
  return created;
}

function recordProvisionState(
  options: ApplyWorkspaceIdentityOptions,
  provision: NonNullable<
    ApplyCheckpoint["workspaceIdentity"]
  >["provision"] & {},
): void {
  ensureWorkspaceIdentityCheckpoint(options).provision = provision;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearProvisionState(
  options: ApplyWorkspaceIdentityOptions,
): void {
  const identity = options.checkpoint.workspaceIdentity;
  if (!identity) {
    return;
  }
  delete identity.provision;
  if (Object.keys(identity.roleAssignments).length === 0) {
    delete options.checkpoint.workspaceIdentity;
  }
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function recordRoleAssignmentState(
  options: ApplyWorkspaceIdentityOptions,
  targetWorkspaceId: string,
  assignment: NonNullable<
    ApplyCheckpoint["workspaceIdentity"]
  >["roleAssignments"][string],
): void {
  ensureWorkspaceIdentityCheckpoint(options).roleAssignments[
    targetWorkspaceId
  ] = assignment;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearRoleAssignmentState(
  options: ApplyWorkspaceIdentityOptions,
  targetWorkspaceId: string,
): void {
  const identity = options.checkpoint.workspaceIdentity;
  if (!identity) {
    return;
  }
  delete identity.roleAssignments[targetWorkspaceId];
  if (
    identity.provision === undefined &&
    Object.keys(identity.roleAssignments).length === 0
  ) {
    delete options.checkpoint.workspaceIdentity;
  }
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function requirePlannedIdentity(
  plan: DeploymentPlan,
): WorkspaceIdentity {
  return {
    applicationId: requireNonBlank(
      plan.workspaceIdentity?.applicationId,
      "planned workspace identity application ID",
    ),
    servicePrincipalId: requireNonBlank(
      plan.workspaceIdentity?.servicePrincipalId,
      "planned workspace identity service principal ID",
    ),
  };
}

function requirePlannedRoleDesiredHash(
  plan: DeploymentPlan,
  targetWorkspaceId: string,
): string {
  const assignment = plan.workspaceIdentity?.roleAssignments.find(
    (candidate) =>
      candidate.targetWorkspaceId === targetWorkspaceId,
  );
  return requireNonBlank(
    assignment?.desiredHash,
    `planned workspace identity role desired hash for '${targetWorkspaceId}'`,
  );
}

function requireAssignmentId(
  assignmentId: string | undefined,
  targetWorkspaceId: string,
): string {
  return requireNonBlank(
    assignmentId,
    `workspace identity role assignment ID for '${targetWorkspaceId}'`,
  );
}

function requireNonBlank(
  value: string | undefined,
  label: string,
): string {
  if (!value || value.trim() === "") {
    throw new Error(`${label} must be nonblank.`);
  }
  return value;
}
