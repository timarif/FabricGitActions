import { rehashPlan } from "../planner";
import { sha256, stableJson } from "../hash";
import type {
  DeploymentPlan,
  LoadedManifest,
  PlannedItem,
} from "../types";
import type { EnvironmentAdapter } from "./environment";
import type { LakehouseAdapter } from "./lakehouse";
import type { NotebookAdapter } from "./notebook";
import type { PipelineAdapter } from "./pipeline";
import type { SparkCustomPoolAdapter } from "./spark-custom-pool";
import type { SparkJobAdapter } from "./spark-job";
import type { WorkspaceAdapter } from "./workspace";

export interface FabricPlanAdapters {
  workspace?: Pick<WorkspaceAdapter, "plan">;
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
  let workspaceId = plan.workspaceId;
  let plannedWorkspace = plan.workspace;
  if (plannedWorkspace) {
    const desiredWorkspace = loadedManifest.manifest.workspace;
    if (!desiredWorkspace?.displayName) {
      throw new Error(
        "The managed workspace definition is missing displayName.",
      );
    }
    if (!adapters.workspace) {
      throw new Error(
        "Online managed workspace planning requires a workspace adapter.",
      );
    }
    const workspaceResult = await adapters.workspace.plan({
      ...desiredWorkspace,
      displayName: desiredWorkspace.displayName,
    });
    plannedWorkspace = {
      ...plannedWorkspace,
      action: workspaceResult.action,
      reason: workspaceResult.reason,
      observedStateHash: workspaceResult.observedStateHash,
      ...(workspaceResult.physicalId
        ? { physicalId: workspaceResult.physicalId }
        : {}),
      ...(workspaceResult.capacityAssignmentRequired === undefined
        ? {}
        : {
            capacityAssignmentRequired:
              workspaceResult.capacityAssignmentRequired,
          }),
      ...(workspaceResult.managedMetadataMatches === undefined
        ? {}
        : {
            metadataUpdateRequired:
              !workspaceResult.managedMetadataMatches,
          }),
    };
    if (workspaceResult.physicalId) {
      workspaceId = workspaceResult.physicalId;
    }
    if (
      workspaceResult.action === "create" ||
      workspaceResult.action === "blocked"
    ) {
      return rehashPlan({
        ...plan,
        workspaceId,
        workspace: plannedWorkspace,
        items: plan.items.map((item) =>
          blockItemUntilWorkspaceExists(
            item,
            loadedManifest,
            workspaceResult.action === "create"
              ? "create"
              : "blocked",
          ),
        ),
      });
    }
    if (!workspaceResult.physicalId) {
      throw new Error(
        `Managed workspace planning returned '${workspaceResult.action}' without a physical ID.`,
      );
    }
  }

  const plannedItems: PlannedItem[] = [];
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
    const bindingBlockReason = unsupportedBindingReason(
      item.type,
      desired,
    );
    if (bindingBlockReason) {
      plannedItems.push({
        ...item,
        action: "blocked" as const,
        reason: bindingBlockReason,
      });
      continue;
    }

    const result =
      item.type === "Lakehouse"
        ? await adapters.lakehouse.plan(workspaceId, desired)
        : item.type === "Environment"
          ? await adapters.environment.plan(
              workspaceId,
              desired,
              requireEnvironmentDefinition(
                loadedManifest,
                item.logicalId,
              ),
            )
          : item.type === "SparkCustomPool"
            ? await adapters.sparkCustomPool.plan(
                workspaceId,
                desired,
                requireSparkCustomPoolDefinition(
                  loadedManifest,
                  item.logicalId,
                ),
              )
          : item.type === "Notebook"
            ? await adapters.notebook.plan(
                workspaceId,
                desired,
                requireNotebookDefinition(
                  loadedManifest,
                  item.logicalId,
                ),
              )
            : item.type === "SparkJobDefinition"
              ? await adapters.sparkJob.plan(
                  workspaceId,
                  desired,
                  requireSparkJobDefinition(
                    loadedManifest,
                    item.logicalId,
                  ),
                )
              : await adapters.pipeline.plan(
                  workspaceId,
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
    workspaceId,
    ...(plannedWorkspace ? { workspace: plannedWorkspace } : {}),
    items: plannedItems,
  });
}

function blockItemUntilWorkspaceExists(
  item: PlannedItem,
  loadedManifest: LoadedManifest,
  workspaceAction: "create" | "blocked",
): PlannedItem {
  const desired = loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    return {
      ...item,
      action: "blocked",
      reason: `The resolved ${item.type} item definition is missing.`,
    };
  }
  const bindingBlockReason = unsupportedBindingReason(
    item.type,
    desired,
  );
  if (bindingBlockReason) {
    return {
      ...item,
      action: "blocked",
      reason: bindingBlockReason,
    };
  }
  return {
    ...item,
    action: "blocked",
    reason:
      workspaceAction === "create"
        ? "The managed workspace must be provisioned and approved in a separate apply before workspace items can be planned."
        : "The managed workspace plan is blocked.",
    observedStateHash: sha256(stableJson(null)),
  };
}

function unsupportedBindingReason(
  itemType: PlannedItem["type"],
  desired: NonNullable<LoadedManifest["itemDefinitions"][string]>,
): string | undefined {
  const hasDeclarations =
    Object.keys(desired.references ?? {}).length > 0 ||
    (desired.bindings?.length ?? 0) > 0;
  if (!hasDeclarations) {
    return undefined;
  }
  return itemType === "SparkJobDefinition"
    ? "Spark Job Definition logical references and bindings require the Phase 3 reference resolver; use explicit artifact IDs in SparkJobDefinitionV1.json until it is implemented."
    : `${itemType} logical references and bindings are not supported and cannot be ignored.`;
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
