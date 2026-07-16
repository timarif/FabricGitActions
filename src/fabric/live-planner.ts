import { rehashPlan } from "../planner";
import type { DeploymentPlan, LoadedManifest } from "../types";
import type { LakehouseAdapter } from "./lakehouse";

export async function enrichPlanWithFabric(
  plan: DeploymentPlan,
  loadedManifest: LoadedManifest,
  lakehouseAdapter: Pick<LakehouseAdapter, "plan">,
): Promise<DeploymentPlan> {
  const plannedItems = [];
  for (const item of plan.items) {
    if (item.type !== "Lakehouse") {
      plannedItems.push({
        ...item,
        reason: `Online discovery for ${item.type} is planned for a later workload adapter.`,
      });
      continue;
    }

    const desired = loadedManifest.itemDefinitions[item.logicalId];
    if (!desired) {
      plannedItems.push({
        ...item,
        action: "blocked" as const,
        reason: "The resolved Lakehouse item definition is missing.",
      });
      continue;
    }

    const result = await lakehouseAdapter.plan(plan.workspaceId, desired);
    plannedItems.push({
      ...item,
      action: result.action,
      reason: result.reason,
      observedStateHash: result.observedStateHash,
      ...(result.physicalId === undefined
        ? {}
        : { physicalId: result.physicalId }),
    });
  }

  return rehashPlan({
    ...plan,
    items: plannedItems,
  });
}
