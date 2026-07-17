import { rehashPlan } from "../planner";
import type { DeploymentPlan, LoadedManifest } from "../types";
import type { EnvironmentAdapter } from "./environment";
import type { LakehouseAdapter } from "./lakehouse";
import type { NotebookAdapter } from "./notebook";

export interface FabricPlanAdapters {
  lakehouse: Pick<LakehouseAdapter, "plan">;
  environment: Pick<EnvironmentAdapter, "plan">;
  notebook: Pick<NotebookAdapter, "plan">;
}

export async function enrichPlanWithFabric(
  plan: DeploymentPlan,
  loadedManifest: LoadedManifest,
  adapters: FabricPlanAdapters,
): Promise<DeploymentPlan> {
  const plannedItems = [];
  for (const item of plan.items) {
    if (
      item.type !== "Lakehouse" &&
      item.type !== "Environment" &&
      item.type !== "Notebook"
    ) {
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
        reason: `The resolved ${item.type} item definition is missing.`,
      });
      continue;
    }

    const result =
      item.type === "Lakehouse"
        ? await adapters.lakehouse.plan(plan.workspaceId, desired)
        : item.type === "Environment"
          ? await adapters.environment.plan(
            plan.workspaceId,
            desired,
            requireEnvironmentDefinition(loadedManifest, item.logicalId),
          )
          : await adapters.notebook.plan(
              plan.workspaceId,
              desired,
              requireNotebookDefinition(loadedManifest, item.logicalId),
            );
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

  function requireNotebookDefinition(
    loadedManifest: LoadedManifest,
    logicalId: string,
  ) {
    const definition = loadedManifest.notebookDefinitions[logicalId];
    if (!definition) {
      throw new Error(
        `The resolved Notebook definition is missing for '${logicalId}'.`,
      );
    }
    return definition;
  }

  return rehashPlan({
    ...plan,
    items: plannedItems,
  });
}

function requireEnvironmentDefinition(
  loadedManifest: LoadedManifest,
  logicalId: string,
) {
  const definition = loadedManifest.environmentDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `The resolved Environment definition is missing for '${logicalId}'.`,
    );
  }
  return definition;
}
