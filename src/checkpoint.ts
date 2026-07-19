import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { managedPrivateEndpointCheckpointKey } from "./fabric/managed-private-endpoints";
import { compareCanonicalStrings } from "./hash";
import type {
  ApplyCheckpoint,
  ApplyResult,
  DeploymentPlan,
} from "./types";

const MANAGED_PRIVATE_ENDPOINT_RECREATE_DELAY_MS = 15 * 60 * 1000;
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function loadCheckpoint(
  checkpointFile: string,
  approvedPlan: DeploymentPlan,
): ApplyCheckpoint | undefined {
  const absolutePath = path.resolve(checkpointFile);
  if (!existsSync(absolutePath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    throw new Error(`Checkpoint file is not valid JSON: ${absolutePath}`);
  }
  if (!isCheckpoint(parsed)) {
    throw new Error(`Checkpoint file has an invalid structure: ${absolutePath}`);
  }
  const checkpoint: ApplyCheckpoint = {
    ...parsed,
    pendingOperations: parsed.pendingOperations ?? {},
    pendingCreates: parsed.pendingCreates ?? {},
    pendingUpdates: parsed.pendingUpdates ?? {},
    pendingDeletes: parsed.pendingDeletes ?? {},
    lakehouseTables: parsed.lakehouseTables ?? {},
    oneLakeArtifacts: parsed.oneLakeArtifacts ?? {},
    tagAssignments: parsed.tagAssignments ?? {},
  };
  assertCheckpointMatchesPlan(checkpoint, approvedPlan);
  return checkpoint;
}

export function createCheckpoint(plan: DeploymentPlan): ApplyCheckpoint {
  return {
    schemaVersion: "1",
    deploymentId: plan.deploymentId,
    workspaceId: plan.workspaceId,
    environment: plan.environment,
    planHash: plan.planHash,
    ...(plan.sourceCommit ? { sourceCommit: plan.sourceCommit } : {}),
    completedItems: {},
    pendingOperations: {},
    pendingCreates: {},
    pendingUpdates: {},
    pendingDeletes: {},
    lakehouseTables: {},
    oneLakeArtifacts: {},
    tagAssignments: {},
  };
}

export function writeCheckpoint(
  checkpointFile: string,
  checkpoint: ApplyCheckpoint,
): string {
  return writeJson(checkpointFile, checkpoint);
}

export function writeApplyResult(
  resultFile: string,
  result: ApplyResult,
): string {
  return writeJson(resultFile, result);
}

export function initializeApplyArtifacts(
  plan: DeploymentPlan,
  checkpointFile: string,
  resultFile: string,
  now: number = Date.now(),
): ApplyCheckpoint {
  const checkpoint =
    loadCheckpoint(checkpointFile, plan) ?? createCheckpoint(plan);
  writeCheckpoint(checkpointFile, checkpoint);
  const timestamp = new Date(now).toISOString();
  writeApplyResult(resultFile, {
    schemaVersion: "1",
    status: "in_progress",
    deploymentId: plan.deploymentId,
    workspaceId: plan.workspaceId,
    environment: plan.environment,
    planHash: plan.planHash,
    ...(plan.sourceCommit ? { sourceCommit: plan.sourceCommit } : {}),
    startedAt: timestamp,
    completedAt: timestamp,
    items: [],
  });
  return checkpoint;
}

function writeJson(filePath: string, value: unknown): string {
  const absolutePath = path.resolve(filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporaryPath, absolutePath);
  } catch (error) {
    if (existsSync(temporaryPath)) {
      unlinkSync(temporaryPath);
    }
    throw error;
  }
  return absolutePath;
}

function assertCheckpointMatchesPlan(
  checkpoint: ApplyCheckpoint,
  plan: DeploymentPlan,
): void {
  if (
    checkpoint.deploymentId !== plan.deploymentId ||
    checkpoint.workspaceId !== plan.workspaceId ||
    checkpoint.environment !== plan.environment ||
    checkpoint.planHash !== plan.planHash ||
    checkpoint.sourceCommit !== plan.sourceCommit
  ) {
    throw new Error(
      "Checkpoint does not match the approved deployment plan and cannot be resumed.",
    );
  }
  if (checkpoint.workspace) {
    const planned = plan.workspace;
    if (
      !planned ||
      (planned.action !== "create" &&
        planned.action !== "update" &&
        planned.action !== "no-op") ||
      checkpoint.workspace.action !== planned.action
    ) {
      throw new Error(
        "Checkpoint workspace does not match the approved deployment plan.",
      );
    }
    if (
      (planned.action === "update" ||
        planned.action === "no-op") &&
      checkpoint.workspace.physicalId !== planned.physicalId
    ) {
      throw new Error(
        "Checkpoint workspace physical ID does not match the approved deployment plan.",
      );
    }
  }
  if (checkpoint.networkProtection) {
    const planned = plan.networkProtection;
    if (!planned || !planned.workspaceId) {
      throw new Error(
        "Checkpoint network protection does not match the approved deployment plan.",
      );
    }
    if (checkpoint.networkProtection.workspaceId !== planned.workspaceId) {
      throw new Error(
        "Checkpoint network protection workspace ID does not match the approved deployment plan.",
      );
    }
    assertCheckpointNetworkSurfaceMatchesPlan(
      "communicationPolicy",
      checkpoint.networkProtection.communicationPolicy,
      planned.communicationPolicy,
    );
    assertCheckpointNetworkSurfaceMatchesPlan(
      "outboundCloudConnectionRules",
      checkpoint.networkProtection.outboundCloudConnectionRules,
      planned.outboundCloudConnectionRules,
    );
    assertCheckpointNetworkSurfaceMatchesPlan(
      "outboundGatewayRules",
      checkpoint.networkProtection.outboundGatewayRules,
      planned.outboundGatewayRules,
    );
    if (
      planned.communicationPolicy.action === "blocked" &&
      (planned.communicationPolicy
        .blockedByManagedPrivateEndpoints?.length ?? 0) > 0 &&
      (checkpoint.networkProtection.communicationPolicy ||
        checkpoint.networkProtection.outboundCloudConnectionRules ||
        checkpoint.networkProtection.outboundGatewayRules)
    ) {
      throw new Error(
        "Checkpoint contains an OAP mutation for a plan that defers OAP until managed private endpoint approval.",
      );
    }
    assertCheckpointManagedPrivateEndpointsMatchPlan(
      checkpoint.networkProtection.managedPrivateEndpoints,
      planned.managedPrivateEndpoints,
    );
    if (checkpoint.networkProtection.completedAt) {
      assertCompletedNetworkSurface(
        "communicationPolicy",
        checkpoint.networkProtection.communicationPolicy,
        planned.communicationPolicy,
      );
      assertCompletedNetworkSurface(
        "outboundCloudConnectionRules",
        checkpoint.networkProtection.outboundCloudConnectionRules,
        planned.outboundCloudConnectionRules,
      );
      assertCompletedNetworkSurface(
        "outboundGatewayRules",
        checkpoint.networkProtection.outboundGatewayRules,
        planned.outboundGatewayRules,
      );
      for (const endpoint of planned.managedPrivateEndpoints ?? []) {
        const managedStates =
          checkpoint.networkProtection.managedPrivateEndpoints;
        const key = managedPrivateEndpointCheckpointKey(
          endpoint.name,
        );
        const state =
          managedStates &&
          Object.prototype.hasOwnProperty.call(managedStates, key)
            ? managedStates[key]
            : undefined;
        if (
          !state ||
          (endpoint.desiredState === "present"
            ? state.phase !== "present-verified"
            : state.phase !== "absent-verified")
        ) {
          throw new Error(
            `Completed network protection checkpoint is missing terminal managed private endpoint state for '${endpoint.name}'.`,
          );
        }
      }
    }

    function assertCheckpointManagedPrivateEndpointsMatchPlan(
      checkpoint:
        | NonNullable<
            ApplyCheckpoint["networkProtection"]
          >["managedPrivateEndpoints"]
        | undefined,
      planned:
        | NonNullable<
            DeploymentPlan["networkProtection"]
          >["managedPrivateEndpoints"]
        | undefined,
    ): void {
      if (!checkpoint) {
        return;
      }
      if (!planned) {
        throw new Error(
          "Checkpoint managed private endpoints do not match the approved deployment plan.",
        );
      }
      const plannedByName = new Map(
        planned.map((endpoint) => [
          managedPrivateEndpointCheckpointKey(endpoint.name),
          endpoint,
        ]),
      );
      for (const [key, state] of Object.entries(checkpoint)) {
        const endpoint = plannedByName.get(key);
        if (
          !endpoint ||
          managedPrivateEndpointCheckpointKey(endpoint.name) !==
            key ||
          state.name !== endpoint.name ||
          state.desiredState !== endpoint.desiredState ||
          state.action !== endpoint.action ||
          state.operationHash !== endpoint.operationHash ||
          state.desiredIdentityHash !== endpoint.desiredIdentityHash
        ) {
          throw new Error(
            `Checkpoint managed private endpoint '${state.name}' does not match the approved deployment plan.`,
          );
        }
        const validPhase =
          (endpoint.action === "create" &&
            (state.phase === "create-submitting" ||
              state.phase === "provisioning" ||
              state.phase === "present-verified")) ||
          (endpoint.action === "delete" &&
            (state.phase === "delete-submitting" ||
              state.phase === "absent-verified")) ||
          (endpoint.action === "no-op" &&
            ((endpoint.desiredState === "present" &&
              state.phase === "present-verified") ||
              (endpoint.desiredState === "absent" &&
                state.phase === "absent-verified")));
        if (!validPhase) {
          throw new Error(
            `Checkpoint managed private endpoint '${state.name}' phase does not match the approved action.`,
          );
        }
      }
    }
  }
  const plannedItems = new Map(
    plan.items.map((item) => [item.logicalId, item]),
  );
  for (const [logicalId, completed] of Object.entries(
    checkpoint.completedItems,
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      completed.logicalId !== logicalId ||
      completed.action !== planned.action ||
      (planned.action === "delete" &&
        completed.physicalId !== planned.physicalId) ||
      (planned.desiredState === "absent" &&
        planned.action === "no-op" &&
        completed.physicalId !== undefined) ||
      (planned.desiredState === "present" &&
        !completed.physicalId)
    ) {
      throw new Error(
        `Checkpoint item '${logicalId}' does not match the approved deployment plan.`,
      );
    }
    if (planned.type === "LakehouseTables") {
      const tablePlan = planned.lakehouseTables;
      if (!tablePlan) {
        throw new Error(
          `Checkpointed LakehouseTables item '${logicalId}' has no approved table plan.`,
        );
      }
      const target = plannedItems.get(
        tablePlan.targetLakehouseLogicalId,
      );
      if (!target || target.type !== "Lakehouse") {
        throw new Error(
          `Checkpointed LakehouseTables item '${logicalId}' has an invalid approved target.`,
        );
      }
      if (tablePlan.targetBinding === "physical") {
        if (
          !tablePlan.targetLakehousePhysicalId ||
          target.physicalId !== tablePlan.targetLakehousePhysicalId ||
          completed.physicalId !== tablePlan.targetLakehousePhysicalId
        ) {
          throw new Error(
            `Checkpointed LakehouseTables item '${logicalId}' physical ID does not match its approved target.`,
          );
        }
      } else {
        const completedTarget =
          checkpoint.completedItems[
            tablePlan.targetLakehouseLogicalId
          ];
        if (
          target.action !== "create" ||
          !completedTarget ||
          completedTarget.logicalId !== target.logicalId ||
          completedTarget.action !== "create" ||
          completed.physicalId !== completedTarget.physicalId
        ) {
          throw new Error(
            `Checkpointed LakehouseTables item '${logicalId}' physical ID does not match its exact completed target dependency.`,
          );
        }
      }
    }
  }
  for (const [logicalId, pending] of Object.entries(
    checkpoint.pendingOperations,
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      pending.logicalId !== logicalId ||
      pending.action !== "create" ||
      planned.action !== "create" ||
      !checkpointProofMatchesPlan(planned, pending) ||
      Object.hasOwn(checkpoint.completedItems, logicalId)
    ) {
      throw new Error(
        `Checkpoint operation '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
  for (const [logicalId, pending] of Object.entries(
    checkpoint.lakehouseTables ?? {},
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      planned.type !== "LakehouseTables" ||
      pending.logicalId !== logicalId ||
      planned.lakehouseTables?.targetLakehouseLogicalId !==
        pending.targetLakehouseLogicalId ||
      planned.lakehouseTables.desiredHash !== pending.desiredHash ||
      planned.lakehouseTables.sourceHash !== pending.sourceHash
    ) {
      throw new Error(
        `Checkpoint LakehouseTables state '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
  for (const [logicalId, pending] of Object.entries(
    checkpoint.pendingCreates,
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      pending.logicalId !== logicalId ||
      pending.action !== "create" ||
      planned.action !== "create" ||
      !checkpointProofMatchesPlan(planned, pending) ||
      Object.hasOwn(checkpoint.completedItems, logicalId) ||
      Object.hasOwn(checkpoint.pendingOperations, logicalId)
    ) {
      throw new Error(
        `Checkpoint create intent '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
  for (const [logicalId, pending] of Object.entries(
    checkpoint.pendingUpdates,
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      pending.logicalId !== logicalId ||
      pending.action !== "update" ||
      planned.action !== "update" ||
      planned.physicalId !== pending.physicalId ||
      !checkpointProofMatchesPlan(planned, pending) ||
      Object.hasOwn(checkpoint.completedItems, logicalId)
    ) {
      throw new Error(
        `Checkpoint update intent '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
  for (const [logicalId, pending] of Object.entries(
    checkpoint.pendingDeletes,
  )) {
    const planned = plannedItems.get(logicalId);
    if (
      !planned ||
      pending.logicalId !== logicalId ||
      pending.action !== "delete" ||
      planned.action !== "delete" ||
      planned.physicalId !== pending.physicalId ||
      planned.observedStateHash !== pending.observedStateHash ||
      Object.hasOwn(checkpoint.completedItems, logicalId)
    ) {
      throw new Error(
        `Checkpoint delete intent '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
  for (const [logicalId, state] of Object.entries(
    checkpoint.oneLakeArtifacts ?? {},
  )) {
    const planned = plannedItems.get(logicalId);
    const staging = planned?.sparkJobArtifacts;
    if (
      !planned ||
      planned.type !== "SparkJobDefinition" ||
      !staging ||
      state.logicalId !== logicalId ||
      state.targetLakehouseLogicalId !==
        staging.targetLakehouseLogicalId ||
      state.stagingHash !== staging.stagingHash
    ) {
      throw new Error(
        `Checkpoint OneLake artifact state '${logicalId}' does not match the approved deployment plan.`,
      );
    }
    const expectedTargetId =
      staging.targetBinding === "physical"
        ? staging.targetLakehousePhysicalId
        : checkpoint.completedItems[
            staging.targetLakehouseLogicalId
          ]?.physicalId;
    if (!expectedTargetId || state.targetLakehouseId !== expectedTargetId) {
      throw new Error(
        `Checkpoint OneLake artifact target '${logicalId}' does not match the approved Lakehouse binding.`,
      );
    }
    const approvedArtifacts = new Map(
      staging.artifacts.map((artifact) => [
        artifact.operationId,
        artifact,
      ]),
    );
    if (
      Object.keys(state.artifacts).length > approvedArtifacts.size ||
      !Object.entries(state.artifacts).every(
        ([operationId, artifact]) => {
          const approved = approvedArtifacts.get(operationId);
          return (
            approved !== undefined &&
            artifact.operationId === operationId &&
            artifact.operationHash === approved.operationHash &&
            artifact.fileName === approved.fileName &&
            artifact.oneLakePath === approved.oneLakePath &&
            artifact.contentHash === approved.contentHash &&
            artifact.sizeBytes === approved.sizeBytes &&
            (artifact.phase !== "upload-submitting" ||
              approved.action === "create")
          );
        },
      )
    ) {
      throw new Error(
        `Checkpoint OneLake artifact operations '${logicalId}' do not match the approved deployment plan.`,
      );
    }
    if (
      state.completedAt &&
      (Object.keys(state.artifacts).length !== approvedArtifacts.size ||
        Object.values(state.artifacts).some(
          (artifact) => artifact.phase !== "verified",
        ))
    ) {
      throw new Error(
        `Checkpoint OneLake artifact completion '${logicalId}' is incomplete.`,
      );
    }
  }
  for (const [logicalId, state] of Object.entries(
    checkpoint.tagAssignments ?? {},
  )) {
    const planned = plannedItems.get(logicalId);
    const assignment = planned?.tagAssignment;
    const expectedItemId =
      planned?.physicalId ??
      checkpoint.completedItems[logicalId]?.physicalId;
    const expectedTagIds = assignment?.tagLogicalIds.map(
      (tagLogicalId) =>
        plannedItems.get(tagLogicalId)?.physicalId ??
        checkpoint.completedItems[tagLogicalId]?.physicalId,
    );
    if (
      !planned ||
      !assignment ||
      assignment.action !== "update" ||
      state.logicalId !== logicalId ||
      state.assignmentHash !== assignment.assignmentHash ||
      !expectedItemId ||
      state.itemPhysicalId !== expectedItemId ||
      !expectedTagIds ||
      expectedTagIds.some((id) => !id) ||
      state.tagIds.length !== expectedTagIds.length ||
      !expectedTagIds.every((id) => state.tagIds.includes(id!))
    ) {
      throw new Error(
        `Checkpoint Fabric tag assignment '${logicalId}' does not match the approved deployment plan.`,
      );
    }
  }
}

function checkpointProofMatchesPlan(
  planned: DeploymentPlan["items"][number],
  pending: {
    materializedDefinitionHash?: string;
    resolvedBindingsHash?: string;
  },
): boolean {
  if (
    planned.materializedDefinitionHash === undefined &&
    planned.resolvedBindingsHash === undefined
  ) {
    return true;
  }
  return (
    pending.materializedDefinitionHash ===
      planned.materializedDefinitionHash &&
    pending.resolvedBindingsHash === planned.resolvedBindingsHash
  );
}

function assertCheckpointNetworkSurfaceMatchesPlan(
  label: string,
  surfaceState: { desiredHash: string } | undefined,
  plannedSurface: { desiredHash: string } | undefined,
): void {
  if (!surfaceState) {
    return;
  }
  if (!plannedSurface || surfaceState.desiredHash !== plannedSurface.desiredHash) {
    throw new Error(
      `Checkpoint network protection '${label}' does not match the approved deployment plan.`,
    );
  }
}

function assertCompletedNetworkSurface(
  label: string,
  surfaceState: { phase: "submitting" | "verified" } | undefined,
  plannedSurface: { desiredHash: string } | undefined,
): void {
  if (plannedSurface && surfaceState?.phase !== "verified") {
    throw new Error(
      `Checkpoint network protection is marked complete, but '${label}' is not verified.`,
    );
  }
}

function isCheckpoint(value: unknown): value is ApplyCheckpoint {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const checkpoint = value as Partial<ApplyCheckpoint>;
  if (
    checkpoint.schemaVersion === "1" &&
    typeof checkpoint.deploymentId === "string" &&
    typeof checkpoint.workspaceId === "string" &&
    typeof checkpoint.environment === "string" &&
    typeof checkpoint.planHash === "string" &&
    checkpoint.completedItems !== null &&
    typeof checkpoint.completedItems === "object" &&
    !Array.isArray(checkpoint.completedItems) &&
    (checkpoint.pendingOperations === undefined ||
      (checkpoint.pendingOperations !== null &&
        typeof checkpoint.pendingOperations === "object" &&
        !Array.isArray(checkpoint.pendingOperations))) &&
    (checkpoint.pendingCreates === undefined ||
      (checkpoint.pendingCreates !== null &&
        typeof checkpoint.pendingCreates === "object" &&
        !Array.isArray(checkpoint.pendingCreates))) &&
    (checkpoint.pendingUpdates === undefined ||
      (checkpoint.pendingUpdates !== null &&
        typeof checkpoint.pendingUpdates === "object" &&
        !Array.isArray(checkpoint.pendingUpdates))) &&
    (checkpoint.pendingDeletes === undefined ||
      (checkpoint.pendingDeletes !== null &&
        typeof checkpoint.pendingDeletes === "object" &&
        !Array.isArray(checkpoint.pendingDeletes))) &&
    (checkpoint.lakehouseTables === undefined ||
      (checkpoint.lakehouseTables !== null &&
        typeof checkpoint.lakehouseTables === "object" &&
        !Array.isArray(checkpoint.lakehouseTables))) &&
    (checkpoint.oneLakeArtifacts === undefined ||
      (checkpoint.oneLakeArtifacts !== null &&
        typeof checkpoint.oneLakeArtifacts === "object" &&
        !Array.isArray(checkpoint.oneLakeArtifacts))) &&
    (checkpoint.tagAssignments === undefined ||
      (checkpoint.tagAssignments !== null &&
        typeof checkpoint.tagAssignments === "object" &&
        !Array.isArray(checkpoint.tagAssignments))) &&
    (checkpoint.workspace === undefined ||
      isCheckpointWorkspace(checkpoint.workspace)) &&
    (checkpoint.networkProtection === undefined ||
      isCheckpointNetworkProtection(checkpoint.networkProtection)) &&
    (checkpoint.sourceCommit === undefined ||
      typeof checkpoint.sourceCommit === "string")
  ) {
    return (
      Object.entries(checkpoint.completedItems).every(([logicalId, item]) =>
        isCheckpointItem(logicalId, item),
      ) &&
      Object.entries(checkpoint.pendingOperations ?? {}).every(
        ([logicalId, operation]) =>
          isCheckpointOperation(logicalId, operation),
      ) &&
      Object.entries(checkpoint.pendingCreates ?? {}).every(
        ([logicalId, intent]) => isCheckpointCreateIntent(logicalId, intent),
      ) &&
      Object.entries(checkpoint.pendingUpdates ?? {}).every(
        ([logicalId, intent]) => isCheckpointUpdateIntent(logicalId, intent),
      ) &&
      Object.entries(checkpoint.pendingDeletes ?? {}).every(
        ([logicalId, intent]) => isCheckpointDeleteIntent(logicalId, intent),
      ) &&
      Object.entries(checkpoint.lakehouseTables ?? {}).every(
        ([logicalId, state]) =>
          isCheckpointLakehouseTables(logicalId, state),
      ) &&
      Object.entries(checkpoint.oneLakeArtifacts ?? {}).every(
        ([logicalId, state]) =>
          isCheckpointOneLakeArtifacts(logicalId, state),
      ) &&
      Object.entries(checkpoint.tagAssignments ?? {}).every(
        ([logicalId, state]) =>
          isCheckpointTagAssignment(logicalId, state),
      )
    );
  }

  function isCheckpointTagAssignment(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const state = value as Record<string, unknown>;
    return (
      state.logicalId === logicalId &&
      /^[a-f0-9]{64}$/.test(String(state.assignmentHash)) &&
      typeof state.itemPhysicalId === "string" &&
      state.itemPhysicalId.length > 0 &&
      Array.isArray(state.tagIds) &&
      state.tagIds.length > 0 &&
      new Set(state.tagIds).size === state.tagIds.length &&
      state.tagIds.every(
        (tagId) => typeof tagId === "string" && tagId.length > 0,
      ) &&
      (state.phase === "submitting" || state.phase === "verified") &&
      typeof state.submittedAt === "string" &&
      !Number.isNaN(Date.parse(state.submittedAt)) &&
      (state.verifiedAt === undefined ||
        (typeof state.verifiedAt === "string" &&
          !Number.isNaN(Date.parse(state.verifiedAt)))) &&
      (state.phase !== "verified" ||
        typeof state.verifiedAt === "string") &&
      typeof state.updatedAt === "string" &&
      !Number.isNaN(Date.parse(state.updatedAt))
    );
  }

  function isCheckpointOneLakeArtifacts(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const state = value as Record<string, unknown>;
    return (
      state.logicalId === logicalId &&
      typeof state.targetLakehouseLogicalId === "string" &&
      typeof state.targetLakehouseId === "string" &&
      /^[a-f0-9]{64}$/.test(String(state.stagingHash)) &&
      state.artifacts !== null &&
      typeof state.artifacts === "object" &&
      !Array.isArray(state.artifacts) &&
      Object.entries(
        state.artifacts as Record<string, unknown>,
      ).every(([operationId, artifact]) =>
        isCheckpointOneLakeArtifact(operationId, artifact),
      ) &&
      (state.completedAt === undefined ||
        (typeof state.completedAt === "string" &&
          !Number.isNaN(Date.parse(state.completedAt)))) &&
      (state.completedAt === undefined ||
        Object.values(
          state.artifacts as Record<
            string,
            { phase?: unknown }
          >,
        ).every((artifact) => artifact.phase === "verified")) &&
      typeof state.updatedAt === "string" &&
      !Number.isNaN(Date.parse(state.updatedAt))
    );
  }

  function isCheckpointOneLakeArtifact(
    operationId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const artifact = value as Record<string, unknown>;
    return (
      artifact.operationId === operationId &&
      /^[a-f0-9]{64}$/.test(String(artifact.operationHash)) &&
      typeof artifact.fileName === "string" &&
      typeof artifact.oneLakePath === "string" &&
      /^[a-f0-9]{64}$/.test(String(artifact.contentHash)) &&
      typeof artifact.sizeBytes === "number" &&
      Number.isSafeInteger(artifact.sizeBytes) &&
      artifact.sizeBytes >= 0 &&
      (artifact.phase === "upload-submitting" ||
        artifact.phase === "verified") &&
      (artifact.submittedAt === undefined ||
        (typeof artifact.submittedAt === "string" &&
          !Number.isNaN(Date.parse(artifact.submittedAt)))) &&
      (artifact.verifiedAt === undefined ||
        (typeof artifact.verifiedAt === "string" &&
          !Number.isNaN(Date.parse(artifact.verifiedAt)))) &&
      (artifact.phase !== "upload-submitting" ||
        typeof artifact.submittedAt === "string") &&
      (artifact.phase !== "verified" ||
        typeof artifact.verifiedAt === "string") &&
      typeof artifact.updatedAt === "string" &&
      !Number.isNaN(Date.parse(artifact.updatedAt))
    );
  }

  function isCheckpointLakehouseTables(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const state = value as Record<string, unknown>;
    const statement = state.statement;
    return (
      state.logicalId === logicalId &&
      typeof state.targetLakehouseLogicalId === "string" &&
      typeof state.targetLakehouseId === "string" &&
      /^[a-f0-9]{64}$/.test(String(state.desiredHash)) &&
      /^[a-f0-9]{64}$/.test(String(state.sourceHash)) &&
      typeof state.attemptId === "string" &&
      typeof state.sessionName === "string" &&
      /^[a-f0-9]{64}$/.test(String(state.sessionRequestHash)) &&
      (state.sessionId === undefined ||
        (typeof state.sessionId === "string" &&
          state.sessionId.length > 0)) &&
      [
        "submitting",
        "accepted",
        "active",
        "cleanup-submitting",
        "cleanup-complete",
      ].includes(String(state.sessionPhase)) &&
      typeof state.sessionSubmittedAt === "string" &&
      !Number.isNaN(Date.parse(state.sessionSubmittedAt)) &&
      (statement === undefined ||
        isCheckpointLakehouseTableStatement(statement)) &&
      Array.isArray(state.completedOperationHashes) &&
      state.completedOperationHashes.every(
        (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash),
      ) &&
      Array.isArray(state.operationReceipts) &&
      state.operationReceipts.every((receipt) =>
        isCheckpointLakehouseTableOperationReceipt(receipt),
      ) &&
      typeof state.updatedAt === "string" &&
      !Number.isNaN(Date.parse(state.updatedAt))
    );
  }

  function isCheckpointLakehouseTableOperationReceipt(
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const receipt = value as Record<string, unknown>;
    return (
      /^[a-f0-9]{64}$/.test(String(receipt.operationHash)) &&
      typeof receipt.tableLogicalId === "string" &&
      typeof receipt.statementAttemptName === "string" &&
      /^[a-f0-9]{64}$/.test(String(receipt.codeHash)) &&
      typeof receipt.statementId === "number" &&
      Number.isSafeInteger(receipt.statementId) &&
      receipt.statementId >= 0 &&
      ["submittedAt", "acceptedAt", "verifiedAt"].every(
        (key) =>
          typeof receipt[key] === "string" &&
          !Number.isNaN(Date.parse(receipt[key] as string)),
      )
    );
  }

  function isCheckpointLakehouseTableStatement(value: unknown): boolean {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const statement = value as Record<string, unknown>;
    return (
      typeof statement.statementAttemptName === "string" &&
      (statement.purpose === "inspect" ||
        statement.purpose === "create") &&
      typeof statement.tableLogicalId === "string" &&
      (statement.operationHash === undefined ||
        /^[a-f0-9]{64}$/.test(String(statement.operationHash))) &&
      /^[a-f0-9]{64}$/.test(String(statement.codeHash)) &&
      ["submitting", "accepted", "verified"].includes(
        String(statement.phase),
      ) &&
      (statement.statementId === undefined ||
        (typeof statement.statementId === "number" &&
          Number.isSafeInteger(statement.statementId) &&
          statement.statementId >= 0)) &&
      typeof statement.submittedAt === "string" &&
      !Number.isNaN(Date.parse(statement.submittedAt))
    );
  }

  function isCheckpointUpdateIntent(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const intent = value as Partial<
      ApplyCheckpoint["pendingUpdates"][string]
    >;
    return (
      intent.logicalId === logicalId &&
      intent.action === "update" &&
      typeof intent.physicalId === "string" &&
      intent.physicalId.length > 0 &&
      typeof intent.submittedAt === "string" &&
      !Number.isNaN(Date.parse(intent.submittedAt)) &&
      (intent.phase === undefined ||
        [
          "metadata-submitting",
          "metadata-updated",
          "definition-staged",
          "published",
          "marker-cleaned",
        ].includes(intent.phase)) &&
      (intent.stagedDefinitionHash === undefined ||
        /^[a-f0-9]{64}$/.test(intent.stagedDefinitionHash)) &&
      (intent.materializedDefinitionHash === undefined ||
        /^[a-f0-9]{64}$/.test(intent.materializedDefinitionHash)) &&
      (intent.resolvedBindingsHash === undefined ||
        /^[a-f0-9]{64}$/.test(intent.resolvedBindingsHash)) &&
      (intent.materializedDefinitionHash === undefined) ===
        (intent.resolvedBindingsHash === undefined) &&
      (intent.stagedDeploymentMarker === undefined ||
        /^[a-f0-9]{64}$/.test(intent.stagedDeploymentMarker)) &&
      (intent.publishState === undefined ||
        typeof intent.publishState === "string") &&
      (intent.targetVersion === undefined ||
        typeof intent.targetVersion === "string") &&
      (intent.phase === undefined ||
        intent.stagedDefinitionHash !== undefined)
    );
  }

  function isCheckpointDeleteIntent(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const intent = value as Partial<
      ApplyCheckpoint["pendingDeletes"][string]
    >;
    return (
      intent.logicalId === logicalId &&
      intent.action === "delete" &&
      typeof intent.physicalId === "string" &&
      intent.physicalId.length > 0 &&
      typeof intent.observedStateHash === "string" &&
      /^[a-f0-9]{64}$/.test(intent.observedStateHash) &&
      typeof intent.submittedAt === "string" &&
      !Number.isNaN(Date.parse(intent.submittedAt))
    );
  }

  function isCheckpointCreateIntent(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const intent = value as Partial<
      ApplyCheckpoint["pendingCreates"][string]
    >;
    return (
      intent.logicalId === logicalId &&
      intent.action === "create" &&
      (intent.materializedDefinitionHash === undefined ||
        /^[a-f0-9]{64}$/.test(intent.materializedDefinitionHash)) &&
      (intent.resolvedBindingsHash === undefined ||
        /^[a-f0-9]{64}$/.test(intent.resolvedBindingsHash)) &&
      (intent.materializedDefinitionHash === undefined) ===
        (intent.resolvedBindingsHash === undefined) &&
      typeof intent.submittedAt === "string" &&
      !Number.isNaN(Date.parse(intent.submittedAt))
    );
  }

  function isCheckpointOperation(
    logicalId: string,
    value: unknown,
  ): boolean {
    if (value === null || typeof value !== "object") {
      return false;
    }
    const operation = value as Partial<
      ApplyCheckpoint["pendingOperations"][string]
    >;
    return (
      operation.logicalId === logicalId &&
      operation.action === "create" &&
      (operation.materializedDefinitionHash === undefined ||
        /^[a-f0-9]{64}$/.test(operation.materializedDefinitionHash)) &&
      (operation.resolvedBindingsHash === undefined ||
        /^[a-f0-9]{64}$/.test(operation.resolvedBindingsHash)) &&
      (operation.materializedDefinitionHash === undefined) ===
        (operation.resolvedBindingsHash === undefined) &&
      (operation.operationId === undefined ||
        (typeof operation.operationId === "string" &&
          /^[A-Za-z0-9._-]+$/.test(operation.operationId))) &&
      (operation.location === undefined ||
        (typeof operation.location === "string" &&
          operation.location.length > 0)) &&
      (typeof operation.operationId === "string" ||
        typeof operation.location === "string") &&
      typeof operation.acceptedAt === "string" &&
      !Number.isNaN(Date.parse(operation.acceptedAt))
    );
  }
  return false;
}

function isCheckpointWorkspace(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const workspace = value as Partial<
    NonNullable<ApplyCheckpoint["workspace"]>
  >;
  const validState =
    workspace.state === "create-submitting" ||
    workspace.state === "create-accepted" ||
    workspace.state === "metadata-update-submitting" ||
    workspace.state === "metadata-update-accepted" ||
    workspace.state === "capacity-assignment-submitting" ||
    workspace.state === "capacity-assignment-accepted" ||
    workspace.state === "completed";
  const requiresPhysicalId =
    workspace.state === "create-accepted" ||
    workspace.state === "metadata-update-submitting" ||
    workspace.state === "metadata-update-accepted" ||
    workspace.state === "capacity-assignment-submitting" ||
    workspace.state === "capacity-assignment-accepted" ||
    workspace.state === "completed";
  const actionStateMatches =
    (workspace.action === "create" &&
      (workspace.state === "create-submitting" ||
        workspace.state === "create-accepted" ||
        workspace.state === "capacity-assignment-submitting" ||
        workspace.state === "capacity-assignment-accepted" ||
        workspace.state === "completed")) ||
    (workspace.action === "update" &&
      (workspace.state === "metadata-update-submitting" ||
        workspace.state === "metadata-update-accepted" ||
        workspace.state === "capacity-assignment-submitting" ||
        workspace.state === "capacity-assignment-accepted" ||
        workspace.state === "completed")) ||
    (workspace.action === "no-op" &&
      workspace.state === "completed");
  return (
    (workspace.action === "create" ||
      workspace.action === "update" ||
      workspace.action === "no-op") &&
    validState &&
    actionStateMatches &&
    (!requiresPhysicalId ||
      (typeof workspace.physicalId === "string" &&
        workspace.physicalId.length > 0)) &&
    (workspace.physicalId === undefined ||
      typeof workspace.physicalId === "string") &&
    typeof workspace.updatedAt === "string" &&
    !Number.isNaN(Date.parse(workspace.updatedAt))
  );
}

function isCheckpointNetworkProtection(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const state = value as Partial<
    NonNullable<ApplyCheckpoint["networkProtection"]>
  >;
  const surfaces = [
    state.communicationPolicy,
    state.outboundCloudConnectionRules,
    state.outboundGatewayRules,
  ];
  return (
    typeof state.workspaceId === "string" &&
    state.workspaceId.length > 0 &&
    (state.communicationPolicy === undefined ||
      isCheckpointNetworkSurface(state.communicationPolicy)) &&
    (state.outboundCloudConnectionRules === undefined ||
      isCheckpointNetworkSurface(state.outboundCloudConnectionRules)) &&
    (state.outboundGatewayRules === undefined ||
      isCheckpointNetworkSurface(state.outboundGatewayRules)) &&
    (state.managedPrivateEndpoints === undefined ||
      (state.managedPrivateEndpoints !== null &&
        typeof state.managedPrivateEndpoints === "object" &&
        !Array.isArray(state.managedPrivateEndpoints) &&
        Object.entries(state.managedPrivateEndpoints).every(
          ([key, endpoint]) =>
            isCheckpointManagedPrivateEndpoint(key, endpoint),
        ) &&
        Object.keys(state.managedPrivateEndpoints).every(
          (key, index, keys) =>
            index === 0 ||
            compareCanonicalStrings(keys[index - 1]!, key) < 0,
        ))) &&
    (state.completedAt === undefined ||
      (typeof state.completedAt === "string" &&
        !Number.isNaN(Date.parse(state.completedAt)) &&
        surfaces.every(
          (surface) => surface === undefined || surface.phase === "verified",
        ))) &&
    typeof state.updatedAt === "string" &&
    !Number.isNaN(Date.parse(state.updatedAt))
  );
}

function isCheckpointManagedPrivateEndpoint(
  key: string,
  value: unknown,
): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const state = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "name",
    "desiredState",
    "action",
    "operationHash",
    "desiredIdentityHash",
    "phase",
    "physicalId",
    "observedIdentityHash",
    "observedProvisioningState",
    "observedConnectionStatus",
    "approvalRequired",
    "submittedAt",
    "verifiedAt",
    "deletedAt",
    "recreateNotBefore",
    "updatedAt",
  ]);
  if (Object.keys(state).some((name) => !allowedKeys.has(name))) {
    return false;
  }
  const name = state.name;
  const desiredState = state.desiredState;
  const action = state.action;
  const phase = state.phase;
  if (
    typeof name !== "string" ||
    managedPrivateEndpointCheckpointKey(name) !== key ||
    (desiredState !== "present" && desiredState !== "absent") ||
    (action !== "create" &&
      action !== "delete" &&
      action !== "no-op") ||
    !/^[a-f0-9]{64}$/.test(String(state.operationHash)) ||
    !/^[a-f0-9]{64}$/.test(String(state.desiredIdentityHash)) ||
    ![
      "create-submitting",
      "provisioning",
      "present-verified",
      "delete-submitting",
      "absent-verified",
    ].includes(String(phase)) ||
    (state.physicalId !== undefined &&
      (typeof state.physicalId !== "string" ||
        !GUID_PATTERN.test(state.physicalId))) ||
    (state.observedIdentityHash !== undefined &&
      !/^[a-f0-9]{64}$/.test(
        String(state.observedIdentityHash),
      )) ||
    (state.observedProvisioningState !== undefined &&
      (typeof state.observedProvisioningState !== "string" ||
        state.observedProvisioningState.length === 0 ||
        state.observedProvisioningState.trim() !==
          state.observedProvisioningState)) ||
    (state.observedConnectionStatus !== undefined &&
      (typeof state.observedConnectionStatus !== "string" ||
        state.observedConnectionStatus.length === 0 ||
        state.observedConnectionStatus.trim() !==
          state.observedConnectionStatus)) ||
    (state.approvalRequired !== undefined &&
      state.approvalRequired !== true) ||
    !isOptionalTimestamp(state.submittedAt) ||
    !isOptionalTimestamp(state.verifiedAt) ||
    !isOptionalTimestamp(state.deletedAt) ||
    !isOptionalTimestamp(state.recreateNotBefore) ||
    !isOptionalTimestamp(state.updatedAt) ||
    state.updatedAt === undefined
  ) {
    return false;
  }
  const phaseMatchesAction =
    (action === "create" &&
      desiredState === "present" &&
      (phase === "create-submitting" ||
        phase === "provisioning" ||
        phase === "present-verified")) ||
    (action === "delete" &&
      desiredState === "absent" &&
      (phase === "delete-submitting" ||
        phase === "absent-verified")) ||
    (action === "no-op" &&
      ((desiredState === "present" &&
        phase === "present-verified") ||
        (desiredState === "absent" &&
          phase === "absent-verified")));
  const requiresPhysicalId =
    phase === "provisioning" ||
    phase === "present-verified" ||
    phase === "delete-submitting" ||
    action === "delete";
  const deletionTimestampsValid =
    (state.deletedAt === undefined &&
      state.recreateNotBefore === undefined) ||
    (phase === "absent-verified" &&
      action === "delete" &&
      typeof state.deletedAt === "string" &&
      typeof state.recreateNotBefore === "string" &&
      Date.parse(state.recreateNotBefore) -
        Date.parse(state.deletedAt) ===
        MANAGED_PRIVATE_ENDPOINT_RECREATE_DELAY_MS);
  const phaseFieldsValid =
    (phase === "create-submitting" &&
      typeof state.submittedAt === "string" &&
      state.physicalId === undefined &&
      state.observedIdentityHash === undefined &&
      state.observedProvisioningState === undefined &&
      state.observedConnectionStatus === undefined &&
      state.approvalRequired === undefined &&
      state.verifiedAt === undefined) ||
    (phase === "provisioning" &&
      typeof state.submittedAt === "string" &&
      typeof state.physicalId === "string" &&
      typeof state.observedIdentityHash === "string" &&
      typeof state.observedProvisioningState === "string" &&
      state.approvalRequired === undefined &&
      state.verifiedAt === undefined) ||
    (phase === "present-verified" &&
      typeof state.physicalId === "string" &&
      typeof state.observedIdentityHash === "string" &&
      String(state.observedProvisioningState).toLowerCase() ===
        "succeeded" &&
      (String(state.observedConnectionStatus).toLowerCase() ===
        "pending" ||
        String(state.observedConnectionStatus).toLowerCase() ===
          "approved") &&
      (state.approvalRequired === true) ===
        (String(state.observedConnectionStatus).toLowerCase() ===
          "pending") &&
      state.submittedAt === undefined &&
      typeof state.verifiedAt === "string") ||
    (phase === "delete-submitting" &&
      typeof state.submittedAt === "string" &&
      typeof state.physicalId === "string" &&
      typeof state.observedIdentityHash === "string" &&
      typeof state.observedProvisioningState === "string" &&
      state.approvalRequired === undefined &&
      state.verifiedAt === undefined) ||
    (phase === "absent-verified" &&
      typeof state.verifiedAt === "string" &&
      state.submittedAt === undefined &&
      state.approvalRequired === undefined &&
      ((action === "delete" &&
        typeof state.physicalId === "string" &&
        typeof state.observedIdentityHash === "string" &&
        typeof state.deletedAt === "string" &&
        typeof state.recreateNotBefore === "string") ||
        (action === "no-op" &&
          desiredState === "absent" &&
          state.physicalId === undefined &&
          state.observedIdentityHash === undefined &&
          state.deletedAt === undefined &&
          state.recreateNotBefore === undefined)));
  return (
    phaseMatchesAction &&
    phaseFieldsValid &&
    (!requiresPhysicalId ||
      typeof state.physicalId === "string") &&
    deletionTimestampsValid
  );
}

function isOptionalTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && !Number.isNaN(Date.parse(value)))
  );
}

function isCheckpointNetworkSurface(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const surface = value as Record<string, unknown>;
  return (
    /^[a-f0-9]{64}$/.test(String(surface.desiredHash)) &&
    (surface.phase === "submitting" || surface.phase === "verified") &&
    typeof surface.updatedAt === "string" &&
    !Number.isNaN(Date.parse(surface.updatedAt as string))
  );
}

function isCheckpointItem(logicalId: string, value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<ApplyCheckpoint["completedItems"][string]>;
  return (
    item.logicalId === logicalId &&
    (item.action === "create" ||
      item.action === "update" ||
      item.action === "delete" ||
      item.action === "no-op") &&
    (item.physicalId === undefined ||
      (typeof item.physicalId === "string" &&
        item.physicalId.length > 0)) &&
    typeof item.completedAt === "string" &&
    !Number.isNaN(Date.parse(item.completedAt))
  );
}
