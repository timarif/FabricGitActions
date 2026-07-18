import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { rehashPlan } from "./planner";
import {
  FABRIC_ITEM_TYPES,
  type DeploymentPlan,
  type PlannedAction,
  type PlannedItem,
  type PlannedWorkspace,
} from "./types";

const PLANNED_ACTIONS = new Set<PlannedAction>([
  "create",
  "update",
  "no-op",
  "blocked",
  "unknown",
]);

export function loadApprovedPlan(planFile: string): DeploymentPlan {
  const absolutePath = path.resolve(planFile);
  if (!existsSync(absolutePath)) {
    throw new Error(`Approved plan file not found: ${absolutePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    throw new Error(`Approved plan file is not valid JSON: ${absolutePath}`);
  }

  if (!isDeploymentPlan(parsed)) {
    throw new Error(`Approved plan file has an invalid structure: ${absolutePath}`);
  }
  if (parsed.mode !== "plan") {
    throw new Error("Approved plan must have mode 'plan'.");
  }

  const calculatedHash = rehashPlan(parsed).planHash;
  if (calculatedHash !== parsed.planHash) {
    throw new Error(
      `Approved plan hash is invalid. Expected ${calculatedHash}, received ${parsed.planHash}.`,
    );
  }
  return parsed;
}

function isDeploymentPlan(value: unknown): value is DeploymentPlan {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const plan = value as Partial<DeploymentPlan>;
  if (
    plan.schemaVersion === "1" &&
    typeof plan.mode === "string" &&
    typeof plan.deploymentId === "string" &&
    typeof plan.environment === "string" &&
    typeof plan.workspaceId === "string" &&
    (plan.workspace === undefined ||
      isPlannedWorkspace(plan.workspace)) &&
    typeof plan.sourceHash === "string" &&
    typeof plan.resolvedHash === "string" &&
    typeof plan.planHash === "string" &&
    typeof plan.generatedAt === "string" &&
    Array.isArray(plan.stages) &&
    Array.isArray(plan.items)
  ) {
    const items = plan.items as unknown[];
    if (!items.every(isPlannedItem)) {
      return false;
    }

    const itemIds = items.map((item) => (item as PlannedItem).logicalId);
    const stagedIds: string[] = [];
    for (const stage of plan.stages as unknown[]) {
      if (
        !Array.isArray(stage) ||
        !stage.every((logicalId) => typeof logicalId === "string")
      ) {
        return false;
      }
      stagedIds.push(...stage);
    }
    return (
      new Set(itemIds).size === itemIds.length &&
      new Set(stagedIds).size === stagedIds.length &&
      itemIds.length === stagedIds.length &&
      itemIds.every((logicalId) => stagedIds.includes(logicalId)) &&
      (plan.sourceCommit === undefined ||
        typeof plan.sourceCommit === "string")
    );
  }
  return false;
}

function isPlannedWorkspace(
  value: unknown,
): value is PlannedWorkspace {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const workspace = value as Partial<PlannedWorkspace>;
  return (
    typeof workspace.displayName === "string" &&
    typeof workspace.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(workspace.contentHash) &&
    PLANNED_ACTIONS.has(workspace.action as PlannedAction) &&
    typeof workspace.reason === "string" &&
    (workspace.physicalId === undefined ||
      typeof workspace.physicalId === "string") &&
    (workspace.observedStateHash === undefined ||
      typeof workspace.observedStateHash === "string") &&
    (workspace.metadataUpdateRequired === undefined ||
      typeof workspace.metadataUpdateRequired === "boolean") &&
    (workspace.capacityAssignmentRequired === undefined ||
      typeof workspace.capacityAssignmentRequired === "boolean")
  );
}

function isPlannedItem(value: unknown): value is PlannedItem {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<PlannedItem>;
  return (
    typeof item.logicalId === "string" &&
    FABRIC_ITEM_TYPES.some((type) => type === item.type) &&
    typeof item.path === "string" &&
    Array.isArray(item.dependsOn) &&
    item.dependsOn.every((dependency) => typeof dependency === "string") &&
    item.desiredState === "present" &&
    typeof item.contentHash === "string" &&
    typeof item.displayName === "string" &&
    PLANNED_ACTIONS.has(item.action as PlannedAction) &&
    typeof item.reason === "string" &&
    (item.physicalId === undefined || typeof item.physicalId === "string") &&
    (item.observedStateHash === undefined ||
      typeof item.observedStateHash === "string") &&
    (item.materializedDefinitionHash === undefined ||
      /^[a-f0-9]{64}$/.test(item.materializedDefinitionHash)) &&
    (item.resolvedBindingsHash === undefined ||
      /^[a-f0-9]{64}$/.test(item.resolvedBindingsHash)) &&
    (item.materializedDefinitionHash === undefined) ===
      (item.resolvedBindingsHash === undefined) &&
    (item.type === "LakehouseTables"
      ? item.lakehouseTables === undefined
        ? item.action === "blocked" || item.action === "unknown"
        : isPlannedLakehouseTables(item.lakehouseTables)
      : item.lakehouseTables === undefined)
  );
}

function isPlannedLakehouseTables(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const plan = value as Record<string, unknown>;
  if (
    typeof plan.targetLakehouseLogicalId !== "string" ||
    (plan.targetLakehousePhysicalId !== undefined &&
      typeof plan.targetLakehousePhysicalId !== "string") ||
    (plan.targetBinding !== "physical" &&
      plan.targetBinding !== "symbolic") ||
    !isHash(plan.desiredHash) ||
    !isHash(plan.sourceHash) ||
    typeof plan.observedStateHash !== "string" ||
    !Array.isArray(plan.operations)
  ) {
    return false;
  }
  if (
    (plan.targetBinding === "physical") !==
    (typeof plan.targetLakehousePhysicalId === "string")
  ) {
    return false;
  }
  return plan.operations.every((operation, index) => {
    if (
      operation === null ||
      typeof operation !== "object" ||
      Array.isArray(operation)
    ) {
      return false;
    }
    const entry = operation as Record<string, unknown>;
    return (
      ["create", "adopt", "no-op", "blocked"].includes(
        String(entry.action),
      ) &&
      typeof entry.operationId === "string" &&
      isHash(entry.operationHash) &&
      entry.order === index &&
      typeof entry.logicalId === "string" &&
      typeof entry.identifier === "string" &&
      isHash(entry.desiredHash) &&
      typeof entry.observedHash === "string" &&
      typeof entry.reason === "string"
    );
  });
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
