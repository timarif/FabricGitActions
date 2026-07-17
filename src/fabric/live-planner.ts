import { rehashPlan } from "../planner";
import type { DeploymentPlan, LoadedManifest } from "../types";
import type { EnvironmentAdapter } from "./environment";
import type { LakehouseAdapter } from "./lakehouse";
import type { NotebookAdapter } from "./notebook";
import type { PipelineAdapter } from "./pipeline";
import type { SparkCustomPoolAdapter } from "./spark-custom-pool";
import type { SparkJobAdapter } from "./spark-job";

export interface FabricPlanAdapters {
  lakehouse: Pick<LakehouseAdapter, "plan">;
  environment: Pick<EnvironmentAdapter, "plan">;
  notebook: Pick<NotebookAdapter, "plan">;
  sparkJob: Pick<SparkJobAdapter, "plan">;
  pipeline: Pick<PipelineAdapter, "plan">;
  sparkCustomPool: Pick<SparkCustomPoolAdapter, "plan">;
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
      item.type !== "SparkCustomPool" &&
      item.type !== "Notebook" &&
      item.type !== "SparkJobDefinition" &&
      item.type !== "DataPipeline"
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
    if (
      item.type === "SparkJobDefinition" &&
      (Object.keys(desired.references ?? {}).length > 0 ||
        (desired.bindings?.length ?? 0) > 0)
    ) {
      plannedItems.push({
        ...item,
        action: "blocked" as const,
        reason:
          "Spark Job Definition logical references and bindings require the Phase 3 reference resolver; use explicit artifact IDs in SparkJobDefinitionV1.json until it is implemented.",
      });
      continue;
    }
    if (
      item.type !== "SparkJobDefinition" &&
      (Object.keys(desired.references ?? {}).length > 0 ||
        (desired.bindings?.length ?? 0) > 0)
    ) {
      plannedItems.push({
        ...item,
        action: "blocked" as const,
        reason: `${item.type} logical references and bindings are not supported and cannot be ignored.`,
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
              requireEnvironmentDefinition(
                loadedManifest,
                item.logicalId,
              ),
            )
          : item.type === "SparkCustomPool"
            ? await adapters.sparkCustomPool.plan(
                plan.workspaceId,
                desired,
                requireSparkCustomPoolDefinition(
                  loadedManifest,
                  item.logicalId,
                ),
              )
          : item.type === "Notebook"
            ? await adapters.notebook.plan(
                plan.workspaceId,
                desired,
                requireNotebookDefinition(
                  loadedManifest,
                  item.logicalId,
                ),
              )
            : item.type === "SparkJobDefinition"
              ? await adapters.sparkJob.plan(
                  plan.workspaceId,
                  desired,
                  requireSparkJobDefinition(
                    loadedManifest,
                    item.logicalId,
                  ),
                )
              : await adapters.pipeline.plan(
                  plan.workspaceId,
                  desired,
                  requirePipelineDefinition(
                    loadedManifest,
                    item.logicalId,
                  ),
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

  function requireSparkJobDefinition(
    loadedManifest: LoadedManifest,
    logicalId: string,
  ) {
    const definition =
      loadedManifest.sparkJobDefinitions[logicalId];
    if (!definition) {
      throw new Error(
        `The resolved Spark Job Definition is missing for '${logicalId}'.`,
      );
    }
    return definition;
  }

  function requirePipelineDefinition(
    loadedManifest: LoadedManifest,
    logicalId: string,
  ) {
    const definition =
      loadedManifest.pipelineDefinitions[logicalId];
    if (!definition) {
      throw new Error(
        `The resolved Data Pipeline definition is missing for '${logicalId}'.`,
      );
    }
    return definition;
  }

  function requireSparkCustomPoolDefinition(
    loadedManifest: LoadedManifest,
    logicalId: string,
  ) {
    const definition =
      loadedManifest.sparkCustomPoolDefinitions[logicalId];
    if (!definition) {
      throw new Error(
        `The resolved Spark custom pool definition is missing for '${logicalId}'.`,
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
