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

import type {
  ApplyCheckpoint,
  ApplyResult,
  DeploymentPlan,
} from "./types";

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
      completed.action !== planned.action
    ) {
      throw new Error(
        `Checkpoint item '${logicalId}' does not match the approved deployment plan.`,
      );
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
      Object.hasOwn(checkpoint.completedItems, logicalId)
    ) {
      throw new Error(
        `Checkpoint operation '${logicalId}' does not match the approved deployment plan.`,
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
      Object.hasOwn(checkpoint.completedItems, logicalId)
    ) {
      throw new Error(
        `Checkpoint update intent '${logicalId}' does not match the approved deployment plan.`,
      );
    }
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
      )
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

function isCheckpointItem(logicalId: string, value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<ApplyCheckpoint["completedItems"][string]>;
  return (
    item.logicalId === logicalId &&
    (item.action === "create" ||
      item.action === "update" ||
      item.action === "no-op") &&
    typeof item.physicalId === "string" &&
    item.physicalId.length > 0 &&
    typeof item.completedAt === "string" &&
    !Number.isNaN(Date.parse(item.completedAt))
  );
}
