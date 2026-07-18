import { rehashPlan } from "../planner";
import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "../hash";
import type {
  DeploymentPlan,
  LoadedManifest,
  PlannedItem,
} from "../types";
import type { EnvironmentAdapter } from "./environment";
import type { LakehouseAdapter } from "./lakehouse";
import {
  buildLakehouseTableCreateOperations,
  type LakehouseTablesAdapter,
} from "./lakehouse-tables";
import type { NotebookAdapter } from "./notebook";
import type { PipelineAdapter } from "./pipeline";
import type { SparkCustomPoolAdapter } from "./spark-custom-pool";
import type { SparkJobAdapter } from "./spark-job";
import {
  materializeSparkJobArtifactUris,
  planSparkJobArtifacts,
  requireSparkJobArtifactTarget,
} from "./spark-job-artifacts";
import type { WorkspaceAdapter } from "./workspace";
import {
  materializeSparkJobDefinitionWithProof,
  validateLogicalReferenceDeclarations,
} from "./logical-references";

export interface FabricPlanAdapters {
  workspace?: Pick<WorkspaceAdapter, "plan">;
  lakehouse: Pick<LakehouseAdapter, "plan">;
  environment: Pick<EnvironmentAdapter, "plan">;
  notebook: Pick<NotebookAdapter, "plan">;
  sparkJob: Pick<SparkJobAdapter, "plan"> &
    Partial<Pick<SparkJobAdapter, "planUnresolvedReferences">>;
  pipeline: Pick<PipelineAdapter, "plan">;
  sparkCustomPool: Pick<SparkCustomPoolAdapter, "plan">;
  lakehouseTables?: Pick<LakehouseTablesAdapter, "plan">;
  oneLakeArtifacts?: {
    dfsEndpoint: string;
    blobEndpoint: string;
    stager: Parameters<typeof planSparkJobArtifacts>[0]["stager"];
  };
}

export async function enrichPlanWithFabric(
  plan: DeploymentPlan,
  loadedManifest: LoadedManifest,
  adapters: FabricPlanAdapters,
): Promise<DeploymentPlan> {
  validateManifestLogicalReferences(loadedManifest);
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

  const plannedItems = new Map<string, PlannedItem>();
  const planningOrder = [
    ...plan.items.filter(
      (item) =>
        item.type !== "SparkJobDefinition" &&
        item.type !== "LakehouseTables",
    ),
    ...plan.items.filter(
      (item) => item.type === "LakehouseTables",
    ),
    ...plan.items.filter(
      (item) => item.type === "SparkJobDefinition",
    ),
  ];
  for (const item of planningOrder) {
    if (item.type === "LakehouseTables") {
      plannedItems.set(
        item.logicalId,
        await planLakehouseTables(
          workspaceId,
          plan,
          item,
          loadedManifest,
          plannedItems,
          adapters.lakehouseTables,
        ),
      );
      continue;
    }
    if (
      item.type !== "Lakehouse" &&
      item.type !== "Environment" &&
      item.type !== "SparkCustomPool" &&
      item.type !== "Notebook" &&
      item.type !== "SparkJobDefinition" &&
      item.type !== "DataPipeline"
    ) {
      plannedItems.set(item.logicalId, {
        ...item,
        reason: `Online discovery for ${item.type} is planned for a later workload adapter.`,
      });
      continue;
    }

    async function planLakehouseTables(
      workspaceId: string,
      plan: DeploymentPlan,
      item: PlannedItem,
      loaded: LoadedManifest,
      plannedItems: ReadonlyMap<string, PlannedItem>,
      adapter: Pick<LakehouseTablesAdapter, "plan"> | undefined,
    ): Promise<PlannedItem> {
      const desired = loaded.itemDefinitions[item.logicalId];
      const definition =
        loaded.lakehouseTablesDefinitions?.[item.logicalId];
      const targetLogicalId = desired?.references?.lakehouse;
      const target = targetLogicalId
        ? plannedItems.get(targetLogicalId)
        : undefined;
      if (!desired || !definition || !targetLogicalId || !target) {
        return {
          ...item,
          action: "blocked",
          reason:
            "LakehouseTables source snapshot or target Lakehouse plan is missing.",
        };
      }
      const execution = {
        sourceHash: definition.sourceHash,
        attemptId: `${plan.deploymentId}.${item.logicalId}.plan`,
        deploymentId: plan.deploymentId,
        bundleLogicalId: item.logicalId,
        targetLakehouseLogicalId: targetLogicalId,
      };
      const canonicalOperations =
        buildLakehouseTableCreateOperations(definition, execution);
      if (target.action === "create") {
        const targetDefinition = loaded.itemDefinitions[targetLogicalId];
        const unsupported = definition.tables.find(
          (table) =>
            targetDefinition?.enableSchemas !== true ||
            table.table.schema !== "dbo",
        );
        if (unsupported) {
          return {
            ...item,
            action: "blocked",
            reason: `New target Lakehouse '${targetLogicalId}' cannot prove schema '${unsupported.table.schema}' exists. Phase 3 only symbolically plans dbo tables for schema-enabled Lakehouses.`,
          };
        }
        const observedStateHash = sha256(
          stableJson({
            target: targetLogicalId,
            state: "new-lakehouse-empty",
          }),
        );
        return {
          ...item,
          action: "create",
          reason: `${canonicalOperations.length} Lakehouse table(s) require creation after the target Lakehouse is created.`,
          observedStateHash,
          lakehouseTables: {
            targetLakehouseLogicalId: targetLogicalId,
            targetBinding: "symbolic",
            desiredHash: definition.desiredHash,
            sourceHash: definition.sourceHash,
            observedStateHash,
            operations: canonicalOperations.map((operation) => ({
              action: "create",
              operationId: operation.operationId,
              operationHash: operation.operationHash,
              order: operation.order,
              logicalId: operation.logicalId,
              identifier: operation.identifier,
              desiredHash: operation.desiredHash,
              observedHash: "absent",
              reason: `Table '${operation.identifier}' is absent in the new Lakehouse.`,
            })),
          },
        };
      }
      if (target.action !== "no-op" || !target.physicalId) {
        return {
          ...item,
          action: "blocked",
          reason: `Target Lakehouse '${targetLogicalId}' is '${target.action}'; table DDL planning requires an existing no-op target or a same-plan create.`,
        };
      }
      if (!adapter) {
        return {
          ...item,
          action: "blocked",
          reason: "LakehouseTables adapter was not initialized.",
        };
      }
      const live = await adapter.plan(
        workspaceId,
        target.physicalId,
        definition,
        execution,
      );
      const operationByLogicalId = new Map(
        canonicalOperations.map((operation) => [
          operation.logicalId,
          operation,
        ]),
      );
      return {
        ...item,
        action: live.action === "adopt" ? "blocked" : live.action,
        reason:
          live.action === "adopt"
            ? `${live.reason} Adoption is blocked because Phase 3 does not execute ALTER TABLE.`
            : live.reason,
        physicalId: target.physicalId,
        observedStateHash: live.observedStateHash,
        lakehouseTables: {
          targetLakehouseLogicalId: targetLogicalId,
          targetLakehousePhysicalId: target.physicalId,
          targetBinding: "physical",
          desiredHash: definition.desiredHash,
          sourceHash: definition.sourceHash,
          observedStateHash: live.observedStateHash,
          operations: live.tables.map((table, order) => {
            const canonical = operationByLogicalId.get(table.logicalId);
            if (!canonical) {
              throw new Error(
                `Lakehouse table operation '${table.logicalId}' is missing from the canonical source.`,
              );
            }
            return {
              action: table.action,
              operationId:
                table.adoptionOperation?.operationId ??
                canonical.operationId,
              operationHash:
                table.adoptionOperation?.operationHash ??
                canonical.operationHash,
              order,
              logicalId: table.logicalId,
              identifier: table.identifier,
              desiredHash: table.desiredHash,
              observedHash: table.observedHash,
              reason: table.reason,
            };
          }),
        },
      };
    }

    const desired = loadedManifest.itemDefinitions[item.logicalId];
    if (!desired) {
      plannedItems.set(item.logicalId, {
        ...item,
        action: "blocked" as const,
        reason: `The resolved ${item.type} item definition is missing.`,
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
              ? await planSparkJob(
                  workspaceId,
                  plan,
                  item,
                  desired,
                  loadedManifest,
                  plannedItems,
                  adapters.sparkJob,
                  adapters.oneLakeArtifacts,
                )
              : await adapters.pipeline.plan(
                  workspaceId,
                  desired,
                  requirePipelineDefinition(
                    loadedManifest,
                    item.logicalId,
                  ),
                );
    plannedItems.set(item.logicalId, {
      ...item,
      action: result.action,
      reason: result.reason,
      observedStateHash: result.observedStateHash,
      ...("physicalId" in result &&
      typeof result.physicalId === "string"
        ? { physicalId: result.physicalId }
        : {}),
      ...("materializedDefinitionHash" in result &&
      typeof result.materializedDefinitionHash === "string"
        ? {
            materializedDefinitionHash:
              result.materializedDefinitionHash,
          }
        : {}),
      ...("resolvedBindingsHash" in result &&
      typeof result.resolvedBindingsHash === "string"
        ? {
            resolvedBindingsHash: result.resolvedBindingsHash,
          }
        : {}),
      ...("sparkJobArtifacts" in result &&
      result.sparkJobArtifacts !== undefined
        ? { sparkJobArtifacts: result.sparkJobArtifacts }
        : {}),
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
    items: plan.items.map((item) => {
      const planned = plannedItems.get(item.logicalId);
      if (!planned) {
        throw new Error(
          `Online plan result is missing for '${item.logicalId}'.`,
        );
      }
      return planned;
    }),
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

function validateManifestLogicalReferences(
  loadedManifest: LoadedManifest,
): void {
  for (const item of loadedManifest.manifest.items) {
    const definition =
      loadedManifest.itemDefinitions[item.logicalId];
    if (!definition) {
      throw new Error(
        `The resolved ${item.type} item definition is missing.`,
      );
    }
    validateLogicalReferenceDeclarations({
      item,
      definition,
      itemGraph: loadedManifest.manifest.items,
    });
  }
}

async function planSparkJob(
  workspaceId: string,
  plan: DeploymentPlan,
  item: PlannedItem,
  desired: NonNullable<
    LoadedManifest["itemDefinitions"][string]
  >,
  loadedManifest: LoadedManifest,
  plannedItems: ReadonlyMap<string, PlannedItem>,
  adapter: FabricPlanAdapters["sparkJob"],
  oneLakeArtifacts: FabricPlanAdapters["oneLakeArtifacts"],
) {
  const sourceDefinition =
    loadedManifest.sparkJobDefinitions[item.logicalId];
  if (!sourceDefinition) {
    throw new Error(
      `The resolved Spark Job Definition is missing for '${item.logicalId}'.`,
    );
  }
  const manifestItem = loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === item.logicalId,
  );
  if (!manifestItem) {
    throw new Error(
      `Manifest item '${item.logicalId}' is missing during Spark Job planning.`,
    );
  }
  const bindings = validateLogicalReferenceDeclarations({
    item: manifestItem,
    definition: desired,
    itemGraph: loadedManifest.manifest.items,
  });
  const artifactSources =
    loadedManifest.sparkJobArtifactSources?.[item.logicalId] ?? [];
  const artifactTargetLogicalId = requireSparkJobArtifactTarget(
    item.logicalId,
    bindings,
    artifactSources,
  );
  if (
    Object.keys(bindings).length === 0 &&
    artifactSources.length === 0
  ) {
    return adapter.plan(workspaceId, desired, sourceDefinition);
  }

  const physicalIds: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const binding of Object.values(bindings)) {
    if (!binding) {
      continue;
    }
    const dependency = plannedItems.get(binding.logicalId);
    if (
      dependency?.physicalId &&
      (dependency.action === "update" ||
        dependency.action === "no-op")
    ) {
      physicalIds[binding.logicalId] = dependency.physicalId;
      continue;
    }
    if (dependency?.action === "create") {
      unresolved.push(binding.logicalId);
      continue;
    }
    return {
      action: "blocked" as const,
      reason: `Spark Job Definition '${desired.displayName}' cannot resolve logical dependency '${binding.logicalId}' because its current plan action is '${dependency?.action ?? "missing"}'.`,
      observedStateHash: sha256(stableJson(null)),
    };
  }

  let sparkJobArtifacts;
  if (artifactTargetLogicalId) {
    const target = plannedItems.get(artifactTargetLogicalId);
    if (!target || target.type !== "Lakehouse") {
      return {
        action: "blocked" as const,
        reason: `Spark Job Definition '${desired.displayName}' cannot resolve its OneLake staging target '${artifactTargetLogicalId}'.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    if (
      target.action !== "create" &&
      target.action !== "update" &&
      target.action !== "no-op"
    ) {
      return {
        action: "blocked" as const,
        reason: `Spark Job Definition '${desired.displayName}' cannot stage artifacts while Lakehouse '${artifactTargetLogicalId}' is '${target.action}'.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    if (target.action !== "create" && !target.physicalId) {
      return {
        action: "blocked" as const,
        reason: `Spark Job Definition '${desired.displayName}' cannot stage artifacts because Lakehouse '${artifactTargetLogicalId}' has no physical ID.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    sparkJobArtifacts = await planSparkJobArtifacts({
      deploymentId: plan.deploymentId,
      environment: plan.environment,
      workspaceId,
      logicalId: item.logicalId,
      targetLakehouseLogicalId: artifactTargetLogicalId,
      ...(target.action === "create"
        ? {}
        : { targetLakehousePhysicalId: target.physicalId }),
      sources: artifactSources,
      oneLakeDfsEndpoint:
        oneLakeArtifacts?.dfsEndpoint ??
        "https://onelake.dfs.fabric.microsoft.com",
      oneLakeBlobEndpoint:
        oneLakeArtifacts?.blobEndpoint ??
        "https://onelake.blob.fabric.microsoft.com",
      stager: oneLakeArtifacts?.stager,
    });
    const blockedArtifact = sparkJobArtifacts?.artifacts.find(
      (artifact) => artifact.action === "blocked",
    );
    if (blockedArtifact) {
      return {
        action: "blocked" as const,
        reason: blockedArtifact.reason,
        observedStateHash: sha256(
          stableJson(
            sparkJobArtifacts?.artifacts.map((artifact) => ({
              operationHash: artifact.operationHash,
              action: artifact.action,
              observedHash: artifact.observedHash,
            })),
          ),
        ),
        sparkJobArtifacts,
      };
    }
  }

  if (unresolved.length > 0) {
    const unresolvedLogicalIds = [
      ...new Set(unresolved),
    ].sort(compareCanonicalStrings);
    if (!adapter.planUnresolvedReferences) {
      return {
        action: "blocked" as const,
        reason: `Spark Job Definition '${desired.displayName}' requires physical IDs for newly created dependencies (${unresolvedLogicalIds.join(", ")}); replan after they exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    const unresolvedResult =
      await adapter.planUnresolvedReferences(
      workspaceId,
      desired,
        unresolvedLogicalIds,
    );
    if (
      unresolvedResult.action !== "create" &&
      unresolvedResult.action !== "blocked"
    ) {
      throw new Error(
        `Spark Job Definition '${desired.displayName}' returned unsafe action '${unresolvedResult.action}' before logical dependency IDs were available.`,
      );
    }
    return {
      ...unresolvedResult,
      ...(sparkJobArtifacts ? { sparkJobArtifacts } : {}),
    };
  }

  const artifactMaterializations =
    sparkJobArtifacts && artifactTargetLogicalId
      ? materializeSparkJobArtifactUris(
          sparkJobArtifacts,
          artifactSources,
          oneLakeArtifacts?.dfsEndpoint ??
            "https://onelake.dfs.fabric.microsoft.com",
          workspaceId,
          physicalIds[artifactTargetLogicalId]!,
          plan.deploymentId,
          plan.environment,
          item.logicalId,
        )
      : [];
  const materialized = materializeSparkJobDefinitionWithProof(
    sourceDefinition,
    bindings,
    physicalIds,
    artifactMaterializations,
  );
  return {
    ...(await adapter.plan(
      workspaceId,
      desired,
      materialized.definition,
    )),
    materializedDefinitionHash:
      materialized.materializedDefinitionHash,
    resolvedBindingsHash: materialized.resolvedBindingsHash,
    ...(sparkJobArtifacts ? { sparkJobArtifacts } : {}),
  };
}
