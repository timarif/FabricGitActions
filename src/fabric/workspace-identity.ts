import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  PlannedWorkspaceIdentityRoleAssignment as ManifestPlannedWorkspaceIdentityRoleAssignment,
  WorkspaceIdentityDefinition,
  WorkspaceIdentityRoleAssignmentDefinition,
  WorkspaceRole,
} from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

const SUPPORTED_ROLES: readonly WorkspaceRole[] = [
  "Admin",
  "Member",
  "Contributor",
  "Viewer",
];

export interface WorkspaceIdentity {
  applicationId: string;
  servicePrincipalId: string;
}

export interface WorkspaceIdentityWorkspaceResponse {
  id?: string;
  workspaceIdentity?: WorkspaceIdentity | null;
}

export interface WorkspaceRoleAssignmentPrincipal {
  id: string;
  type: string;
  displayName?: string;
  servicePrincipalDetails?: WorkspaceRoleAssignmentServicePrincipalDetails;
}

export interface WorkspaceRoleAssignmentServicePrincipalDetails {
  aadAppId?: string;
}

export interface WorkspaceRoleAssignment {
  id: string;
  principal: WorkspaceRoleAssignmentPrincipal;
  role: WorkspaceRole;
}

export interface WorkspaceIdentityOperationReference {
  operationId?: string;
  location?: string;
}

export interface WorkspaceIdentityProvisionCallbacks {
  onProvisionSubmitting?: () => void;
  onProvisionRejected?: () => void;
  onProvisionAccepted?: (
    operation: WorkspaceIdentityOperationReference | undefined,
  ) => void;
}

export interface WorkspaceIdentityProvisionRecoveryState {
  phase: "submitting" | "accepted";
  operationReference?: WorkspaceIdentityOperationReference;
}

export interface WorkspaceRoleAssignmentCallbacks {
  onRoleAssignmentSubmitting?: () => void;
  onRoleAssignmentRejected?: () => void;
  onRoleAssignmentAccepted?: (assignmentId: string) => void;
}

export interface WorkspaceRoleAssignmentRecoveryState {
  phase: "submitting" | "accepted";
  assignmentId?: string;
}

export type PlannedWorkspaceIdentityRoleAssignment =
  ManifestPlannedWorkspaceIdentityRoleAssignment;

export interface WorkspaceIdentityPlanResult {
  action: "create" | "update" | "no-op" | "blocked";
  reason: string;
  applicationId?: string;
  servicePrincipalId?: string;
  observedStateHash: string;
  roleAssignments: PlannedWorkspaceIdentityRoleAssignment[];
}

export class WorkspaceIdentityAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: WorkspaceIdentityDefinition,
  ): Promise<WorkspaceIdentityPlanResult> {
    assertNonBlank(workspaceId, "workspace ID");
    const roleDefinitions = validateDefinition(workspaceId, desired);
    const identity = await this.readIdentity(workspaceId);

    if (!identity) {
      const roleAssignments = roleDefinitions.map(
        ({ workspaceId: targetWorkspaceId, role }) => ({
          action: "blocked" as const,
          targetWorkspaceId,
          role,
          desiredHash: hashDesiredRoleAssignment(targetWorkspaceId, role),
          reason:
            `Role assignment in workspace '${targetWorkspaceId}' is deferred ` +
            "until the workspace identity is provisioned and a fresh plan is generated.",
          observedStateHash: hashObservedRoleAssignments([]),
        }),
      );
      return {
        action: "create",
        reason: `Workspace '${workspaceId}' does not have a provisioned identity.`,
        observedStateHash: hashObservedIdentityState(undefined, []),
        roleAssignments,
      };
    }

    const assignmentsByWorkspace = new Map<
      string,
      WorkspaceRoleAssignment[]
    >();
    for (const definition of roleDefinitions) {
      if (!assignmentsByWorkspace.has(definition.workspaceId)) {
        assignmentsByWorkspace.set(
          definition.workspaceId,
          await this.listRoleAssignments(definition.workspaceId),
        );
      }
    }

    const roleAssignments = roleDefinitions.map((definition) =>
      planRoleAssignment(
        definition.workspaceId,
        definition.role,
        identity,
        assignmentsByWorkspace.get(definition.workspaceId) ?? [],
      ),
    );
    const action = roleAssignments.some(
      (assignment) => assignment.action === "blocked",
    )
      ? "blocked"
      : roleAssignments.some(
            (assignment) => assignment.action === "create",
          )
        ? "update"
        : "no-op";

    return {
      action,
      reason:
        action === "blocked"
          ? `Workspace '${workspaceId}' has conflicting managed identity role assignments.`
          : action === "update"
            ? `Workspace '${workspaceId}' has a provisioned identity, but one or more role assignments must be created.`
            : `Workspace '${workspaceId}' already has a provisioned identity and all requested role assignments.`,
      applicationId: identity.applicationId,
      servicePrincipalId: identity.servicePrincipalId,
      observedStateHash: hashObservedIdentityState(
        identity,
        roleAssignments,
      ),
      roleAssignments,
    };
  }

  async provision(
    workspaceId: string,
    callbacks: WorkspaceIdentityProvisionCallbacks = {},
  ): Promise<WorkspaceIdentity> {
    assertNonBlank(workspaceId, "workspace ID");

    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${workspacePath(workspaceId)}/provisionIdentity`,
        {
          retryable: false,
          acceptedStatuses: [200, 202],
          onDispatch: callbacks.onProvisionSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onProvisionRejected?.();
      }
      throw error;
    }

    if (response.status === 202) {
      const operationReference = readOperationReference(response);
      callbacks.onProvisionAccepted?.(operationReference);
      await this.client.waitForOperation<unknown>(response);
      return this.verifyIdentity(workspaceId);
    }

    const responseIdentity = parseIdentity(
      response.body,
      "Fabric Provision Workspace Identity response",
    );
    callbacks.onProvisionAccepted?.(undefined);
    return this.verifyIdentity(workspaceId, responseIdentity);
  }

  async resumeProvision(
    workspaceId: string,
    recovery: WorkspaceIdentityProvisionRecoveryState,
  ): Promise<WorkspaceIdentity> {
    assertNonBlank(workspaceId, "workspace ID");
    assertProvisionRecovery(recovery);

    if (recovery.phase === "accepted" && recovery.operationReference) {
      await this.client.waitForOperation<unknown>(
        operationResponse(recovery.operationReference),
      );
      return this.verifyIdentity(workspaceId);
    }

    const identity = await this.readIdentity(workspaceId);
    if (!identity) {
      throw new Error(
        `Workspace identity provisioning for '${workspaceId}' has an ambiguous ` +
          "recovery state; it will not be redispatched.",
      );
    }
    return identity;
  }

  async verifyIdentity(
    workspaceId: string,
    expected?: WorkspaceIdentity,
  ): Promise<WorkspaceIdentity> {
    assertNonBlank(workspaceId, "workspace ID");
    if (expected) {
      assertIdentity(expected, "expected workspace identity");
    }
    const identity = await this.readIdentity(workspaceId);
    if (!identity) {
      throw new Error(
        `Workspace identity verification failed for '${workspaceId}': ` +
          "the canonical workspace read-back has no identity.",
      );
    }
    if (expected && !identitiesEqual(identity, expected)) {
      throw new Error(
        `Workspace identity verification failed for '${workspaceId}': ` +
          "the canonical read-back does not match the provisioning response.",
      );
    }
    return identity;
  }

  async createRoleAssignment(
    workspaceId: string,
    identity: WorkspaceIdentity,
    desired: WorkspaceIdentityRoleAssignmentDefinition,
    callbacks: WorkspaceRoleAssignmentCallbacks = {},
  ): Promise<WorkspaceRoleAssignment> {
    const normalized = normalizeRoleDefinition(workspaceId, desired);
    assertIdentity(identity, "workspace identity");

    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        roleAssignmentsPath(normalized.workspaceId),
        {
          body: {
            principal: {
              id: identity.servicePrincipalId,
              type: "ServicePrincipal",
            },
            role: normalized.role,
          },
          retryable: false,
          acceptedStatuses: [201],
          onDispatch: callbacks.onRoleAssignmentSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onRoleAssignmentRejected?.();
      }
      throw error;
    }

    const created = parseRoleAssignment(
      response.body,
      "Fabric Create Workspace Role Assignment response",
    );
    callbacks.onRoleAssignmentAccepted?.(created.id);
    return this.verifyRoleAssignment(
      workspaceId,
      identity,
      desired,
      created.id,
    );
  }

  async resumeRoleAssignment(
    workspaceId: string,
    identity: WorkspaceIdentity,
    desired: WorkspaceIdentityRoleAssignmentDefinition,
    recovery: WorkspaceRoleAssignmentRecoveryState,
    callbacks: WorkspaceRoleAssignmentCallbacks = {},
  ): Promise<WorkspaceRoleAssignment> {
    const normalized = normalizeRoleDefinition(workspaceId, desired);
    assertIdentity(identity, "workspace identity");

    if (recovery.phase === "accepted") {
      assertNonBlank(
        recovery.assignmentId,
        "accepted role assignment recovery ID",
      );
      return this.verifyRoleAssignment(
        workspaceId,
        identity,
        desired,
        recovery.assignmentId,
      );
    }
    if (recovery.assignmentId !== undefined) {
      throw new Error(
        "Submitting role assignment recovery must not include an assignment ID.",
      );
    }

    const assignments = await this.listRoleAssignments(
      normalized.workspaceId,
    );
    const managed = managedAssignments(assignments, identity);
    if (
      managed.length !== 1 ||
      !assignmentMatches(managed[0], identity, normalized.role)
    ) {
      throw new Error(
        `Role assignment in workspace '${normalized.workspaceId}' has an ` +
          "ambiguous recovery state; it will not be redispatched.",
      );
    }

    const [assignment] = managed;
    if (!assignment) {
      throw new Error("Role assignment recovery analysis returned no match.");
    }
    callbacks.onRoleAssignmentAccepted?.(assignment.id);
    return this.verifyRoleAssignment(
      workspaceId,
      identity,
      desired,
      assignment.id,
    );
  }

  async verifyRoleAssignment(
    workspaceId: string,
    identity: WorkspaceIdentity,
    desired: WorkspaceIdentityRoleAssignmentDefinition,
    assignmentId: string,
  ): Promise<WorkspaceRoleAssignment> {
    const normalized = normalizeRoleDefinition(workspaceId, desired);
    assertIdentity(identity, "workspace identity");
    assertNonBlank(assignmentId, "role assignment ID");

    const matches = (
      await this.listRoleAssignments(normalized.workspaceId)
    ).filter((assignment) => idsEqual(assignment.id, assignmentId));
    if (matches.length !== 1) {
      throw new Error(
        `Role assignment verification failed in workspace ` +
          `'${normalized.workspaceId}': expected exactly one assignment with ` +
          `ID '${assignmentId}', found ${matches.length}.`,
      );
    }
    const [assignment] = matches;
    if (!assignmentMatches(assignment, identity, normalized.role)) {
      throw new Error(
        `Role assignment '${assignmentId}' verification failed in workspace ` +
          `'${normalized.workspaceId}'.`,
      );
    }
    return assignment;
  }

  private async readIdentity(
    workspaceId: string,
  ): Promise<WorkspaceIdentity | undefined> {
    const response = await this.client.request<unknown>(
      "GET",
      workspacePath(workspaceId),
    );
    if (!isRecord(response.body)) {
      throw new Error("Fabric Get Workspace response is empty or malformed.");
    }
    if (
      response.body.id !== undefined &&
      (typeof response.body.id !== "string" ||
        !idsEqual(response.body.id, workspaceId))
    ) {
      throw new Error(
        "Fabric Get Workspace response contains a mismatched workspace ID.",
      );
    }

    const rawIdentity = response.body.workspaceIdentity;
    if (rawIdentity === undefined || rawIdentity === null) {
      return undefined;
    }
    return parseIdentity(rawIdentity, "Fabric workspace identity read-back");
  }

  private async listRoleAssignments(
    workspaceId: string,
  ): Promise<WorkspaceRoleAssignment[]> {
    assertNonBlank(workspaceId, "target workspace ID");
    const assignments = await this.client.listAll<unknown>(
      roleAssignmentsPath(workspaceId),
    );
    return assignments.map((assignment, index) =>
      parseRoleAssignment(
        assignment,
        `Fabric workspace role assignment at index ${index}`,
      ),
    );
  }
}

function validateDefinition(
  sourceWorkspaceId: string,
  desired: WorkspaceIdentityDefinition,
): Array<{ workspaceId: string; role: WorkspaceRole }> {
  if (!isRecord(desired) || desired.provision !== true) {
    throw new Error("Workspace identity definition must set provision to true.");
  }
  if (
    desired.roleAssignments !== undefined &&
    !Array.isArray(desired.roleAssignments)
  ) {
    throw new Error("Workspace identity roleAssignments must be an array.");
  }

  const definitions = (desired.roleAssignments ?? []).map((definition) =>
    normalizeRoleDefinition(sourceWorkspaceId, definition),
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    const canonicalId = definition.workspaceId.toLocaleLowerCase("en-US");
    if (seen.has(canonicalId)) {
      throw new Error(
        `Workspace identity roleAssignments contains duplicate target ` +
          `workspace '${definition.workspaceId}'.`,
      );
    }
    seen.add(canonicalId);
  }
  return definitions.sort((left, right) =>
    compareCanonicalStrings(
      `${left.workspaceId}\0${left.role}`,
      `${right.workspaceId}\0${right.role}`,
    ),
  );
}

function normalizeRoleDefinition(
  sourceWorkspaceId: string,
  desired: WorkspaceIdentityRoleAssignmentDefinition,
): { workspaceId: string; role: WorkspaceRole } {
  assertNonBlank(sourceWorkspaceId, "source workspace ID");
  if (!isRecord(desired)) {
    throw new Error("Workspace identity role assignment must be an object.");
  }
  const workspaceId =
    desired.workspaceId === undefined
      ? sourceWorkspaceId
      : desired.workspaceId;
  assertNonBlank(workspaceId, "role assignment workspace ID");
  assertSupportedRole(desired.role);
  return { workspaceId, role: desired.role };
}

function planRoleAssignment(
  workspaceId: string,
  role: WorkspaceRole,
  identity: WorkspaceIdentity,
  assignments: WorkspaceRoleAssignment[],
): PlannedWorkspaceIdentityRoleAssignment {
  const managed = managedAssignments(assignments, identity);
  const observedStateHash = hashObservedRoleAssignments(managed);
  const desiredHash = hashDesiredRoleAssignment(workspaceId, role);

  if (managed.length === 0) {
    return {
      action: "create",
      targetWorkspaceId: workspaceId,
      role,
      desiredHash,
      reason:
        `Workspace '${workspaceId}' does not have the requested ` +
        `${role} assignment for the managed workspace identity.`,
      observedStateHash,
    };
  }
  if (managed.length > 1) {
    return {
      action: "blocked",
      targetWorkspaceId: workspaceId,
      role,
      desiredHash,
      reason:
        `Workspace '${workspaceId}' has duplicate role assignments for the ` +
        "managed workspace identity; role changes and cleanup are not supported.",
      observedStateHash,
    };
  }

  const [assignment] = managed;
  if (!assignment) {
    throw new Error("Role assignment planning analysis returned no match.");
  }
  if (!assignmentMatchesPrincipal(assignment, identity)) {
    return {
      action: "blocked",
      targetWorkspaceId: workspaceId,
      role,
      desiredHash,
      assignmentId: assignment.id,
      reason:
        `Workspace '${workspaceId}' has a conflicting assignment for the ` +
        "managed service principal.",
      observedStateHash,
    };
  }
  if (assignment.role !== role) {
    return {
      action: "blocked",
      targetWorkspaceId: workspaceId,
      role,
      desiredHash,
      assignmentId: assignment.id,
      reason:
        `Workspace '${workspaceId}' assigns role '${assignment.role}' to the ` +
        `managed identity, not '${role}'; role changes are not supported.`,
      observedStateHash,
    };
  }
  return {
    action: "no-op",
    targetWorkspaceId: workspaceId,
    role,
    desiredHash,
    assignmentId: assignment.id,
    reason:
      `Workspace '${workspaceId}' already has the requested ${role} ` +
      "assignment for the managed workspace identity.",
    observedStateHash,
  };
}

function managedAssignments(
  assignments: WorkspaceRoleAssignment[],
  identity: WorkspaceIdentity,
): WorkspaceRoleAssignment[] {
  return assignments.filter((assignment) =>
    idsEqual(assignment.principal.id, identity.servicePrincipalId),
  );
}

function assignmentMatches(
  assignment: WorkspaceRoleAssignment | undefined,
  identity: WorkspaceIdentity,
  role: WorkspaceRole,
): assignment is WorkspaceRoleAssignment {
  return (
    assignment !== undefined &&
    assignmentMatchesPrincipal(assignment, identity) &&
    assignment.role === role
  );
}

function assignmentMatchesPrincipal(
  assignment: WorkspaceRoleAssignment,
  identity: WorkspaceIdentity,
): boolean {
  if (
    !idsEqual(assignment.principal.id, identity.servicePrincipalId) ||
    assignment.principal.type !== "ServicePrincipal"
  ) {
    return false;
  }
  const aadAppId =
    assignment.principal.servicePrincipalDetails?.aadAppId;
  return aadAppId === undefined || idsEqual(aadAppId, identity.applicationId);
}

function parseIdentity(value: unknown, context: string): WorkspaceIdentity {
  if (!isRecord(value)) {
    throw new Error(`${context} is missing or malformed.`);
  }
  const identity = {
    applicationId: value.applicationId,
    servicePrincipalId: value.servicePrincipalId,
  };
  assertIdentity(identity, context);
  return identity;
}

function assertIdentity(
  value: {
    applicationId: unknown;
    servicePrincipalId: unknown;
  },
  context: string,
): asserts value is WorkspaceIdentity {
  assertNonBlank(value.applicationId, `${context} applicationId`);
  assertNonBlank(
    value.servicePrincipalId,
    `${context} servicePrincipalId`,
  );
}

function parseRoleAssignment(
  value: unknown,
  context: string,
): WorkspaceRoleAssignment {
  if (!isRecord(value) || !isRecord(value.principal)) {
    throw new Error(`${context} is missing or malformed.`);
  }
  assertNonBlank(value.id, `${context} ID`);
  assertNonBlank(value.principal.id, `${context} principal ID`);
  assertNonBlank(value.principal.type, `${context} principal type`);
  assertSupportedRole(value.role);

  const displayName = value.principal.displayName;
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new Error(`${context} principal displayName must be a string.`);
  }

  let servicePrincipalDetails:
    | WorkspaceRoleAssignmentServicePrincipalDetails
    | undefined;
  if (value.principal.servicePrincipalDetails !== undefined) {
    if (!isRecord(value.principal.servicePrincipalDetails)) {
      throw new Error(
        `${context} principal servicePrincipalDetails is malformed.`,
      );
    }
    const aadAppId = value.principal.servicePrincipalDetails.aadAppId;
    if (aadAppId !== undefined) {
      assertNonBlank(
        aadAppId,
        `${context} principal servicePrincipalDetails aadAppId`,
      );
    }
    servicePrincipalDetails = {
      ...(aadAppId !== undefined ? { aadAppId } : {}),
    };
  }

  return {
    id: value.id,
    principal: {
      id: value.principal.id,
      type: value.principal.type,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(servicePrincipalDetails ? { servicePrincipalDetails } : {}),
    },
    role: value.role,
  };
}

function assertSupportedRole(value: unknown): asserts value is WorkspaceRole {
  if (
    typeof value !== "string" ||
    !SUPPORTED_ROLES.includes(value as WorkspaceRole)
  ) {
    throw new Error(
      `Workspace role must be one of: ${SUPPORTED_ROLES.join(", ")}.`,
    );
  }
}

function assertProvisionRecovery(
  recovery: WorkspaceIdentityProvisionRecoveryState,
): void {
  if (!isRecord(recovery)) {
    throw new Error("Workspace identity provision recovery is malformed.");
  }
  if (recovery.phase !== "submitting" && recovery.phase !== "accepted") {
    throw new Error(
      `Unsupported workspace identity provision recovery phase ` +
        `'${String(recovery.phase)}'.`,
    );
  }
  if (
    recovery.phase === "submitting" &&
    recovery.operationReference !== undefined
  ) {
    throw new Error(
      "Submitting workspace identity recovery must not include an operation reference.",
    );
  }
  if (recovery.operationReference) {
    assertOperationReference(recovery.operationReference);
  }
}

function assertOperationReference(
  operation: WorkspaceIdentityOperationReference,
): void {
  if (!isRecord(operation)) {
    throw new Error("Workspace identity operation reference is malformed.");
  }
  if (operation.operationId !== undefined) {
    assertNonBlank(operation.operationId, "workspace identity operation ID");
  }
  if (operation.location !== undefined) {
    assertNonBlank(operation.location, "workspace identity operation location");
  }
  if (!operation.operationId && !operation.location) {
    throw new Error(
      "Workspace identity operation reference requires an operation ID or Location.",
    );
  }
}

function readOperationReference(
  response: FabricResponse<unknown>,
): WorkspaceIdentityOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  const operation = {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
  assertOperationReference(operation);
  return operation;
}

function operationResponse(
  operation: WorkspaceIdentityOperationReference,
): FabricResponse<unknown> {
  assertOperationReference(operation);
  const headers = new Headers();
  if (operation.operationId) {
    headers.set("x-ms-operation-id", operation.operationId);
  }
  if (operation.location) {
    headers.set("location", operation.location);
  }
  return { status: 202, headers, body: undefined };
}

function hashObservedIdentityState(
  identity: WorkspaceIdentity | undefined,
  roleAssignments: PlannedWorkspaceIdentityRoleAssignment[],
): string {
  const roles = roleAssignments
    .map((assignment) => ({
      workspaceId: assignment.targetWorkspaceId,
      observedStateHash: assignment.observedStateHash,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.workspaceId, right.workspaceId),
    );
  return sha256(
    stableJson({
      identity: identity ? canonicalIdentity(identity) : null,
      roleAssignments: roles,
    }),
  );
}

function hashDesiredRoleAssignment(
  targetWorkspaceId: string,
  role: WorkspaceRole,
): string {
  return sha256(stableJson({ targetWorkspaceId, role }));
}

function hashObservedRoleAssignments(
  assignments: WorkspaceRoleAssignment[],
): string {
  const canonical = assignments
    .map((assignment) => ({
      id: assignment.id,
      principal: {
        id: assignment.principal.id,
        type: assignment.principal.type,
        aadAppId:
          assignment.principal.servicePrincipalDetails?.aadAppId,
      },
      role: assignment.role,
    }))
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
  return sha256(stableJson(canonical));
}

function canonicalIdentity(identity: WorkspaceIdentity): WorkspaceIdentity {
  return {
    applicationId: identity.applicationId,
    servicePrincipalId: identity.servicePrincipalId,
  };
}

function identitiesEqual(
  left: WorkspaceIdentity,
  right: WorkspaceIdentity,
): boolean {
  return (
    idsEqual(left.applicationId, right.applicationId) &&
    idsEqual(left.servicePrincipalId, right.servicePrincipalId)
  );
}

function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    !error.priorAttemptAmbiguous &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function workspacePath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}`;
}

function roleAssignmentsPath(workspaceId: string): string {
  return `${workspacePath(workspaceId)}/roleAssignments`;
}

function idsEqual(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function assertNonBlank(
  value: unknown,
  name: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a nonblank string.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
