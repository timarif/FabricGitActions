import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { rehashPlan } from "./planner";
import {
  FABRIC_ITEM_TYPES,
  type DeploymentPlan,
  type PlannedAction,
  type PlannedItem,
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
      typeof item.observedStateHash === "string")
  );
}
