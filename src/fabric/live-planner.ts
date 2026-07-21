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
  PlannedNetworkProtection,
} from "../types";
import type { EnvironmentAdapter } from "./environment";
import type { EventhouseAdapter } from "./eventhouse";
import type { KqlDatabaseAdapter } from "./kql-database";
import {
  isDeletableFabricItemType,
  type ItemDeletionAdapter,
} from "./item-deletion";
import type { LakehouseAdapter } from "./lakehouse";
import {
  buildLakehouseDdlCreateOperations,
  type LakehouseTablesAdapter,
} from "./lakehouse-tables";
import type { NotebookAdapter } from "./notebook";
import {
  buildBlockedNetworkProtectionPlan,
  type NetworkProtectionAdapter,
} from "./network-protection";
import type { PipelineAdapter } from "./pipeline";
import type { ReportAdapter } from "./report";
import type { SemanticModelAdapter } from "./semantic-model";
import type { SparkCustomPoolAdapter } from "./spark-custom-pool";
import type { SparkJobAdapter } from "./spark-job";
import type { FabricTagAdapter } from "./tags";
import {
  buildTagAssignmentHash,
  getDesiredTagLogicalIds,
} from "./tag-assignment";
import {
  materializeSparkJobArtifactUris,
  planSparkJobArtifacts,
  requireSparkJobArtifactTarget,
} from "./spark-job-artifacts";
import type { WorkspaceAdapter } from "./workspace";
import {
  materializeSparkJobDefinitionWithProof,
  materializeReportDefinitionWithProof,
  materializeKqlDatabaseCreationWithProof,
  validateLogicalReferenceDeclarations,
} from "./logical-references";

export interface FabricPlanAdapters {
  workspace?: Pick<WorkspaceAdapter, "plan">;
  deletion?: Pick<ItemDeletionAdapter, "plan">;
  lakehouse: Pick<LakehouseAdapter, "plan">;
  eventhouse?: Pick<EventhouseAdapter, "plan">;
  kqlDatabase?: Pick<KqlDatabaseAdapter, "plan"> &
    Partial<Pick<KqlDatabaseAdapter, "planUnresolvedParent">>;
  environment: Pick<EnvironmentAdapter, "plan">;
  notebook: Pick<NotebookAdapter, "plan">;
  sparkJob: Pick<SparkJobAdapter, "plan"> &
    Partial<Pick<SparkJobAdapter, "planUnresolvedReferences">>;
  pipeline: Pick<PipelineAdapter, "plan">;
  semanticModel: Pick<SemanticModelAdapter, "plan">;
  report?: Pick<ReportAdapter, "plan"> &
    Partial<Pick<ReportAdapter, "planUnresolvedReferences">>;
  sparkCustomPool: Pick<SparkCustomPoolAdapter, "plan">;
  tags?: Pick<FabricTagAdapter, "plan" | "planItemAssignment">;
  lakehouseTables?: Pick<LakehouseTablesAdapter, "plan">;
  networkProtection?: Pick<NetworkProtectionAdapter, "plan">;
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
      const networkProtection = await planNetworkProtectionIfConfigured(
        loadedManifest,
        workspaceId,
        workspaceResult.action === "create"
          ? "The managed workspace must be provisioned and approved in a separate apply before network protection can be planned."
          : "The managed workspace plan is blocked.",
        adapters.networkProtection,
      );
      return rehashPlan({
        ...plan,
        workspaceId,
        workspace: plannedWorkspace,
        ...(networkProtection ? { networkProtection } : {}),
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
    ...plan.items.filter((item) => item.type === "FabricTag"),
    ...plan.items.filter(
      (item) =>
        item.type !== "FabricTag" &&
        item.type !== "SparkJobDefinition" &&
        item.type !== "LakehouseTables" &&
        item.type !== "KQLDatabase" &&
        item.type !== "Report",
    ),
    ...plan.items.filter((item) => item.type === "KQLDatabase"),
    ...plan.items.filter(
      (item) => item.type === "LakehouseTables",
    ),
    ...plan.items.filter(
      (item) => item.type === "SparkJobDefinition",
    ),
    ...plan.items.filter((item) => item.type === "Report"),
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
      item.type !== "Eventhouse" &&
      item.type !== "KQLDatabase" &&
      item.type !== "Environment" &&
      item.type !== "SparkCustomPool" &&
      item.type !== "Notebook" &&
      item.type !== "SparkJobDefinition" &&
      item.type !== "DataPipeline" &&
      item.type !== "SemanticModel" &&
      item.type !== "Report" &&
      item.type !== "FabricTag"
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
        buildLakehouseDdlCreateOperations(definition, execution);
      if (target.action === "create") {
        const targetDefinition = loaded.itemDefinitions[targetLogicalId];
        if (targetDefinition?.enableSchemas !== true) {
          return {
            ...item,
            action: "blocked",
            reason: `New target Lakehouse '${targetLogicalId}' must set enableSchemas: true before Lakehouse schema or table DDL can be planned.`,
          };
        }
        const declaredSchemaNames = new Set(
          (definition.schemas ?? []).map((schema) => schema.name),
        );
        const unsupported = definition.tables.find(
          (table) =>
            table.table.schema !== "dbo" &&
            !declaredSchemaNames.has(table.table.schema),
        );
        if (unsupported) {
          return {
            ...item,
            action: "blocked",
            reason: `New target Lakehouse '${targetLogicalId}' cannot prove schema '${unsupported.table.schema}' exists because it is neither dbo nor declared in this bundle.`,
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
          reason: `${canonicalOperations.length} Lakehouse schema or table resource(s) require creation after the target Lakehouse is created.`,
          observedStateHash,
          lakehouseTables: {
            targetLakehouseLogicalId: targetLogicalId,
            targetBinding: "symbolic",
            desiredHash: definition.desiredHash,
            sourceHash: definition.sourceHash,
            observedStateHash,
            operations: canonicalOperations.map((operation) => ({
              action: "create",
              resourceKind:
                operation.kind === "create-schema"
                  ? "schema"
                  : "table",
              operationId: operation.operationId,
              operationHash: operation.operationHash,
              order: operation.order,
              logicalId: operation.logicalId,
              identifier: operation.identifier,
              desiredHash: operation.desiredHash,
              observedHash: "absent",
              reason: `${operation.kind === "create-schema" ? "Schema" : "Table"} '${operation.identifier}' is absent in the new Lakehouse.`,
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
          operations: canonicalOperations.map((canonical, order) => {
            const liveOperation =
              canonical.kind === "create-schema"
                ? (live.schemas ?? []).find(
                    (schema) =>
                      schema.logicalId === canonical.logicalId,
                  )
                : live.tables.find(
                    (table) =>
                      table.logicalId === canonical.logicalId,
                  );
            if (!liveOperation) {
              throw new Error(
                `Lakehouse ${canonical.kind === "create-schema" ? "schema" : "table"} operation '${canonical.logicalId}' is missing from live planning.`,
              );
            }
            const sourceOperation = operationByLogicalId.get(
              liveOperation.logicalId,
            );
            const adoptionOperation =
              "adoptionOperation" in liveOperation
                ? liveOperation.adoptionOperation
                : undefined;
            if (!sourceOperation) {
              throw new Error(
                `Lakehouse DDL operation '${liveOperation.logicalId}' is missing from the canonical source.`,
              );
            }
            return {
              action: liveOperation.action,
              resourceKind:
                canonical.kind === "create-schema"
                  ? "schema"
                  : "table",
              operationId:
                adoptionOperation?.operationId ??
                sourceOperation.operationId,
              operationHash:
                adoptionOperation?.operationHash ??
                sourceOperation.operationHash,
              order,
              logicalId: liveOperation.logicalId,
              identifier: liveOperation.identifier,
              desiredHash: liveOperation.desiredHash,
              observedHash: liveOperation.observedHash,
              reason: liveOperation.reason,
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
    if (item.desiredState === "absent") {
      if (
        !isDeletableFabricItemType(item.type) ||
        !adapters.deletion
      ) {
        plannedItems.set(item.logicalId, {
          ...item,
          action: "blocked",
          reason: `Online deletion planning is unavailable for ${item.type}.`,
        });
        continue;
      }
      const deletion = await adapters.deletion.plan(
        workspaceId,
        item.type,
        desired,
      );
      plannedItems.set(item.logicalId, {
        ...item,
        action: deletion.action,
        reason: deletion.reason,
        observedStateHash: deletion.observedStateHash,
        ...(deletion.physicalId
          ? { physicalId: deletion.physicalId }
          : {}),
      });
      continue;
    }

    const result =
      item.type === "FabricTag"
        ? await requireTagAdapter(
            adapters,
            item.logicalId,
          ).plan({
            displayName: desired.displayName,
            scope: desired.scope ?? { type: "Tenant" },
          })
      : item.type === "Lakehouse"
        ? await adapters.lakehouse.plan(workspaceId, desired)
        : item.type === "Eventhouse"
          ? await requireEventhouseAdapter(
              adapters,
              item.logicalId,
            ).plan(workspaceId, desired)
        : item.type === "KQLDatabase"
          ? await planKqlDatabase(
              workspaceId,
              item,
              desired,
              loadedManifest,
              plannedItems,
              adapters.kqlDatabase,
            )
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
              : item.type === "DataPipeline"
                ? await adapters.pipeline.plan(
                    workspaceId,
                    desired,
                    requirePipelineDefinition(
                      loadedManifest,
                      item.logicalId,
                    ),
                  )
                : item.type === "SemanticModel"
                  ? await adapters.semanticModel.plan(
                    workspaceId,
                    desired,
                    requireSemanticModelDefinition(
                      loadedManifest,
                      item.logicalId,
                    ),
                  )
                  : await planReport(
                      workspaceId,
                      item,
                      desired,
                      loadedManifest,
                      plannedItems,
                      adapters.report,
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

  function requireSemanticModelDefinition(
    loadedManifest: LoadedManifest,
    logicalId: string,
  ) {
    const definition =
      loadedManifest.semanticModelDefinitions[logicalId];
    if (!definition) {
      throw new Error(
        `The resolved Semantic Model definition is missing for '${logicalId}'.`,
      );
    }

    function requireReportDefinition(
      loadedManifest: LoadedManifest,
      logicalId: string,
    ) {
      const definition =
        loadedManifest.reportDefinitions?.[logicalId];
      if (!definition) {
        throw new Error(
          `The resolved Report definition is missing for '${logicalId}'.`,
        );
      }
      return definition;
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

  function requireTagAdapter(
    adapters: FabricPlanAdapters,
    logicalId: string,
  ): NonNullable<FabricPlanAdapters["tags"]> {
    if (!adapters.tags) {
      throw new Error(
        `Fabric tag adapter is missing for '${logicalId}'.`,
      );
    }
    return adapters.tags;
  }

  function requireEventhouseAdapter(
    adapters: FabricPlanAdapters,
    logicalId: string,
  ): NonNullable<FabricPlanAdapters["eventhouse"]> {
    if (!adapters.eventhouse) {
      throw new Error(
        `Eventhouse adapter is missing for '${logicalId}'.`,
      );
    }
    return adapters.eventhouse;
  }

  const orderedItems = plan.items.map((item) => {
    const planned = plannedItems.get(item.logicalId);
    if (!planned) {
      throw new Error(
        `Online plan result is missing for '${item.logicalId}'.`,
      );
    }
    return planned;
  });
  const taggedItems = await enrichTagAssignments(
    orderedItems,
    workspaceId,
    loadedManifest,
    adapters.tags,
  );
  const networkProtection = await planNetworkProtectionIfConfigured(
    loadedManifest,
    workspaceId,
    undefined,
    adapters.networkProtection,
  );
  return rehashPlan({
    ...plan,
    workspaceId,
    ...(plannedWorkspace ? { workspace: plannedWorkspace } : {}),
    ...(networkProtection ? { networkProtection } : {}),
    items: taggedItems,
  });
}

async function planNetworkProtectionIfConfigured(
  loadedManifest: LoadedManifest,
  resolvedWorkspaceId: string,
  pendingReason: string | undefined,
  adapter: Pick<NetworkProtectionAdapter, "plan"> | undefined,
): Promise<PlannedNetworkProtection | undefined> {
  const desired = loadedManifest.manifest.networkProtection;
  if (!desired) {
    return undefined;
  }
  if (pendingReason !== undefined && desired.workspaceId === undefined) {
    return buildBlockedNetworkProtectionPlan(
      desired,
      pendingReason,
      true,
    );
  }
  if (!adapter) {
    throw new Error(
      "Online network protection planning requires a network protection adapter.",
    );
  }
  return adapter.plan(resolvedWorkspaceId, desired);
}

async function enrichTagAssignments(
  items: PlannedItem[],
  workspaceId: string,
  loadedManifest: LoadedManifest,
  adapter:
    | Pick<FabricTagAdapter, "planItemAssignment">
    | undefined,
): Promise<PlannedItem[]> {
  const plannedItems = new Map(
    items.map((item) => [item.logicalId, item]),
  );
  const result: PlannedItem[] = [];
  for (const item of items) {
    const tagLogicalIds = getDesiredTagLogicalIds(
      loadedManifest,
      item.logicalId,
    );
    if (tagLogicalIds.length === 0) {
      result.push(item);
      continue;
    }
    const assignmentHash = buildTagAssignmentHash(
      loadedManifest,
      item.logicalId,
    );
    try {
      if (!adapter) {
        throw new Error("Fabric tag adapter is not initialized.");
      }
      if (item.action === "blocked" || item.action === "unknown") {
        throw new Error(`Target item action is '${item.action}'.`);
      }
      const tagPlans = tagLogicalIds.map((logicalId) => {
        const tag = plannedItems.get(logicalId);
        if (!tag || tag.type !== "FabricTag") {
          throw new Error(
            `Tag logical ID '${logicalId}' is not a planned FabricTag.`,
          );
        }
        if (tag.action === "blocked" || tag.action === "unknown") {
          throw new Error(
            `FabricTag '${logicalId}' action is '${tag.action}'.`,
          );
        }
        return tag;
      });
      if (
        !item.physicalId ||
        tagPlans.some((tag) => !tag.physicalId)
      ) {
        result.push({
          ...item,
          tagAssignment: {
            assignmentHash,
            tagLogicalIds,
            missingTagLogicalIds: tagLogicalIds,
            action: "update",
            observedStateHash: sha256(
              stableJson({
                target: item.physicalId ?? null,
                tags: tagPlans.map((tag) => tag.physicalId ?? null),
              }),
            ),
            reason:
              "Fabric tags will be assigned after the target item and tag resources are materialized.",
          },
        });
        continue;
      }
      const tagIdToLogicalId = new Map(
        tagPlans.map((tag) => [
          tag.physicalId!.toLowerCase(),
          tag.logicalId,
        ]),
      );
      const assignment = await adapter.planItemAssignment(
        workspaceId,
        item.physicalId,
        tagPlans.map((tag) => tag.physicalId!),
      );
      result.push({
        ...item,
        tagAssignment: {
          assignmentHash,
          tagLogicalIds,
          missingTagLogicalIds: assignment.missingTagIds.map((id) => {
            const logicalId = tagIdToLogicalId.get(id.toLowerCase());
            if (!logicalId) {
              throw new Error(
                `Fabric returned unexpected desired tag ID '${id}'.`,
              );
            }
            return logicalId;
          }),
          action: assignment.action,
          observedStateHash: assignment.observedStateHash,
          reason: assignment.reason,
        },
      });
    } catch (error) {
      result.push({
        ...item,
        tagAssignment: {
          assignmentHash,
          tagLogicalIds,
          missingTagLogicalIds: tagLogicalIds,
          action: "blocked",
          observedStateHash: sha256(
            stableJson({ error: errorMessage(error) }),
          ),
          reason: `Fabric tag assignment planning failed: ${errorMessage(
            error,
          )}`,
        },
      });
    }
  }
  return result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    if (item.desiredState === "absent") {
      continue;
    }
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

async function planReport(
  workspaceId: string,
  item: PlannedItem,
  desired: NonNullable<
    LoadedManifest["itemDefinitions"][string]
  >,
  loadedManifest: LoadedManifest,
  plannedItems: ReadonlyMap<string, PlannedItem>,
  adapter: FabricPlanAdapters["report"],
) {
  const sourceDefinition =
    loadedManifest.reportDefinitions?.[item.logicalId];
  const manifestItem = loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === item.logicalId,
  );
  if (!sourceDefinition || !manifestItem) {
    throw new Error(
      `The resolved Report definition or manifest item is missing for '${item.logicalId}'.`,
    );
  }

  if (!adapter) {
    return {
      action: "blocked" as const,
      reason: `Report adapter was not initialized for '${item.logicalId}'.`,
      observedStateHash: sha256(stableJson(null)),
    };
  }
  const bindings = validateLogicalReferenceDeclarations({
    item: manifestItem,
    definition: desired,
    itemGraph: loadedManifest.manifest.items,
  });
  const binding = Object.values(bindings)[0];
  if (!binding) {
    throw new Error(
      `Report '${desired.displayName}' is missing its Semantic Model binding.`,
    );
  }
  const dependency = plannedItems.get(binding.logicalId);
  if (
    dependency?.physicalId &&
    (dependency.action === "update" ||
      dependency.action === "no-op")
  ) {
    const materialized = materializeReportDefinitionWithProof(
      sourceDefinition,
      bindings,
      { [binding.logicalId]: dependency.physicalId },
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
    };
  }
  if (dependency?.action === "create") {
    if (!adapter.planUnresolvedReferences) {
      return {
        action: "blocked" as const,
        reason: `Report '${desired.displayName}' requires the physical ID of newly created Semantic Model '${binding.logicalId}'; replan after it exists.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    const unresolved = await adapter.planUnresolvedReferences(
      workspaceId,
      desired,
      sourceDefinition,
      [binding.logicalId],
    );
    if (
      unresolved.action !== "create" &&
      unresolved.action !== "blocked"
    ) {
      throw new Error(
        `Report '${desired.displayName}' returned unsafe action '${unresolved.action}' before its Semantic Model ID was available.`,
      );
    }
    return unresolved;
  }
  return {
    action: "blocked" as const,
    reason: `Report '${desired.displayName}' cannot resolve Semantic Model '${binding.logicalId}' because its current plan action is '${dependency?.action ?? "missing"}'.`,
    observedStateHash: sha256(stableJson(null)),
  };
}

async function planKqlDatabase(
  workspaceId: string,
  item: PlannedItem,
  desired: NonNullable<
    LoadedManifest["itemDefinitions"][string]
  >,
  loadedManifest: LoadedManifest,
  plannedItems: ReadonlyMap<string, PlannedItem>,
  adapter: FabricPlanAdapters["kqlDatabase"],
) {
  const manifestItem = loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === item.logicalId,
  );
  if (!manifestItem) {
    throw new Error(
      `The resolved KQL Database manifest item is missing for '${item.logicalId}'.`,
    );
  }
  if (!adapter) {
    return {
      action: "blocked" as const,
      reason: `KQL Database adapter was not initialized for '${item.logicalId}'.`,
      observedStateHash: sha256(stableJson(null)),
    };
  }
  const bindings = validateLogicalReferenceDeclarations({
    item: manifestItem,
    definition: desired,
    itemGraph: loadedManifest.manifest.items,
  });
  const binding = Object.values(bindings)[0];
  if (!binding || binding.targetType !== "Eventhouse") {
    throw new Error(
      `KQL Database '${desired.displayName}' is missing its Eventhouse binding.`,
    );
  }
  const dependency = plannedItems.get(binding.logicalId);
  if (
    dependency?.physicalId &&
    (dependency.action === "update" ||
      dependency.action === "no-op")
  ) {
    const materialized =
      materializeKqlDatabaseCreationWithProof(
        desired,
        bindings,
        { [binding.logicalId]: dependency.physicalId },
      );
    return {
      ...(await adapter.plan(
        workspaceId,
        desired,
        materialized,
      )),
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
    };
  }
  if (dependency?.action === "create") {
    if (!adapter.planUnresolvedParent) {
      return {
        action: "blocked" as const,
        reason: `KQL Database '${desired.displayName}' requires the physical ID of newly created Eventhouse '${binding.logicalId}'; replan after it exists.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    const unresolved = await adapter.planUnresolvedParent(
      workspaceId,
      desired,
      [binding.logicalId],
    );
    if (
      unresolved.action !== "create" &&
      unresolved.action !== "blocked"
    ) {
      throw new Error(
        `KQL Database '${desired.displayName}' returned unsafe action '${unresolved.action}' before its Eventhouse ID was available.`,
      );
    }
    return unresolved;
  }
  return {
    action: "blocked" as const,
    reason: `KQL Database '${desired.displayName}' cannot resolve Eventhouse '${binding.logicalId}' because its current plan action is '${dependency?.action ?? "missing"}'.`,
    observedStateHash: sha256(stableJson(null)),
  };
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
