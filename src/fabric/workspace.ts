import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "../hash";
import type {
  PlannedAction,
  WorkspaceDefinition,
} from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

export type WorkspaceType =
  | "Workspace"
  | "Personal"
  | "AdminWorkspace"
  | (string & {});

export type CapacityAssignmentProgress =
  | "Completed"
  | "Failed"
  | "InProgress"
  | (string & {});

export interface WorkspaceAppliedTag {
  id: string;
  displayName: string;
}

export interface Workspace {
  id: string;
  displayName: string;
  description?: string;
  type: WorkspaceType;
  capacityId?: string;
  domainId?: string;
  capacityRegion?: string;
  tags?: WorkspaceAppliedTag[];
  apiEndpoint?: string;
}

export interface WorkspaceInfo extends Workspace {
  capacityAssignmentProgress?: CapacityAssignmentProgress;
  workspaceIdentity?: {
    applicationId?: string;
    servicePrincipalId?: string;
  };
  oneLakeEndpoints?: {
    blobEndpoint?: string;
    dfsEndpoint?: string;
  };
}

export type DesiredWorkspace = WorkspaceDefinition & {
  displayName: string;
};

export interface WorkspacePlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  managedMetadataMatches: boolean;
  capacityAssignmentRequired: boolean;
  capacityAssignmentProgress?: CapacityAssignmentProgress;
}

export interface WorkspaceLifecycleCallbacks {
  onCreateSubmitting?: () => void;
  onCreateRejected?: () => void;
  onCreateAccepted?: (workspaceId: string) => void;
  onMetadataUpdateSubmitting?: () => void;
  onMetadataUpdateRejected?: () => void;
  onMetadataUpdateAccepted?: (workspaceId: string) => void;
  onCapacityAssignmentSubmitting?: (
    workspaceId: string,
    capacityId: string,
  ) => void;
  onCapacityAssignmentRejected?: () => void;
  onCapacityAssignmentAccepted?: (
    workspaceId: string,
    capacityId: string,
  ) => void;
}

export interface WorkspaceCreateRecoveryState {
  workspaceId?: string;
  phase:
    | "create-submitting"
    | "create-accepted"
    | "capacity-assignment-submitting"
    | "capacity-assignment-accepted";
}

export interface WorkspaceUpdateRecoveryState {
  phase:
    | "metadata-update-submitting"
    | "metadata-update-accepted"
    | "capacity-assignment-submitting"
    | "capacity-assignment-accepted";
}

export interface WorkspaceMutationMask {
  metadataUpdate: boolean;
  capacityAssignment: boolean;
}

export interface WorkspaceAdapterOptions {
  capacityAssignmentTimeoutMs?: number;
  capacityAssignmentPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface RequiredWorkspaceAdapterOptions {
  capacityAssignmentTimeoutMs: number;
  capacityAssignmentPollIntervalMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
}

export class WorkspaceAdapter {
  private readonly options: RequiredWorkspaceAdapterOptions;

  constructor(
    private readonly client: FabricClient,
    options: WorkspaceAdapterOptions = {},
  ) {
    this.options = {
      capacityAssignmentTimeoutMs:
        options.capacityAssignmentTimeoutMs ?? 20 * 60 * 1000,
      capacityAssignmentPollIntervalMs:
        options.capacityAssignmentPollIntervalMs ?? 5000,
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
          })),
      now: options.now ?? Date.now,
    };
    if (this.options.capacityAssignmentTimeoutMs < 0) {
      throw new Error("Capacity assignment timeout cannot be negative.");
    }
    if (this.options.capacityAssignmentPollIntervalMs <= 0) {
      throw new Error(
        "Capacity assignment polling interval must be greater than zero.",
      );
    }
  }

  async list(): Promise<Workspace[]> {
    return this.client.listAll<Workspace>("/v1/workspaces");
  }

  async get(workspaceId: string): Promise<WorkspaceInfo> {
    assertNonBlankId(workspaceId, "workspace ID");
    const response = await this.client.request<WorkspaceInfo>(
      "GET",
      workspacePath(workspaceId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Workspace response is empty.");
    }
    assertNonBlankId(response.body.id, "Fabric workspace response ID");
    return response.body;
  }

  async plan(desired: DesiredWorkspace): Promise<WorkspacePlanResult> {
    assertValidDesiredWorkspace(desired);

    let existing: WorkspaceInfo | undefined;
    if (desired.id !== undefined) {
      try {
        existing = await this.get(desired.id);
      } catch (error) {
        if (error instanceof FabricApiError && error.status === 404) {
          return {
            action: "blocked",
            reason: `Explicit workspace ID '${desired.id}' was not found; the adapter will not adopt or create a workspace by name.`,
            physicalId: desired.id,
            observedStateHash: sha256(stableJson(null)),
            managedMetadataMatches: false,
            capacityAssignmentRequired: desired.capacityId !== undefined,
          };
        }
        throw error;
      }
    } else {
      const discovery = await this.discoverByDisplayName(desired.displayName);
      if (discovery.blocked) {
        return blockedPlanResult(
          discovery.reason,
          discovery.collisions,
          desired,
        );
      }
      if (!discovery.workspace) {
        return {
          action: "create",
          reason: `Workspace '${desired.displayName}' does not exist among workspaces accessible to the caller.`,
          observedStateHash: sha256(stableJson(null)),
          managedMetadataMatches: false,
          capacityAssignmentRequired: desired.capacityId !== undefined,
        };
      }
      existing = await this.get(discovery.workspace.id);
    }

    return planExistingWorkspace(existing, desired);
  }

  async create(
    desired: DesiredWorkspace,
    callbacks: WorkspaceLifecycleCallbacks = {},
  ): Promise<WorkspaceInfo> {
    assertValidDesiredWorkspace(desired);
    if (desired.id !== undefined) {
      throw new Error(
        "A workspace with an explicit ID cannot be created; the ID is authoritative.",
      );
    }

    const body: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }

    let response: FabricResponse<Workspace>;
    try {
      response = await this.client.request<Workspace>(
        "POST",
        "/v1/workspaces",
        {
          body,
          retryable: false,
          acceptedStatuses: [201],
          onDispatch: callbacks.onCreateSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onCreateRejected?.();
      }
      throw error;
    }

    const workspaceId = response.body?.id;
    assertNonBlankId(
      workspaceId,
      "Fabric Create Workspace response workspace ID",
    );
    callbacks.onCreateAccepted?.(workspaceId);

    if (desired.capacityId !== undefined) {
      await this.assignCapacity(
        workspaceId,
        desired.capacityId,
        callbacks,
      );
    }
    return this.verify(workspaceId, desired);
  }

  async resumeCreate(
    desired: DesiredWorkspace,
    recovery: WorkspaceCreateRecoveryState,
    callbacks: WorkspaceLifecycleCallbacks = {},
  ): Promise<WorkspaceInfo> {
    assertValidDesiredWorkspace(desired);
    if (
      desired.id !== undefined &&
      recovery.workspaceId !== undefined &&
      desired.id !== recovery.workspaceId
    ) {
      throw new Error(
        `Workspace create recovery ID '${recovery.workspaceId}' does not match desired ID '${desired.id}'.`,
      );
    }

    const workspaceId =
      recovery.workspaceId ??
      desired.id ??
      (await this.requireUniqueWorkspaceForResume(desired.displayName)).id;
    const current = await this.get(workspaceId);
    assertManageableWorkspace(current);
    assertManagedMetadataMatches(current, desired, "create recovery");

    if (desired.capacityId === undefined) {
      return this.verify(workspaceId, desired);
    }

    if (
      recovery.phase === "capacity-assignment-submitting" ||
      recovery.phase === "capacity-assignment-accepted"
    ) {
      if (current.capacityAssignmentProgress === "InProgress") {
        await this.pollCapacityAssignment(
          workspaceId,
          desired.capacityId,
          true,
        );
      } else if (
        current.capacityAssignmentProgress !== "Completed" ||
        current.capacityId !== desired.capacityId
      ) {
        throw new Error(
          `Workspace '${desired.displayName}' capacity assignment has an ambiguous recovery state; it will not be redispatched.`,
        );
      }
      return this.verify(workspaceId, desired);
    }

    await this.ensureDesiredCapacity(
      current,
      desired.capacityId,
      callbacks,
      true,
    );
    return this.verify(workspaceId, desired);
  }

  async update(
    workspaceId: string,
    desired: DesiredWorkspace,
    callbacks: WorkspaceLifecycleCallbacks = {},
    mutationMask: WorkspaceMutationMask = {
      metadataUpdate: true,
      capacityAssignment: true,
    },
  ): Promise<WorkspaceInfo> {
    assertValidDesiredWorkspace(desired);
    assertWorkspaceIdMatchesDesired(workspaceId, desired);

    let current = await this.get(workspaceId);
    assertManageableWorkspace(current);

    const metadataBody = differingMetadata(current, desired);
    if (Object.keys(metadataBody).length > 0) {
      if (!mutationMask.metadataUpdate) {
        throw new Error(
          `Workspace '${desired.displayName}' has metadata drift that was not approved for update.`,
        );
      }
      try {
        await this.client.request<Workspace>(
          "PATCH",
          workspacePath(workspaceId),
          {
            body: metadataBody,
            retryable: false,
            acceptedStatuses: [200],
            onDispatch: callbacks.onMetadataUpdateSubmitting,
          },
        );
      } catch (error) {
        if (isDefinitiveRejection(error)) {
          callbacks.onMetadataUpdateRejected?.();
        }
        throw error;
      }
      callbacks.onMetadataUpdateAccepted?.(workspaceId);
      current = await this.get(workspaceId);
      assertManageableWorkspace(current);
    }

    if (desired.capacityId !== undefined) {
      await this.ensureDesiredCapacity(
        current,
        desired.capacityId,
        callbacks,
        mutationMask.capacityAssignment,
      );
    }
    return this.verify(workspaceId, desired);
  }

  async resumeUpdate(
    workspaceId: string,
    desired: DesiredWorkspace,
    recovery: WorkspaceUpdateRecoveryState,
    callbacks: WorkspaceLifecycleCallbacks = {},
    mutationMask: WorkspaceMutationMask = {
      metadataUpdate: true,
      capacityAssignment: true,
    },
  ): Promise<WorkspaceInfo> {
    assertValidDesiredWorkspace(desired);
    assertWorkspaceIdMatchesDesired(workspaceId, desired);
    const current = await this.get(workspaceId);
    assertManageableWorkspace(current);

    if (
      (recovery.phase === "metadata-update-submitting" ||
        recovery.phase === "metadata-update-accepted") &&
      !managedMetadataMatches(current, desired)
    ) {
      throw new Error(
        `Workspace '${desired.displayName}' metadata update has an ambiguous recovery state; it will not be redispatched.`,
      );
    }

    if (
      recovery.phase === "capacity-assignment-submitting" ||
      recovery.phase === "capacity-assignment-accepted"
    ) {
      if (desired.capacityId === undefined) {
        throw new Error(
          "Workspace capacity recovery requires a desired capacity ID.",
        );
      }
      if (current.capacityAssignmentProgress === "InProgress") {
        await this.pollCapacityAssignment(
          workspaceId,
          desired.capacityId,
          true,
        );
      } else if (
        current.capacityAssignmentProgress !== "Completed" ||
        current.capacityId !== desired.capacityId
      ) {
        throw new Error(
          `Workspace '${desired.displayName}' capacity assignment has an ambiguous recovery state; it will not be redispatched.`,
        );
      }
      return this.verify(workspaceId, desired);
    }

    return this.update(
      workspaceId,
      desired,
      callbacks,
      mutationMask,
    );
  }

  async verify(
    workspaceId: string,
    desired: DesiredWorkspace,
  ): Promise<WorkspaceInfo> {
    assertValidDesiredWorkspace(desired);
    assertWorkspaceIdMatchesDesired(workspaceId, desired);
    const actual = await this.get(workspaceId);
    if (actual.id !== workspaceId) {
      throw new Error(
        `Workspace verification failed: expected ID '${workspaceId}', received '${actual.id}'.`,
      );
    }
    assertManageableWorkspace(actual);
    assertManagedMetadataMatches(actual, desired, "verification");

    if (desired.capacityId !== undefined) {
      if (
        actual.capacityId !== desired.capacityId ||
        actual.capacityAssignmentProgress !== "Completed"
      ) {
        throw new Error(
          `Workspace '${desired.displayName}' verification failed for capacity assignment: expected '${desired.capacityId}' with progress 'Completed', received '${actual.capacityId ?? "unassigned"}' with progress '${actual.capacityAssignmentProgress ?? "unknown"}'.`,
        );
      }
    }
    return actual;
  }

  private async discoverByDisplayName(
    displayName: string,
  ): Promise<
    | { blocked: false; workspace?: Workspace }
    | {
        blocked: true;
        reason: string;
        collisions: Workspace[];
      }
  > {
    const workspaces = await this.list();
    const exactMatches = workspaces.filter(
      (workspace) => workspace.displayName === displayName,
    );
    const foldedName = displayName.toLowerCase();
    const caseInsensitiveMatches = workspaces.filter(
      (workspace) => workspace.displayName.toLowerCase() === foldedName,
    );

    if (caseInsensitiveMatches.length !== exactMatches.length) {
      return {
        blocked: true,
        reason: `Workspace '${displayName}' has a case-insensitive name collision.`,
        collisions: caseInsensitiveMatches,
      };
    }
    if (exactMatches.length > 1) {
      return {
        blocked: true,
        reason: `Multiple accessible workspaces named '${displayName}' were found.`,
        collisions: exactMatches,
      };
    }

    const exact = exactMatches[0];
    if (!exact) {
      return { blocked: false };
    }
    if (exact.type !== "Workspace") {
      return {
        blocked: true,
        reason: `Workspace name '${displayName}' resolves to unsupported type '${exact.type ?? "unknown"}'.`,
        collisions: exactMatches,
      };
    }
    return { blocked: false, workspace: exact };
  }

  private async requireUniqueWorkspaceForResume(
    displayName: string,
  ): Promise<Workspace> {
    const discovery = await this.discoverByDisplayName(displayName);
    if (discovery.blocked) {
      throw new Error(discovery.reason);
    }
    if (!discovery.workspace) {
      throw new Error(
        `Workspace create outcome is ambiguous and no accessible workspace named '${displayName}' was found; create will not be retried.`,
      );
    }
    return discovery.workspace;
  }

  private async ensureDesiredCapacity(
    current: WorkspaceInfo,
    desiredCapacityId: string,
    callbacks: WorkspaceLifecycleCallbacks,
    allowFreshAssignment: boolean,
  ): Promise<WorkspaceInfo> {
    if (current.capacityId === desiredCapacityId) {
      switch (current.capacityAssignmentProgress) {
        case "Completed":
          return current;
        case "InProgress":
          return this.pollCapacityAssignment(
            current.id,
            desiredCapacityId,
            false,
          );
        case "Failed":
          throw new Error(
            `Workspace '${current.displayName}' capacity assignment is in Failed state for desired capacity '${desiredCapacityId}'.`,
          );
        default:
          throw new Error(
            `Workspace '${current.displayName}' has unknown capacity assignment progress '${current.capacityAssignmentProgress ?? "undefined"}' for desired capacity '${desiredCapacityId}'.`,
          );
      }
    }

    if (current.capacityAssignmentProgress === "InProgress") {
      throw new Error(
        `Workspace '${current.displayName}' has an in-progress assignment for capacity '${current.capacityId ?? "unknown"}'; assignment to '${desiredCapacityId}' will not be dispatched.`,
      );
    }
    if (!allowFreshAssignment) {
      throw new Error(
        `Workspace '${current.displayName}' requires a fresh assignment to capacity '${desiredCapacityId}', but redispatch is not allowed.`,
      );
    }
    return this.assignCapacity(current.id, desiredCapacityId, callbacks);
  }

  private async assignCapacity(
    workspaceId: string,
    capacityId: string,
    callbacks: WorkspaceLifecycleCallbacks,
  ): Promise<WorkspaceInfo> {
    assertNonBlankId(workspaceId, "workspace ID");
    assertNonBlankId(capacityId, "capacity ID");
    try {
      await this.client.request<unknown>(
        "POST",
        `${workspacePath(workspaceId)}/assignToCapacity`,
        {
          body: { capacityId },
          retryable: false,
          acceptedStatuses: [202],
          onDispatch: () =>
            callbacks.onCapacityAssignmentSubmitting?.(
              workspaceId,
              capacityId,
            ),
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onCapacityAssignmentRejected?.();
      }
      throw error;
    }
    callbacks.onCapacityAssignmentAccepted?.(workspaceId, capacityId);
    return this.pollCapacityAssignment(workspaceId, capacityId, true);
  }

  private async pollCapacityAssignment(
    workspaceId: string,
    desiredCapacityId: string,
    allowDifferentCapacityWhileInProgress: boolean,
  ): Promise<WorkspaceInfo> {
    const deadline =
      this.options.now() + this.options.capacityAssignmentTimeoutMs;

    while (true) {
      const current = await this.get(workspaceId);
      switch (current.capacityAssignmentProgress) {
        case "Completed":
          if (current.capacityId !== desiredCapacityId) {
            throw new Error(
              `Workspace '${current.displayName}' capacity assignment completed on '${current.capacityId ?? "unassigned"}', not desired capacity '${desiredCapacityId}'.`,
            );
          }
          return current;
        case "Failed":
          throw new Error(
            `Workspace '${current.displayName}' capacity assignment to '${desiredCapacityId}' failed.`,
          );
        case "InProgress":
          if (
            !allowDifferentCapacityWhileInProgress &&
            current.capacityId !== desiredCapacityId
          ) {
            throw new Error(
              `Workspace '${current.displayName}' has an in-progress assignment that cannot be verified as targeting '${desiredCapacityId}'.`,
            );
          }
          break;
        default:
          throw new Error(
            `Workspace '${current.displayName}' returned unknown capacity assignment progress '${current.capacityAssignmentProgress ?? "undefined"}'.`,
          );
      }

      const remaining = deadline - this.options.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for workspace '${current.displayName}' capacity assignment to '${desiredCapacityId}'.`,
        );
      }
      await this.options.sleep(
        Math.min(
          this.options.capacityAssignmentPollIntervalMs,
          remaining,
        ),
      );
    }
  }
}

export function hashObservedWorkspace(workspace: Workspace): string {
  return sha256(stableJson(canonicalObservedWorkspace(workspace)));
}

function planExistingWorkspace(
  existing: WorkspaceInfo,
  desired: DesiredWorkspace,
): WorkspacePlanResult {
  const observedStateHash = hashObservedWorkspace(existing);
  if (existing.type !== "Workspace") {
    return {
      action: "blocked",
      reason: `Workspace '${desired.displayName}' resolves to unsupported type '${existing.type ?? "unknown"}'.`,
      physicalId: existing.id,
      observedStateHash,
      managedMetadataMatches: false,
      capacityAssignmentRequired: false,
      ...(existing.capacityAssignmentProgress !== undefined
        ? { capacityAssignmentProgress: existing.capacityAssignmentProgress }
        : {}),
    };
  }

  const metadataMatches = managedMetadataMatches(existing, desired);
  const capacity = planCapacity(existing, desired.capacityId);
  if (capacity.blockedReason) {
    return {
      action: "blocked",
      reason: capacity.blockedReason,
      physicalId: existing.id,
      observedStateHash,
      managedMetadataMatches: metadataMatches,
      capacityAssignmentRequired: capacity.assignmentRequired,
      ...(existing.capacityAssignmentProgress !== undefined
        ? { capacityAssignmentProgress: existing.capacityAssignmentProgress }
        : {}),
    };
  }

  const updateRequired =
    !metadataMatches ||
    capacity.assignmentRequired ||
    capacity.pollRequired;
  return {
    action: updateRequired ? "update" : "no-op",
    reason: updateRequired
      ? workspaceUpdateReason(existing, metadataMatches, capacity)
      : `Workspace '${desired.displayName}' matches all managed properties.`,
    physicalId: existing.id,
    observedStateHash,
    managedMetadataMatches: metadataMatches,
    capacityAssignmentRequired: capacity.assignmentRequired,
    ...(existing.capacityAssignmentProgress !== undefined
      ? { capacityAssignmentProgress: existing.capacityAssignmentProgress }
      : {}),
  };
}

function planCapacity(
  existing: WorkspaceInfo,
  desiredCapacityId: string | undefined,
): {
  assignmentRequired: boolean;
  pollRequired: boolean;
  blockedReason?: string;
} {
  if (desiredCapacityId === undefined) {
    return { assignmentRequired: false, pollRequired: false };
  }
  if (existing.capacityId === desiredCapacityId) {
    switch (existing.capacityAssignmentProgress) {
      case "Completed":
        return { assignmentRequired: false, pollRequired: false };
      case "InProgress":
        return { assignmentRequired: false, pollRequired: true };
      case "Failed":
        return {
          assignmentRequired: false,
          pollRequired: false,
          blockedReason: `Workspace '${existing.displayName}' has Failed capacity assignment progress for desired capacity '${desiredCapacityId}'.`,
        };
      default:
        return {
          assignmentRequired: false,
          pollRequired: false,
          blockedReason: `Workspace '${existing.displayName}' has unknown capacity assignment progress '${existing.capacityAssignmentProgress ?? "undefined"}' for desired capacity '${desiredCapacityId}'.`,
        };
    }
  }
  if (existing.capacityAssignmentProgress === "InProgress") {
    return {
      assignmentRequired: false,
      pollRequired: false,
      blockedReason: `Workspace '${existing.displayName}' has an in-progress assignment for another capacity.`,
    };
  }
  return { assignmentRequired: true, pollRequired: false };
}

function workspaceUpdateReason(
  existing: WorkspaceInfo,
  metadataMatches: boolean,
  capacity: {
    assignmentRequired: boolean;
    pollRequired: boolean;
  },
): string {
  const changes: string[] = [];
  if (!metadataMatches) {
    changes.push("managed metadata differs");
  }
  if (capacity.assignmentRequired) {
    changes.push("capacity assignment is required");
  } else if (capacity.pollRequired) {
    changes.push("capacity assignment is still in progress");
  }
  return `Workspace '${existing.displayName}' requires update: ${changes.join(
    "; ",
  )}.`;
}

function blockedPlanResult(
  reason: string,
  collisions: Workspace[],
  desired: DesiredWorkspace,
): WorkspacePlanResult {
  const ordered = collisions
    .map(canonicalObservedWorkspace)
    .sort((left, right) =>
      compareCanonicalStrings(stableJson(left), stableJson(right)),
    );
  return {
    action: "blocked",
    reason,
    ...(collisions.length === 1 && collisions[0]?.id
      ? { physicalId: collisions[0].id }
      : {}),
    observedStateHash: sha256(stableJson(ordered)),
    managedMetadataMatches: false,
    capacityAssignmentRequired: desired.capacityId !== undefined,
  };
}

function canonicalObservedWorkspace(workspace: Workspace) {
  const tags = [...(workspace.tags ?? [])]
    .map((tag) => ({
      id: tag.id,
      displayName: tag.displayName,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(stableJson(left), stableJson(right)),
    );
  return {
    id: workspace.id,
    type: workspace.type,
    displayName: workspace.displayName,
    description: normalizeDescription(workspace.description),
    capacityId: workspace.capacityId ?? null,
    domainId: workspace.domainId ?? null,
    tags,
  };
}

function differingMetadata(
  current: Workspace,
  desired: DesiredWorkspace,
): Record<string, string> {
  const body: Record<string, string> = {};
  if (current.displayName !== desired.displayName) {
    body.displayName = desired.displayName;
  }
  if (
    desired.description !== undefined &&
    normalizeDescription(current.description) !==
      normalizeDescription(desired.description)
  ) {
    body.description = desired.description;
  }
  return body;
}

function managedMetadataMatches(
  workspace: Workspace,
  desired: DesiredWorkspace,
): boolean {
  return (
    workspace.displayName === desired.displayName &&
    (desired.description === undefined ||
      normalizeDescription(workspace.description) ===
        normalizeDescription(desired.description))
  );
}

function assertManagedMetadataMatches(
  workspace: Workspace,
  desired: DesiredWorkspace,
  context: string,
): void {
  if (!managedMetadataMatches(workspace, desired)) {
    throw new Error(
      `Workspace '${desired.displayName}' ${context} failed for managed metadata.`,
    );
  }
}

function assertManageableWorkspace(workspace: Workspace): void {
  if (workspace.type !== "Workspace") {
    throw new Error(
      `Workspace '${workspace.displayName}' has unsupported type '${workspace.type ?? "unknown"}'.`,
    );
  }
}

function assertValidDesiredWorkspace(
  desired: DesiredWorkspace,
): void {
  if (
    typeof desired.displayName !== "string" ||
    desired.displayName.trim().length === 0
  ) {
    throw new Error("Workspace displayName must be nonblank.");
  }
  if (desired.displayName.length > 256) {
    throw new Error(
      "Workspace displayName cannot contain more than 256 characters.",
    );
  }
  if (
    desired.displayName.trim().toLowerCase() ===
    "admin monitoring"
  ) {
    throw new Error(
      "Workspace displayName 'Admin monitoring' is reserved.",
    );
  }
  if (
    desired.description !== undefined &&
    desired.description.length > 4000
  ) {
    throw new Error(
      "Workspace description cannot contain more than 4000 characters.",
    );
  }
  if (desired.id !== undefined) {
    assertNonBlankId(desired.id, "workspace ID");
  }
  if (desired.capacityId !== undefined) {
    assertNonBlankId(desired.capacityId, "capacity ID");
  }
}

function assertWorkspaceIdMatchesDesired(
  workspaceId: string,
  desired: DesiredWorkspace,
): void {
  assertNonBlankId(workspaceId, "workspace ID");
  if (desired.id !== undefined && desired.id !== workspaceId) {
    throw new Error(
      `Workspace ID '${workspaceId}' does not match desired authoritative ID '${desired.id}'.`,
    );
  }
}

function assertNonBlankId(
  value: string | undefined,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be nonblank.`);
  }
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function workspacePath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
