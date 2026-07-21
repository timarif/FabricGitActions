import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "./hash";
import {
  assertDistinctFilePaths,
  assertOutputPathOutsideItems,
} from "./reporting";
import type {
  LakehouseAdapter,
  LakehouseOperationReference,
} from "./fabric/lakehouse";
import {
  buildLakehouseDdlCreateOperations,
  createLakehouseTablesSessionName,
  type LakehouseTableExecutionHooks,
  type LakehouseTablesAdapter,
} from "./fabric/lakehouse-tables";
import type {
  EnvironmentAdapter,
  EnvironmentOperationReference,
} from "./fabric/environment";
import type {
  EventhouseAdapter,
  EventhouseOperationReference,
} from "./fabric/eventhouse";
import type {
  KqlDatabaseAdapter,
  KqlDatabaseOperationReference,
} from "./fabric/kql-database";
import type {
  WarehouseAdapter,
  WarehouseOperationReference,
} from "./fabric/warehouse";
import {
  isDeletableFabricItemType,
  type ItemDeletionAdapter,
} from "./fabric/item-deletion";
import {
  getFabricDeploymentMarker,
  hashFabricDefinition,
  includesPlatformPart,
  type FabricDefinition,
} from "./fabric/definition";
import type {
  NotebookAdapter,
  NotebookOperationReference,
} from "./fabric/notebook";
import {
  hashNotebookDefinition,
  notebookIncludesPlatformPart,
} from "./fabric/notebook-definition";
import type {
  PipelineAdapter,
  PipelineOperationReference,
} from "./fabric/pipeline";
import type {
  CopyJobAdapter,
  CopyJobOperationReference,
} from "./fabric/copy-job";
import {
  hashCopyJobDefinition,
  copyJobIncludesPlatformPart,
} from "./fabric/copy-job-definition";
import type {
  ReportAdapter,
  ReportOperationReference,
} from "./fabric/report";
import {
  hashReportDefinition,
  reportIncludesDiagramLayoutPart,
  reportIncludesPlatformPart,
} from "./fabric/report-definition";
import {
  hashPipelineDefinition,
  pipelineIncludesPlatformPart,
} from "./fabric/pipeline-definition";
import type {
  SemanticModelAdapter,
  SemanticModelOperationReference,
} from "./fabric/semantic-model";
import {
  hashSemanticModelDefinition,
  semanticModelIncludesDiagramLayoutPart,
  semanticModelIncludesPlatformPart,
  semanticModelIncludesCopilotParts,
} from "./fabric/semantic-model-definition";
import type {
  SparkCustomPoolAdapter,
  SparkCustomPoolOperationReference,
} from "./fabric/spark-custom-pool";
import type {
  SparkJobAdapter,
  SparkJobOperationReference,
} from "./fabric/spark-job";
import {
  artifactDescriptor,
  assertSparkJobArtifactEndpoints,
  DEFAULT_LAKEHOUSE_BINDING_TARGET,
  materializeSparkJobArtifactUris,
} from "./fabric/spark-job-artifacts";
import type { OneLakeArtifactStager } from "./fabric/onelake-artifacts";
import type { WorkspaceAdapter } from "./fabric/workspace";
import type { NetworkProtectionAdapter } from "./fabric/network-protection";
import {
  managedPrivateEndpointRequestMessages,
  redactManagedPrivateEndpointError,
  type ManagedPrivateEndpointAdapter,
} from "./fabric/managed-private-endpoints";
import type { FabricTagAdapter } from "./fabric/tags";
import {
  hashSparkJobDefinition,
  sparkJobIncludesPlatformPart,
} from "./fabric/spark-job-definition";
import type {
  EventstreamAdapter,
  EventstreamOperationReference,
} from "./fabric/eventstream";
import {
  hashEventstreamDefinition,
  eventstreamIncludesPlatformPart,
  eventstreamIncludesPropertiesPart,
} from "./fabric/eventstream-definition";
import {
  materializeKqlDatabaseCreationWithProof,
  materializeSparkJobDefinitionWithProof,
  materializeReportDefinitionWithProof,
  validateLogicalReferenceDeclarations,
  type KqlDatabaseLogicalReferenceMaterialization,
  type ReportLogicalReferenceMaterialization,
  type SparkJobLogicalReferenceMaterialization,
} from "./fabric/logical-references";
import { FabricOperationFailedError } from "./fabric/client";
import {
  createCheckpoint,
  loadCheckpoint,
  writeApplyResult,
  writeCheckpoint,
} from "./checkpoint";
import { applyManagedWorkspace } from "./workspace-apply";
import {
  applyNetworkProtection,
  finalizeNetworkProtectionCheckpoint,
  preflightNetworkProtection,
  recoverInterruptedNetworkProtection,
} from "./network-apply";
import {
  applyManagedPrivateEndpoints,
  type ApplyManagedPrivateEndpointOptions,
} from "./managed-private-endpoint-apply";
import type {
  ApplyCheckpoint,
  ApplyItemResult,
  ApplyNetworkProtectionResult,
  ApplyResult,
  ApplyWorkspaceResult,
  DefinitionItemUpdateRecoveryState,
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
  PlannedItem,
} from "./types";

export interface ApplyPlanOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  loadedManifest: LoadedManifest;
  lakehouseAdapter: Pick<
    LakehouseAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  eventhouseAdapter?: Pick<
    EventhouseAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  kqlDatabaseAdapter?: Pick<
    KqlDatabaseAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  warehouseAdapter?: Pick<
    WarehouseAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  environmentAdapter?: Pick<
    EnvironmentAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  itemDeletionAdapter?: Pick<
    ItemDeletionAdapter,
    "plan" | "delete" | "verifyApprovedIdentity"
  >;
  notebookAdapter?: Pick<
    NotebookAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  sparkJobAdapter?: Pick<
    SparkJobAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  pipelineAdapter?: Pick<
    PipelineAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  copyJobAdapter?: Pick<
    CopyJobAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  semanticModelAdapter?: Pick<
    SemanticModelAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  reportAdapter?: Pick<
    ReportAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  eventstreamAdapter?: Pick<
    EventstreamAdapter,
    "create" | "update" | "verify" | "resumeCreate" | "plan"
  >;
  sparkCustomPoolAdapter?: Pick<
    SparkCustomPoolAdapter,
    "create" | "update" | "verify" | "plan"
  >;
  tagAdapter?: Pick<
    FabricTagAdapter,
    | "plan"
    | "create"
    | "verify"
    | "planItemAssignment"
    | "applyItemTags"
    | "verifyItemAssignment"
  >;
  workspaceAdapter?: Pick<
    WorkspaceAdapter,
    "create" | "resumeCreate" | "update" | "resumeUpdate" | "verify"
  >;
  lakehouseTablesAdapter?: Pick<
    LakehouseTablesAdapter,
    | "apply"
    | "verify"
    | "plan"
    | "discoverSessionAttempt"
    | "discoverStatementByMarker"
    | "resumeAcceptedStatement"
    | "deleteSessionById"
  >;
  networkProtectionAdapter?: Pick<
    NetworkProtectionAdapter,
    | "plan"
    | "getCommunicationPolicy"
    | "putCommunicationPolicy"
    | "getOutboundCloudConnectionRules"
    | "putOutboundCloudConnectionRules"
    | "getOutboundGatewayRules"
    | "putOutboundGatewayRules"
  > &
    Partial<
      Pick<
        NetworkProtectionAdapter,
        | "getInboundFirewallRules"
        | "putInboundFirewallRules"
        | "getInboundAzureResourceRules"
        | "putInboundAzureResourceRules"
        | "getInboundExternalDataSharesPolicy"
        | "putInboundExternalDataSharesPolicy"
      >
    >;
  managedPrivateEndpointAdapter?: Pick<
    ManagedPrivateEndpointAdapter,
    | "listManagedPrivateEndpoints"
    | "getManagedPrivateEndpoint"
    | "createManagedPrivateEndpoint"
    | "deleteManagedPrivateEndpoint"
    | "waitForProvisioningSucceeded"
  >;
  oneLakeArtifactStager?: Pick<
    OneLakeArtifactStager,
    "uploadImmutable" | "verify" | "getEndpointIdentity"
  >;
  oneLakeDfsEndpoint?: string;
  oneLakeBlobEndpoint?: string;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete?: boolean;
  allowLakehouseDataLoss?: boolean;
  allowWorkspaceCreate?: boolean;
  allowWorkspaceUpdate?: boolean;
  allowCapacityAssignment?: boolean;
  allowLakehouseSchemaCreate?: boolean;
  allowLakehouseTableCreate?: boolean;
  allowOneLakeArtifactCreate?: boolean;
  allowTagCreate?: boolean;
  allowTagAssign?: boolean;
  allowNetworkPolicyUpdate?: boolean;
  allowNetworkPolicyRelaxation?: boolean;
  allowInboundFirewallUpdate?: boolean;
  allowInboundAzureResourceRuleUpdate?: boolean;
  allowInboundExternalDataSharePolicyUpdate?: boolean;
  allowInboundExternalDataSharePolicyRelaxation?: boolean;
  acknowledgeFirewallLockoutRisk?: boolean;
  allowOutboundCloudConnectionRuleUpdate?: boolean;
  allowOutboundGatewayRuleUpdate?: boolean;
  allowManagedPrivateEndpointCreate?: boolean;
  allowManagedPrivateEndpointDelete?: boolean;
  checkpointFile: string;
  resultFile: string;
  itemDirectories?: string[];
  now?: () => number;
  checkpoint?: ApplyCheckpoint;
}

export async function applyApprovedPlan(
  options: ApplyPlanOptions,
): Promise<ApplyResult> {
  assertOutputPathOutsideItems(
    options.checkpointFile,
    options.itemDirectories ?? [],
    "Checkpoint file",
  );
  assertOutputPathOutsideItems(
    options.resultFile,
    options.itemDirectories ?? [],
    "Result file",
  );
  assertDistinctFilePaths([
    { label: "Checkpoint file", filePath: options.checkpointFile },
    { label: "Result file", filePath: options.resultFile },
  ]);
  validateApplyLogicalReferences(options.loadedManifest);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const results: ApplyItemResult[] = [];
  const approvedItems = new Map(
    options.approvedPlan.items.map((item) => [item.logicalId, item]),
  );
  const currentItems = new Map(
    options.currentPlan.items.map((item) => [item.logicalId, item]),
  );
  let resultWritable = false;
  let workspaceResult: ApplyWorkspaceResult | undefined;
  let networkProtectionResult: ApplyNetworkProtectionResult | undefined;
  let runtimeWorkspaceId = options.approvedPlan.workspaceId;
  let requiresItemReplan = false;

  try {
    writeApplyResult(
      options.resultFile,
      buildResult(
        options.approvedPlan,
        "in_progress",
        startedAt,
        startedAt,
        [],
      ),
    );
    resultWritable = true;
    assertPlanIdentity(options.approvedPlan, options.currentPlan);
    const checkpoint =
      loadCheckpoint(options.checkpointFile, options.approvedPlan) ??
      createCheckpoint(options.approvedPlan);
    writeCheckpoint(options.checkpointFile, checkpoint);
    assertApprovedOneLakeEndpointConfiguration(options);
    const preWorkspaceRuntimeOptions: ApplyPlanOptions = {
      ...options,
      checkpoint,
    };
    const canAddressNetworkBeforeWorkspace =
      options.approvedPlan.workspace?.action !== "create" ||
      options.loadedManifest.manifest.networkProtection?.workspaceId !==
        undefined;
    if (canAddressNetworkBeforeWorkspace) {
      // Security recovery takes precedence over unrelated item or workspace
      // preflight failures once a network mutation unit has started.
      preflightRuntimeNetworkProtection(
        preWorkspaceRuntimeOptions,
        checkpoint,
      );
      await recoverInterruptedNetworkProtection(
        networkProtectionApplyOptions(
          preWorkspaceRuntimeOptions,
          checkpoint,
          now,
        ),
      );
    }
    if (options.approvedPlan.workspace?.action !== "create") {
      preflightBeforeRecovery(
        options,
        checkpoint,
        approvedItems,
        currentItems,
      );
    }
    const workspaceOutcome = await applyManagedWorkspace({
      approvedPlan: options.approvedPlan,
      currentPlan: options.currentPlan,
      desired: options.loadedManifest.manifest.workspace,
      adapter: options.workspaceAdapter,
      checkpoint,
      checkpointFile: options.checkpointFile,
      allowWorkspaceCreate:
        options.allowWorkspaceCreate ?? false,
      allowWorkspaceUpdate:
        options.allowWorkspaceUpdate ?? false,
      allowCapacityAssignment:
        options.allowCapacityAssignment ?? false,
      now,
    });
    runtimeWorkspaceId = workspaceOutcome.workspaceId;
    workspaceResult = workspaceOutcome.result;
    requiresItemReplan =
      workspaceOutcome.requiresItemReplan;
    const runtimeOptions: ApplyPlanOptions = {
      ...options,
      approvedPlan: {
        ...options.approvedPlan,
        workspaceId: runtimeWorkspaceId,
      },
      currentPlan: {
        ...options.currentPlan,
        workspaceId: runtimeWorkspaceId,
      },
      checkpoint,
    };
    if (requiresItemReplan) {
      // An explicit network target is independent of the newly provisioned
      // deployment workspace and remains safe to apply before child items are
      // replanned against the new workspace ID.
      if (
        runtimeOptions.loadedManifest.manifest.networkProtection
          ?.workspaceId !== undefined
      ) {
        preflightRuntimeNetworkProtection(runtimeOptions, checkpoint);
        await recoverInterruptedNetworkProtection(
          networkProtectionApplyOptions(runtimeOptions, checkpoint, now),
        );
        networkProtectionResult =
          await applyRuntimeNetworkProtection(
            runtimeOptions,
            checkpoint,
            now,
          );
      }
      const result = buildResult(
        options.approvedPlan,
        "succeeded",
        startedAt,
        now(),
        [],
        runtimeWorkspaceId,
        workspaceResult,
        true,
        networkProtectionResult,
      );
      writeApplyResult(options.resultFile, result);
      return result;
    }
    // Validate every configured network surface before any recovery path can
    // dispatch a network or item mutation.
    preflightRuntimeNetworkProtection(runtimeOptions, checkpoint);
    // A started network protection mutation unit is completed immediately
    // after workspace resolution, ahead of any item reconciliation.
    await recoverInterruptedNetworkProtection(
      networkProtectionApplyOptions(runtimeOptions, checkpoint, now),
    );
    const preverifiedDurations =
      await verifyCheckpointedOneLakeArtifactTargets(
        runtimeOptions,
        checkpoint,
        approvedItems,
        now,
      );
    await reconcileOneLakeArtifactStaging(
      runtimeOptions,
      checkpoint,
      approvedItems,
      now,
    );
    const recoveredUpdates = await reconcilePendingUpdates(
      runtimeOptions,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const recoveredDeletes = await reconcilePendingDeletes(
      runtimeOptions,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const recoveredCreates = await reconcilePendingCreates(
      runtimeOptions,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const resumedOperations = await resumePendingOperations(
      runtimeOptions,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const recoveredTagAssignments =
      await reconcilePendingTagAssignments(
        runtimeOptions,
        checkpoint,
        approvedItems,
        now,
      );
    const trustedResumes = new Set([
      ...recoveredUpdates,
      ...recoveredDeletes,
      ...recoveredCreates,
      ...resumedOperations,
      ...recoveredTagAssignments,
    ]);
    preflightPlan(
      runtimeOptions,
      checkpoint,
      approvedItems,
      currentItems,
      trustedResumes,
    );
    const resumedDurations = await verifyCheckpointedItems(
      runtimeOptions,
      checkpoint,
      approvedItems,
      now,
      preverifiedDurations,
    );

    for (const stage of runtimeOptions.approvedPlan.stages) {
      for (const logicalId of stage) {
        const approvedItem = approvedItems.get(logicalId);
        const currentItem = currentItems.get(logicalId);
        if (!approvedItem || !currentItem) {
          throw new Error(`Plan item '${logicalId}' is missing during apply.`);
        }

        const itemStartedAt = now();
        const completed = getCompletedItem(checkpoint, logicalId);
        if (completed) {
          const tagAssignment = await applyItemTagAssignment(
            runtimeOptions,
            checkpoint,
            approvedItem,
            completed.physicalId,
            now,
          );
          results.push({
            logicalId,
            type: approvedItem.type,
            action: approvedItem.action,
            status: "resumed",
            physicalId: completed.physicalId,
            durationMs: resumedDurations.get(logicalId) ?? 0,
            ...(tagAssignment ? { tagAssignment } : {}),
          });
          continue;
        }

        await assertFreshItemHasNotDrifted(runtimeOptions, approvedItem);
        if (
          approvedItem.type === "SparkJobDefinition" &&
          approvedItem.sparkJobArtifacts
        ) {
          await applySparkJobArtifacts(
            runtimeOptions,
            checkpoint,
            approvedItem,
            now,
          );
        }
        let result: ApplyItemResult;
        try {
          result =
            approvedItem.type === "LakehouseTables"
              ? await applyLakehouseTablesItem(
                  runtimeOptions,
                  checkpoint,
                  approvedItem,
                  itemStartedAt,
                  now,
                )
              : await applyItem(
            runtimeOptions,
            approvedItem,
            itemStartedAt,
            now,
            (physicalId) => {
              delete checkpoint.pendingCreates[logicalId];
              delete checkpoint.pendingOperations[logicalId];
              delete checkpoint.pendingUpdates[logicalId];
              delete checkpoint.pendingDeletes[logicalId];
              checkpoint.completedItems[logicalId] = {
                logicalId,
                action: approvedItem.action,
                physicalId,
                completedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            (operation) => {
              const proof = logicalReferenceCheckpointProof(
                runtimeOptions,
                approvedItem,
                    );
              delete checkpoint.pendingCreates[logicalId];
              checkpoint.pendingOperations[logicalId] = {
                logicalId,
                action: "create",
                ...operation,
                ...proof,
                acceptedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              const proof = logicalReferenceCheckpointProof(
                runtimeOptions,
                approvedItem,
              );
              checkpoint.pendingCreates[logicalId] = {
                logicalId,
                action: "create",
                ...proof,
                submittedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              delete checkpoint.pendingCreates[logicalId];
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            (state) =>
              recordPendingUpdate(
                runtimeOptions,
                checkpoint,
                approvedItem,
                state,
                now,
              ),
            () => {
              delete checkpoint.pendingUpdates[logicalId];
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              if (
                approvedItem.action !== "delete" ||
                !approvedItem.physicalId ||
                !approvedItem.observedStateHash
              ) {
                throw new Error(
                  `Deletion checkpoint proof is missing for '${logicalId}'.`,
                );
              }
              checkpoint.pendingDeletes[logicalId] = {
                logicalId,
                action: "delete",
                physicalId: approvedItem.physicalId,
                observedStateHash:
                  approvedItem.observedStateHash,
                submittedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
          );
        } catch (error) {
          if (
            error instanceof FabricOperationFailedError &&
            approvedItem.action === "create"
          ) {
            const reconciled = await reconcileInitialTerminalCreate(
              runtimeOptions,
              checkpoint,
              approvedItem,
              itemStartedAt,
              now,
            );
            if (reconciled) {
              result = reconciled;
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
        const physicalId =
          result.physicalId ??
          (approvedItem.desiredState === "absent" &&
          approvedItem.action === "no-op"
            ? undefined
            : requirePhysicalId(result, logicalId));
        const tagAssignment = await applyItemTagAssignment(
          runtimeOptions,
          checkpoint,
          approvedItem,
          physicalId,
          now,
        );
        if (tagAssignment) {
          result = {
            ...result,
            ...(result.status === "verified" &&
            tagAssignment.status === "updated"
              ? { status: "updated" as const }
              : {}),
            tagAssignment,
          };
        }
        results.push(result);
        delete checkpoint.pendingCreates[logicalId];
        delete checkpoint.pendingOperations[logicalId];
        delete checkpoint.pendingUpdates[logicalId];
        delete checkpoint.pendingDeletes[logicalId];
        checkpoint.completedItems[logicalId] = {
          logicalId,
          action: approvedItem.action,
          ...(physicalId ? { physicalId } : {}),
          completedAt: new Date(now()).toISOString(),
        };
        writeCheckpoint(options.checkpointFile, checkpoint);
      }

    }

    // Network protection changes are applied only after the workspace and
    // every item stage have completed.
    networkProtectionResult =
      await applyRuntimeNetworkProtection(
        runtimeOptions,
        checkpoint,
        now,
      );

    const result = buildResult(
      options.approvedPlan,
      "succeeded",
      startedAt,
      now(),
      results,
      runtimeWorkspaceId,
      workspaceResult,
      false,
      networkProtectionResult,
    );
    writeApplyResult(options.resultFile, result);
    return result;
  } catch (error) {
    const redactedError = redactManagedPrivateEndpointError(
      error,
      managedPrivateEndpointRequestMessages(
        options.loadedManifest.manifest.networkProtection,
      ),
    );
    const message =
      redactedError instanceof Error
        ? redactedError.message
        : String(redactedError);
    results.push({
      logicalId: "<apply>",
      type: "Lakehouse",
      action: "blocked",
      status: "failed",
      durationMs: now() - startedAt,
      error: message,
    });
    const result = buildResult(
      options.approvedPlan,
      "failed",
      startedAt,
      now(),
      results,
      runtimeWorkspaceId,
      workspaceResult,
      requiresItemReplan,
      networkProtectionResult,
    );
    if (resultWritable) {
      try {
        writeApplyResult(options.resultFile, result);
      } catch (reportingError) {
        throw new AggregateError(
          [redactedError, reportingError],
          `${message} Result reporting also failed.`,
        );
      }
    }
    throw redactedError;
  }
}

function validateApplyLogicalReferences(
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
        `Desired definition is missing for '${item.logicalId}'.`,
      );
    }
    validateLogicalReferenceDeclarations({
      item,
      definition,
      itemGraph: loadedManifest.manifest.items,
    });
  }
}

async function reconcileInitialTerminalCreate(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
  startedAt: number,
  now: () => number,
): Promise<ApplyItemResult | undefined> {
  const desired = options.loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    throw new Error(`Desired definition is missing for '${item.logicalId}'.`);
  }
  const live = await planDesiredItem(options, item, desired);
  if (live.action === "create") {
    delete checkpoint.pendingOperations[item.logicalId];
    writeCheckpoint(options.checkpointFile, checkpoint);
    return undefined;
  }
  if (
    item.type === "Environment" &&
    live.action === "update" &&
    live.physicalId &&
    hasEnvironmentRecoveryProof(options, item, live)
  ) {
    const verified = await updateDesiredItem(
      options,
      item,
      live.physicalId,
      desired,
    );
    completeCreateCheckpoint(
      options,
      checkpoint,
      item.logicalId,
      verified.id,
      now,
    );
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "created",
      physicalId: verified.id,
      durationMs: now() - startedAt,
    };
  }
  if (live.action !== "no-op" || !live.physicalId) {
    return undefined;
  }
  const verified = await verifyDesiredItem(
    options,
    item,
    live.physicalId,
    desired,
  );
  completeCreateCheckpoint(
    options,
    checkpoint,
    item.logicalId,
    verified.id,
    now,
  );
  return {
    logicalId: item.logicalId,
    type: item.type,
    action: item.action,
    status: "created",
    physicalId: verified.id,
    durationMs: now() - startedAt,
  };
}

async function assertFreshItemHasNotDrifted(
  options: ApplyPlanOptions,
  approvedItem: PlannedItem,
): Promise<void> {
  if (approvedItem.type === "LakehouseTables") {
    const current = options.currentPlan.items.find(
      (candidate) =>
        candidate.logicalId === approvedItem.logicalId,
    );
    if (!current) {
      throw new Error(
        `Current LakehouseTables plan is missing for '${approvedItem.logicalId}'.`,
      );
    }
    if (!options.checkpoint) {
      throw new Error(
        `LakehouseTables apply checkpoint is missing for '${approvedItem.logicalId}'.`,
      );
    }
    assertLakehouseTablesPreflightState(
      options,
      options.checkpoint,
      approvedItem,
      current,
      getCompletedItem(options.checkpoint, approvedItem.logicalId),
      options.checkpoint.lakehouseTables?.[
        approvedItem.logicalId
      ] !== undefined,
    );
    return;
  }
  const desired =
    options.loadedManifest.itemDefinitions[approvedItem.logicalId];
  if (!desired) {
    throw new Error(
      `Desired definition is missing for '${approvedItem.logicalId}'.`,
    );
  }
  const live = await planDesiredItem(options, approvedItem, desired);
  const livePhysicalId =
    "physicalId" in live && typeof live.physicalId === "string"
      ? live.physicalId
      : undefined;
  const freshTagAssignment = await planFreshTagAssignment(
    options,
    approvedItem,
    livePhysicalId,
  );
  const freshItem: PlannedItem = {
    logicalId: approvedItem.logicalId,
    type: approvedItem.type,
    path: approvedItem.path,
    dependsOn: approvedItem.dependsOn,
    desiredState: approvedItem.desiredState,
    contentHash: approvedItem.contentHash,
    displayName: approvedItem.displayName,
    action: live.action,
    reason: live.reason,
    observedStateHash: live.observedStateHash,
    ...(livePhysicalId ? { physicalId: livePhysicalId } : {}),
    ...(freshTagAssignment
      ? { tagAssignment: freshTagAssignment }
      : {}),
    ...(approvedItem.materializedDefinitionHash !== undefined &&
    "materializedDefinitionHash" in live &&
    typeof live.materializedDefinitionHash === "string"
      ? {
          materializedDefinitionHash:
            live.materializedDefinitionHash,
        }
      : {}),
    ...(approvedItem.resolvedBindingsHash !== undefined &&
    "resolvedBindingsHash" in live &&
    typeof live.resolvedBindingsHash === "string"
      ? { resolvedBindingsHash: live.resolvedBindingsHash }
      : {}),
    ...(approvedItem.sparkJobArtifacts
      ? { sparkJobArtifacts: approvedItem.sparkJobArtifacts }
      : {}),
  };
  assertItemHasNotDrifted(approvedItem, freshItem);
}

async function planFreshTagAssignment(
  options: ApplyPlanOptions,
  item: PlannedItem,
  itemPhysicalId: string | undefined,
) {
  const assignment = item.tagAssignment;
  if (!assignment) {
    return undefined;
  }
  if (!itemPhysicalId) {
    return assignment;
  }
  if (!options.checkpoint) {
    throw new Error(
      `Apply checkpoint is missing while planning Fabric tags for '${item.logicalId}'.`,
    );
  }
  const tagIds = resolveApprovedTagIds(
    options,
    options.checkpoint,
    item,
  );
  const logicalIdByTagId = new Map(
    tagIds.map((tagId, index) => [
      tagId.toLowerCase(),
      assignment.tagLogicalIds[index]!,
    ]),
  );
  const live = await requireTagAdapter(
    options,
    item.logicalId,
  ).planItemAssignment(
    options.approvedPlan.workspaceId,
    itemPhysicalId,
    tagIds,
  );
  return {
    assignmentHash: assignment.assignmentHash,
    tagLogicalIds: assignment.tagLogicalIds,
    missingTagLogicalIds: live.missingTagIds.map((tagId) => {
      const logicalId = logicalIdByTagId.get(tagId.toLowerCase());
      if (!logicalId) {
        throw new Error(
          `Fabric returned unexpected desired tag ID '${tagId}' for '${item.logicalId}'.`,
        );
      }
      return logicalId;
    }),
    action: live.action,
    observedStateHash: live.observedStateHash,
    reason: live.reason,
  };
}

function networkProtectionApplyOptions(
  runtimeOptions: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  now: () => number,
): Parameters<typeof applyNetworkProtection>[0] {
  return {
    approvedPlan: runtimeOptions.approvedPlan,
    currentPlan: runtimeOptions.currentPlan,
    desired: runtimeOptions.loadedManifest.manifest.networkProtection,
    adapter: runtimeOptions.networkProtectionAdapter,
    managedPrivateEndpointAdapter:
      runtimeOptions.managedPrivateEndpointAdapter,
    checkpoint,
    checkpointFile: runtimeOptions.checkpointFile,
    allowNetworkPolicyUpdate:
      runtimeOptions.allowNetworkPolicyUpdate ?? false,
    allowNetworkPolicyRelaxation:
      runtimeOptions.allowNetworkPolicyRelaxation ?? false,
    allowInboundFirewallUpdate:
      runtimeOptions.allowInboundFirewallUpdate ?? false,
    allowInboundAzureResourceRuleUpdate:
      runtimeOptions.allowInboundAzureResourceRuleUpdate ?? false,
    allowInboundExternalDataSharePolicyUpdate:
      runtimeOptions.allowInboundExternalDataSharePolicyUpdate ?? false,
    allowInboundExternalDataSharePolicyRelaxation:
      runtimeOptions.allowInboundExternalDataSharePolicyRelaxation ?? false,
    acknowledgeFirewallLockoutRisk:
      runtimeOptions.acknowledgeFirewallLockoutRisk ?? false,
    allowOutboundCloudConnectionRuleUpdate:
      runtimeOptions.allowOutboundCloudConnectionRuleUpdate ?? false,
    allowOutboundGatewayRuleUpdate:
      runtimeOptions.allowOutboundGatewayRuleUpdate ?? false,
    allowManagedPrivateEndpointCreate:
      runtimeOptions.allowManagedPrivateEndpointCreate ?? false,
    allowManagedPrivateEndpointDelete:
      runtimeOptions.allowManagedPrivateEndpointDelete ?? false,
    now,
  };
}

function preflightRuntimeNetworkProtection(
  runtimeOptions: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
): void {
  preflightNetworkProtection({
    approvedPlan: runtimeOptions.approvedPlan,
    currentPlan: runtimeOptions.currentPlan,
    checkpoint,
    allowNetworkPolicyUpdate:
      runtimeOptions.allowNetworkPolicyUpdate ?? false,
    allowNetworkPolicyRelaxation:
      runtimeOptions.allowNetworkPolicyRelaxation ?? false,
    allowInboundFirewallUpdate:
      runtimeOptions.allowInboundFirewallUpdate ?? false,
    allowInboundAzureResourceRuleUpdate:
      runtimeOptions.allowInboundAzureResourceRuleUpdate ?? false,
    allowInboundExternalDataSharePolicyUpdate:
      runtimeOptions.allowInboundExternalDataSharePolicyUpdate ?? false,
    allowInboundExternalDataSharePolicyRelaxation:
      runtimeOptions.allowInboundExternalDataSharePolicyRelaxation ?? false,
    acknowledgeFirewallLockoutRisk:
      runtimeOptions.acknowledgeFirewallLockoutRisk ?? false,
    allowOutboundCloudConnectionRuleUpdate:
      runtimeOptions.allowOutboundCloudConnectionRuleUpdate ?? false,
    allowOutboundGatewayRuleUpdate:
      runtimeOptions.allowOutboundGatewayRuleUpdate ?? false,
    allowManagedPrivateEndpointCreate:
      runtimeOptions.allowManagedPrivateEndpointCreate ?? false,
    allowManagedPrivateEndpointDelete:
      runtimeOptions.allowManagedPrivateEndpointDelete ?? false,
  });
}

async function applyRuntimeNetworkProtection(
  runtimeOptions: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  now: () => number,
): Promise<ApplyNetworkProtectionResult | undefined> {
  const managedOptions: ApplyManagedPrivateEndpointOptions = {
    approvedPlan: runtimeOptions.approvedPlan,
    currentPlan: runtimeOptions.currentPlan,
    desired:
      runtimeOptions.loadedManifest.manifest.networkProtection,
    adapter: runtimeOptions.managedPrivateEndpointAdapter,
    checkpoint,
    checkpointFile: runtimeOptions.checkpointFile,
    allowManagedPrivateEndpointCreate:
      runtimeOptions.allowManagedPrivateEndpointCreate ?? false,
    allowManagedPrivateEndpointDelete:
      runtimeOptions.allowManagedPrivateEndpointDelete ?? false,
    now,
  };
  const present = await applyManagedPrivateEndpoints(
    managedOptions,
    "present",
  );
  const network = await applyNetworkProtection(
    networkProtectionApplyOptions(
      runtimeOptions,
      checkpoint,
      now,
    ),
  );
  const absent = await applyManagedPrivateEndpoints(
    managedOptions,
    "absent",
  );
  if (!network) {
    return undefined;
  }
  if (network.communicationPolicy.status !== "deferred") {
    finalizeNetworkProtectionCheckpoint(
      networkProtectionApplyOptions(
        runtimeOptions,
        checkpoint,
        now,
      ),
    );
  }
  const managedPrivateEndpoints = [
    ...(present ?? []),
    ...(absent ?? []),
  ].sort((left, right) =>
    compareCanonicalStrings(
      left.name.toLowerCase(),
      right.name.toLowerCase(),
    ),
  );
  return {
    ...network,
    ...(managedPrivateEndpoints.length > 0
      ? { managedPrivateEndpoints }
      : {}),
  };
}

function assertPlanIdentity(
  approvedPlan: DeploymentPlan,
  currentPlan: DeploymentPlan,
): void {
  if (approvedPlan.mode !== "plan") {
    throw new Error(
      `Approved artifact must be a plan, but its mode is '${approvedPlan.mode}'.`,
    );
  }
  const approvedIdentity = {
    deploymentId: approvedPlan.deploymentId,
    workspaceTarget: approvedPlan.workspace
      ? {
          displayName: approvedPlan.workspace.displayName,
          contentHash: approvedPlan.workspace.contentHash,
        }
      : { workspaceId: approvedPlan.workspaceId },
    environment: approvedPlan.environment,
    sourceCommit: approvedPlan.sourceCommit,
    sourceHash: approvedPlan.sourceHash,
    resolvedHash: approvedPlan.resolvedHash,
    stages: approvedPlan.stages,
  };
  const currentIdentity = {
    deploymentId: currentPlan.deploymentId,
    workspaceTarget: currentPlan.workspace
      ? {
          displayName: currentPlan.workspace.displayName,
          contentHash: currentPlan.workspace.contentHash,
        }
      : { workspaceId: currentPlan.workspaceId },
    environment: currentPlan.environment,
    sourceCommit: currentPlan.sourceCommit,
    sourceHash: currentPlan.sourceHash,
    resolvedHash: currentPlan.resolvedHash,
    stages: currentPlan.stages,
  };
  if (stableJson(approvedIdentity) !== stableJson(currentIdentity)) {
    throw new Error(
      "The approved plan does not match the current source, commit, environment, workspace, or dependency graph.",
    );
  }
}

function preflightBeforeRecovery(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
): void {
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const approvedItem = approvedItems.get(logicalId);
      const currentItem = currentItems.get(logicalId);
      if (!approvedItem || !currentItem) {
        throw new Error(`Plan item '${logicalId}' is missing during preflight.`);
      }
      assertSupportedApplyItem(options, approvedItem);
      if (!options.loadedManifest.itemDefinitions[logicalId]) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      assertApplyActionAuthorized(options, approvedItem);

      const completed = getCompletedItem(checkpoint, logicalId);
      const pendingItem =
        getPendingOperation(checkpoint, logicalId) ??
        getPendingCreate(checkpoint, logicalId) ??
        getPendingUpdate(checkpoint, logicalId) ??
        getPendingDelete(checkpoint, logicalId);
      const pending =
        pendingItem ??
        checkpoint.lakehouseTables?.[logicalId] ??
        checkpoint.oneLakeArtifacts?.[logicalId] ??
        checkpoint.tagAssignments?.[logicalId];
      const hasArtifactState =
        checkpoint.oneLakeArtifacts?.[logicalId] !== undefined;
      if (approvedItem.type === "LakehouseTables") {
        assertLakehouseTablesPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pending !== undefined,
          true,
        );
        continue;
      }
      if (hasSymbolicSparkJobArtifactTarget(approvedItem)) {
        assertSymbolicSparkJobArtifactPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
          false,
          true,
          hasArtifactState || pendingItem !== undefined,
        );
        continue;
      }
      if (hasSymbolicReportBinding(approvedItem)) {
        assertSymbolicReportPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
        );
        continue;
      }
      if (hasSymbolicKqlDatabaseBinding(approvedItem)) {
        assertSymbolicKqlDatabasePreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
        );
        continue;
      }
      if (completed) {
        assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
        if (!isCompletedItemCurrentNoOp(
          approvedItem,
          currentItem,
          completed.physicalId,
        )) {
          throw new Error(
            `Checkpointed item '${logicalId}' is not a no-op in its expected state in the current Fabric plan.`,
          );
        }
        continue;
      }
      if (pending) {
        assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
        continue;
      }
      assertItemHasNotDrifted(approvedItem, currentItem);
    }
  }
}

function preflightPlan(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
  resumedOperations: Set<string>,
): void {
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const approvedItem = approvedItems.get(logicalId);
      const currentItem = currentItems.get(logicalId);
      if (!approvedItem || !currentItem) {
        throw new Error(`Plan item '${logicalId}' is missing during preflight.`);
      }
      assertSupportedApplyItem(options, approvedItem);
      if (!options.loadedManifest.itemDefinitions[logicalId]) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      const completed = getCompletedItem(checkpoint, logicalId);
      const pendingLakehouseTables =
        checkpoint.lakehouseTables?.[logicalId];
      if (approvedItem.type === "LakehouseTables") {
        assertLakehouseTablesPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingLakehouseTables !== undefined,
        );
        assertApplyActionAuthorized(options, approvedItem);
        continue;
      }
      const pendingItem =
        getPendingOperation(checkpoint, logicalId) ??
        getPendingCreate(checkpoint, logicalId) ??
        getPendingUpdate(checkpoint, logicalId) ??
        getPendingDelete(checkpoint, logicalId);
      if (hasSymbolicSparkJobArtifactTarget(approvedItem)) {
        assertSymbolicSparkJobArtifactPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
          resumedOperations.has(logicalId),
        );
        assertApplyActionAuthorized(options, approvedItem);
        continue;
      }
      if (hasSymbolicReportBinding(approvedItem)) {
        assertSymbolicReportPreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
          resumedOperations.has(logicalId),
        );
        assertApplyActionAuthorized(options, approvedItem);
        continue;
      }
      if (hasSymbolicKqlDatabaseBinding(approvedItem)) {
        assertSymbolicKqlDatabasePreflightState(
          options,
          checkpoint,
          approvedItem,
          currentItem,
          completed,
          pendingItem !== undefined,
          resumedOperations.has(logicalId),
        );
        assertApplyActionAuthorized(options, approvedItem);
        continue;
      }
      if (completed) {
        assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
        assertTagAssignmentAuthorized(options, approvedItem);
        if (resumedOperations.has(logicalId)) {
          continue;
        }
        if (!isCompletedItemCurrentNoOp(
          approvedItem,
          currentItem,
          completed.physicalId,
        )) {
          throw new Error(
            `Checkpointed item '${logicalId}' is not a no-op in its expected state in the current Fabric plan.`,
          );
        }

        continue;
      }

      assertItemHasNotDrifted(approvedItem, currentItem);
      assertApplyActionAuthorized(options, approvedItem);
    }
  }
}

function isCompletedItemCurrentNoOp(
  approved: PlannedItem,
  current: PlannedItem,
  completedPhysicalId: string | undefined,
): boolean {
  if (current.action !== "no-op") {
    return false;
  }
  if (approved.desiredState === "absent") {
    return (
      current.physicalId === undefined &&
      (approved.action !== "delete" ||
        completedPhysicalId === approved.physicalId)
    );
  }
  return current.physicalId === completedPhysicalId;
}

function assertSupportedApplyItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
): void {
  if (
    item.type !== "Lakehouse" &&
    item.type !== "Eventhouse" &&
    item.type !== "KQLDatabase" &&
    item.type !== "Warehouse" &&
    item.type !== "Environment" &&
    item.type !== "SparkCustomPool" &&
    item.type !== "Notebook" &&
    item.type !== "SparkJobDefinition" &&
    item.type !== "DataPipeline" &&
    item.type !== "CopyJob" &&
    item.type !== "SemanticModel" &&
    item.type !== "Report" &&
    item.type !== "LakehouseTables" &&
    item.type !== "FabricTag" &&
    item.type !== "Eventstream"
  ) {
    throw new Error(
      `Apply is not implemented for item '${item.logicalId}' of type ${item.type}.`,
    );
  }
  if (
    item.desiredState === "absent" &&
    (!isDeletableFabricItemType(item.type) ||
      !options.itemDeletionAdapter)
  ) {
    throw new Error(
      `Deletion adapter was not initialized for item '${item.logicalId}' of type ${item.type}.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "KQLDatabase" &&
    !options.kqlDatabaseAdapter
  ) {
    throw new Error(
      `KQL Database adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "Environment" &&
    !options.environmentAdapter
  ) {
    throw new Error(
      `Environment adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "Notebook" &&
    !options.notebookAdapter
  ) {
    throw new Error(
      `Notebook adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.type === "SparkJobDefinition" &&
    item.desiredState !== "absent" &&
    !options.sparkJobAdapter
  ) {
    throw new Error(
      `Spark Job Definition adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.type === "SparkJobDefinition" &&
    item.sparkJobArtifacts &&
    (!options.oneLakeArtifactStager ||
      !options.oneLakeDfsEndpoint ||
      !options.oneLakeBlobEndpoint)
  ) {
    throw new Error(
      `OneLake artifact staging was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "DataPipeline" &&
    !options.pipelineAdapter
  ) {
    throw new Error(
      `Data Pipeline adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "CopyJob" &&
    !options.copyJobAdapter
  ) {
    throw new Error(
      `Copy Job adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "SemanticModel" &&
    !options.semanticModelAdapter
  ) {
    throw new Error(
      `Semantic Model adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "Report" &&
    !options.reportAdapter
  ) {
    throw new Error(
      `Report adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "Eventstream" &&
    !options.eventstreamAdapter
  ) {
    throw new Error(
      `Eventstream adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.type === "SparkCustomPool" &&
    !options.sparkCustomPoolAdapter
  ) {
    throw new Error(
      `Spark custom pool adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (item.type === "LakehouseTables" && !options.lakehouseTablesAdapter) {
    throw new Error(
      `LakehouseTables adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    item.desiredState !== "absent" &&
    item.type === "Warehouse" &&
    !options.warehouseAdapter
  ) {
    throw new Error(
      `Warehouse adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
  if (
    (item.type === "FabricTag" || item.tagAssignment) &&
    !options.tagAdapter
  ) {
    throw new Error(
      `Fabric tag adapter was not initialized for item '${item.logicalId}'.`,
    );
  }
}

function assertApplyActionAuthorized(
  options: ApplyPlanOptions,
  item: PlannedItem,
): void {
  assertTagAssignmentAuthorized(options, item);
  if (item.sparkJobArtifacts) {
    const blocked = item.sparkJobArtifacts.artifacts.find(
      (artifact) => artifact.action === "blocked",
    );
    if (blocked) {
      throw new Error(
        `Spark Job artifact '${blocked.fileName}' cannot be applied because its staging action is blocked.`,
      );
    }
    if (
      item.sparkJobArtifacts.artifacts.some(
        (artifact) => artifact.action === "create",
      ) &&
      !(options.allowOneLakeArtifactCreate ?? false)
    ) {
      throw new Error(
        `Plan requires staging OneLake artifacts for '${item.logicalId}', but allow-onelake-artifact-create is false.`,
      );
    }
  }
  if (item.type === "LakehouseTables") {
    if (
      item.lakehouseTables?.operations.some(
        (operation) =>
          operation.action === "create" &&
          operation.resourceKind === "schema",
      ) &&
      !(options.allowLakehouseSchemaCreate ?? false)
    ) {
      throw new Error(
        `Plan requires creating Lakehouse schemas for '${item.logicalId}', but allow-lakehouse-schema-create is false.`,
      );
    }
    if (
      item.lakehouseTables?.operations.some(
        (operation) =>
          operation.action === "create" &&
          (operation.resourceKind ?? "table") === "table",
      ) &&
      !(options.allowLakehouseTableCreate ?? false)
    ) {
      throw new Error(
        `Plan requires creating Lakehouse tables for '${item.logicalId}', but allow-lakehouse-table-create is false.`,
      );
    }
    if (item.action !== "create" && item.action !== "no-op") {
      throw new Error(
        `LakehouseTables item '${item.logicalId}' cannot be applied while action is '${item.action}'.`,
      );
    }
    if (
      item.lakehouseTables?.operations.some(
        (operation) =>
          operation.action === "adopt" ||
          operation.action === "blocked",
      )
    ) {
      throw new Error(
        `LakehouseTables item '${item.logicalId}' contains an adoption or blocked operation. Phase 3 does not execute ALTER TABLE.`,
      );
    }
    return;
  }
  if (
    item.type === "FabricTag" &&
    item.action === "create" &&
    !(options.allowTagCreate ?? false)
  ) {
    throw new Error(
      `Plan requires creating Fabric tag '${item.logicalId}', but allow-tag-create is false.`,
    );
  }
  if (item.type === "FabricTag" && item.action === "update") {
    throw new Error(
      `FabricTag item '${item.logicalId}' cannot be updated in place.`,
    );
  }
  if (item.action === "delete") {
    if (
      item.desiredState !== "absent" ||
      !isDeletableFabricItemType(item.type) ||
      !item.physicalId ||
      !item.observedStateHash
    ) {
      throw new Error(
        `Delete item '${item.logicalId}' is missing its exact approved deletion proof.`,
      );
    }
    if (!(options.allowDelete ?? false)) {
      throw new Error(
        `Plan requires deleting '${item.logicalId}', but allow-delete is false.`,
      );
    }
    if (
      item.type === "Lakehouse" &&
      !(options.allowLakehouseDataLoss ?? false)
    ) {
      throw new Error(
        `Plan requires deleting Lakehouse '${item.logicalId}', but allow-lakehouse-data-loss is false.`,
      );
    }
    return;
  }
  if (item.desiredState === "absent") {
    if (item.action !== "no-op" || item.physicalId) {
      throw new Error(
        `Absent item '${item.logicalId}' has invalid action '${item.action}'.`,
      );
    }
    return;
  }
  if (item.action === "create" && !options.allowCreate) {
    throw new Error(
      `Plan requires creating '${item.logicalId}', but allow-create is false.`,
    );
  }
  if (item.action === "update" && !options.allowUpdate) {
    throw new Error(
      `Plan requires updating '${item.logicalId}', but allow-update is false.`,
    );
  }
  if (
    (item.action === "update" || item.action === "no-op") &&
    !item.physicalId
  ) {
    throw new Error(
      `${item.action} item '${item.logicalId}' has no physical ID.`,
    );
  }
  if (
    item.action !== "create" &&
    item.action !== "update" &&
    item.action !== "no-op"
  ) {
    throw new Error(
      `Item '${item.logicalId}' cannot be applied while action is '${item.action}'.`,
    );
  }
}

function assertTagAssignmentAuthorized(
  options: ApplyPlanOptions,
  item: PlannedItem,
): void {
  if (item.tagAssignment) {
    if (
      item.tagAssignment.action === "update" &&
      !(options.allowTagAssign ?? false)
    ) {
      throw new Error(
        `Plan requires assigning Fabric tags to '${item.logicalId}', but allow-tag-assign is false.`,
      );
    }
    if (
      item.tagAssignment.action !== "update" &&
      item.tagAssignment.action !== "no-op"
    ) {
      throw new Error(
        `Fabric tag assignment for '${item.logicalId}' cannot be applied while action is '${item.tagAssignment.action}'.`,
      );
    }
  }
}

async function resumePendingOperations(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
  now: () => number,
): Promise<Set<string>> {
  const resumed = new Set<string>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const operation = getPendingOperation(checkpoint, logicalId);
      if (!operation) {
        continue;
      }
      const approvedItem = approvedItems.get(logicalId);
      if (
        !approvedItem ||
        (approvedItem.type !== "Lakehouse" &&
          approvedItem.type !== "Eventhouse" &&
          approvedItem.type !== "KQLDatabase" &&
          approvedItem.type !== "Warehouse" &&
          approvedItem.type !== "Environment" &&
          approvedItem.type !== "SparkCustomPool" &&
          approvedItem.type !== "Notebook" &&
          approvedItem.type !== "SparkJobDefinition" &&
          approvedItem.type !== "DataPipeline" &&
          approvedItem.type !== "CopyJob" &&
          approvedItem.type !== "SemanticModel" &&
          approvedItem.type !== "Report" &&
          approvedItem.type !== "Eventstream")
      ) {
        throw new Error(
          `Pending operation item '${logicalId}' is missing or unsupported.`,
        );
      }
      const currentItem = currentItems.get(logicalId);
      if (!currentItem) {
        throw new Error(
          `Current item '${logicalId}' is missing during operation resume.`,
        );
      }
      assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
      const desired = options.loadedManifest.itemDefinitions[logicalId];
      if (!desired) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      try {
        const created = await resumeCreateDesiredItem(
          options,
          approvedItem,
          desired,
          {
            ...(operation.operationId
              ? { operationId: operation.operationId }
              : {}),
            ...(operation.location ? { location: operation.location } : {}),
          },
          (physicalId) => {
            completeCreateCheckpoint(
              options,
              checkpoint,
              logicalId,
              physicalId,
              now,
            );
          },
        );
        if (!Object.hasOwn(checkpoint.completedItems, logicalId)) {
          completeCreateCheckpoint(
            options,
            checkpoint,
            logicalId,
            created.id,
            now,
          );
        }
      } catch (operationError) {
        let live;
        try {
          live = await planDesiredItem(options, approvedItem, desired);
        } catch (reconciliationError) {
          throw new AggregateError(
            [operationError, reconciliationError],
            `Could not resume or reconcile create operation for '${logicalId}'.`,
          );
        }
        if (
          approvedItem.type === "Environment" &&
          live.action === "update" &&
          live.physicalId &&
          hasEnvironmentRecoveryProof(options, approvedItem, live)
        ) {
          const verified = await updateDesiredItem(
            options,
            approvedItem,
            live.physicalId,
            desired,
          );
          completeCreateCheckpoint(
            options,
            checkpoint,
            logicalId,
            verified.id,
            now,
          );
          resumed.add(logicalId);
          continue;
        }
        if (live.action !== "no-op" || !live.physicalId) {
          if (
            operationError instanceof FabricOperationFailedError &&
            live.action === "create"
          ) {
            delete checkpoint.pendingOperations[logicalId];
            writeCheckpoint(options.checkpointFile, checkpoint);
          }
          throw operationError;
        }
        const completed = getCompletedItem(checkpoint, logicalId);
        if (completed && completed.physicalId !== live.physicalId) {
          throw new Error(
            `Create operation for '${logicalId}' returned physical ID '${completed.physicalId}', but live discovery found '${live.physicalId}'.`,
          );
        }
        const verified = await verifyDesiredItem(
          options,
          approvedItem,
          live.physicalId,
          desired,
        );
        completeCreateCheckpoint(
          options,
          checkpoint,
          logicalId,
          verified.id,
          now,
        );
      }
      resumed.add(logicalId);
    }
  }
  return resumed;
}

function completeCreateCheckpoint(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  logicalId: string,
  physicalId: string,
  now: () => number,
): void {
  delete checkpoint.pendingCreates[logicalId];
  delete checkpoint.pendingOperations[logicalId];
  checkpoint.completedItems[logicalId] = {
    logicalId,
    action: "create",
    physicalId,
    completedAt: new Date(now()).toISOString(),
  };
  writeCheckpoint(options.checkpointFile, checkpoint);
}

async function reconcilePendingCreates(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
  now: () => number,
): Promise<Set<string>> {
  const recovered = new Set<string>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const intent = getPendingCreate(checkpoint, logicalId);
      if (!intent) {
        continue;
      }
      const approvedItem = approvedItems.get(logicalId);
      const currentItem = currentItems.get(logicalId);
      if (
        !approvedItem ||
        (approvedItem.type !== "Lakehouse" &&
          approvedItem.type !== "Eventhouse" &&
          approvedItem.type !== "KQLDatabase" &&
          approvedItem.type !== "Warehouse" &&
          approvedItem.type !== "Environment" &&
          approvedItem.type !== "SparkCustomPool" &&
          approvedItem.type !== "Notebook" &&
          approvedItem.type !== "SparkJobDefinition" &&
          approvedItem.type !== "DataPipeline" &&
          approvedItem.type !== "CopyJob" &&
          approvedItem.type !== "SemanticModel" &&
          approvedItem.type !== "Report" &&
          approvedItem.type !== "Eventstream" &&
          approvedItem.type !== "FabricTag") ||
        !currentItem
      ) {
        throw new Error(
          `Pending create item '${logicalId}' is missing or unsupported.`,
        );
      }
      assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
      const desired = options.loadedManifest.itemDefinitions[logicalId];
      if (!desired) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      const live = await planDesiredItem(options, approvedItem, desired);
      if (
        approvedItem.type === "Environment" &&
        live.action === "update" &&
        live.physicalId &&
        hasEnvironmentRecoveryProof(options, approvedItem, live)
      ) {
        const verified = await updateDesiredItem(
          options,
          approvedItem,
          live.physicalId,
          desired,
        );
        delete checkpoint.pendingCreates[logicalId];
        checkpoint.completedItems[logicalId] = {
          logicalId,
          action: "create",
          physicalId: verified.id,
          completedAt: new Date(now()).toISOString(),
        };
        writeCheckpoint(options.checkpointFile, checkpoint);
        recovered.add(logicalId);
        continue;
      }
      if (live.action !== "no-op" || !live.physicalId) {
        throw new Error(
          `Create intent for '${logicalId}' has no resumable operation reference and current Fabric state is '${live.action}'. Wait for visibility or start a reviewed recovery before retrying.`,
        );
      }
      const verified = await verifyDesiredItem(
        options,
        approvedItem,
        live.physicalId,
        desired,
      );
      delete checkpoint.pendingCreates[logicalId];
      checkpoint.completedItems[logicalId] = {
        logicalId,
        action: "create",
        physicalId: verified.id,
        completedAt: new Date(now()).toISOString(),
      };
      writeCheckpoint(options.checkpointFile, checkpoint);
      recovered.add(logicalId);
    }
  }
  return recovered;
}

async function reconcilePendingUpdates(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
  now: () => number,
): Promise<Set<string>> {
  const recovered = new Set<string>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const intent = getPendingUpdate(checkpoint, logicalId);
      if (!intent) {
        continue;
      }
      const approvedItem = approvedItems.get(logicalId);
      const currentItem = currentItems.get(logicalId);
      if (
        !approvedItem ||
        (approvedItem.type !== "Lakehouse" &&
          approvedItem.type !== "Eventhouse" &&
          approvedItem.type !== "KQLDatabase" &&
          approvedItem.type !== "Warehouse" &&
          approvedItem.type !== "Environment" &&
          approvedItem.type !== "SparkCustomPool" &&
          approvedItem.type !== "Notebook" &&
          approvedItem.type !== "SparkJobDefinition" &&
          approvedItem.type !== "DataPipeline" &&
          approvedItem.type !== "CopyJob" &&
          approvedItem.type !== "SemanticModel" &&
          approvedItem.type !== "Report" &&
          approvedItem.type !== "Eventstream") ||
        approvedItem.action !== "update" ||
        !currentItem
      ) {
        throw new Error(
          `Pending update item '${logicalId}' is missing or unsupported.`,
        );
      }
      assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
      const desired = options.loadedManifest.itemDefinitions[logicalId];
      if (!desired) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      const live = await planDesiredItem(options, approvedItem, desired);
      if (
        live.action === "update" &&
        live.physicalId === intent.physicalId &&
        ((approvedItem.type === "Environment" &&
          hasEnvironmentRecoveryProof(
            options,
            approvedItem,
            live,
            intent,
          )) ||
          (approvedItem.type === "Notebook" &&
            hasNotebookRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "SparkJobDefinition" &&
            hasSparkJobRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "DataPipeline" &&
            hasPipelineRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "CopyJob" &&
            hasCopyJobRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "SemanticModel" &&
            hasSemanticModelRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "Report" &&
            hasReportRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )) ||
          (approvedItem.type === "SparkCustomPool" &&
            hasSparkCustomPoolRecoveryProof(
              approvedItem,
              live,
            )) ||
          (approvedItem.type === "Eventstream" &&
            hasEventstreamRecoveryProof(
              options,
              approvedItem,
              live,
              intent,
            )))
      ) {
        const verified = await updateDesiredItem(
          options,
          approvedItem,
          intent.physicalId,
          desired,
          undefined,
          (state) =>
            recordPendingUpdate(
              options,
              checkpoint,
              approvedItem,
              state,
              now,
            ),
          () => {
            delete checkpoint.pendingUpdates[logicalId];
            writeCheckpoint(options.checkpointFile, checkpoint);
          },
        );
        delete checkpoint.pendingUpdates[logicalId];
        checkpoint.completedItems[logicalId] = {
          logicalId,
          action: "update",
          physicalId: verified.id,
          completedAt: new Date(now()).toISOString(),
        };
        writeCheckpoint(options.checkpointFile, checkpoint);
        recovered.add(logicalId);
        continue;
      }
      if (
        live.action !== "no-op" ||
        live.physicalId !== intent.physicalId
      ) {
        throw new Error(
          `Update intent for '${logicalId}' cannot be reconciled because current Fabric state is '${live.action}'. Wait for visibility or start a reviewed recovery before retrying.`,
        );
      }
      if (
        (approvedItem.type === "SemanticModel" ||
          approvedItem.type === "Report") &&
        intent.preservedAuxiliaryHash !== undefined
      ) {
        const liveAuxiliaryHash =
          "currentAuxiliaryHash" in live
            ? live.currentAuxiliaryHash
            : undefined;
        if (
          liveAuxiliaryHash !==
          intent.preservedAuxiliaryHash
        ) {
          throw new Error(
            `Update intent for '${logicalId}' cannot be reconciled because the auxiliary definition parts differ from the checkpointed full-replacement proof.`,
          );
        }
      }
      const verified = await verifyDesiredItem(
        options,
        approvedItem,
        intent.physicalId,
        desired,
      );
      delete checkpoint.pendingUpdates[logicalId];
      checkpoint.completedItems[logicalId] = {
        logicalId,
        action: "update",
        physicalId: verified.id,
        completedAt: new Date(now()).toISOString(),
      };
      writeCheckpoint(options.checkpointFile, checkpoint);
      recovered.add(logicalId);
    }
  }
  return recovered;
}

async function reconcilePendingDeletes(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  currentItems: Map<string, PlannedItem>,
  now: () => number,
): Promise<Set<string>> {
  const recovered = new Set<string>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const intent = getPendingDelete(checkpoint, logicalId);
      if (!intent) {
        continue;
      }
      const approvedItem = approvedItems.get(logicalId);
      const currentItem = currentItems.get(logicalId);
      if (
        !approvedItem ||
        approvedItem.action !== "delete" ||
        approvedItem.desiredState !== "absent" ||
        !isDeletableFabricItemType(approvedItem.type) ||
        !currentItem
      ) {
        throw new Error(
          `Pending delete item '${logicalId}' is missing or unsupported.`,
        );
      }
      assertCheckpointedItemSourceUnchanged(
        approvedItem,
        currentItem,
      );
      const desired =
        options.loadedManifest.itemDefinitions[logicalId];
      if (!desired) {
        throw new Error(
          `Desired definition is missing for '${logicalId}'.`,
        );
      }
      const adapter = requireItemDeletionAdapter(
        options,
        logicalId,
      );
      let state = await adapter.verifyApprovedIdentity(
        options.approvedPlan.workspaceId,
        intent.physicalId,
        approvedItem.type,
        desired,
        intent.observedStateHash,
      );
      if (state === "unchanged") {
        await adapter.delete(
          options.approvedPlan.workspaceId,
          intent.physicalId,
        );
        state = await adapter.verifyApprovedIdentity(
          options.approvedPlan.workspaceId,
          intent.physicalId,
          approvedItem.type,
          desired,
          intent.observedStateHash,
        );
      }
      if (state !== "absent") {
        throw new Error(
          `Deletion intent for '${logicalId}' was accepted, but the exact approved item is still present.`,
        );
      }
      await assertDeletionIdentityIsAbsent(
        options,
        approvedItem,
        desired,
      );
      delete checkpoint.pendingDeletes[logicalId];
      checkpoint.completedItems[logicalId] = {
        logicalId,
        action: "delete",
        physicalId: intent.physicalId,
        completedAt: new Date(now()).toISOString(),
      };
      writeCheckpoint(options.checkpointFile, checkpoint);
      recovered.add(logicalId);
    }
  }
  return recovered;
}

async function reconcilePendingTagAssignments(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: ReadonlyMap<string, PlannedItem>,
  now: () => number,
): Promise<Set<string>> {
  const recovered = new Set<string>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      if (
        !checkpoint.tagAssignments ||
        !Object.hasOwn(checkpoint.tagAssignments, logicalId)
      ) {
        continue;
      }
      const item = approvedItems.get(logicalId);
      if (!item?.tagAssignment) {
        throw new Error(
          `Pending Fabric tag assignment item '${logicalId}' is missing from the approved plan.`,
        );
      }
      const completed = getCompletedItem(checkpoint, logicalId);
      const physicalId = completed?.physicalId ?? item.physicalId;
      if (!physicalId) {
        throw new Error(
          `Pending Fabric tag assignment '${logicalId}' has no materialized item ID.`,
        );
      }
      await applyItemTagAssignment(
        options,
        checkpoint,
        item,
        physicalId,
        now,
      );
      if (!completed) {
        if (item.action !== "no-op") {
          throw new Error(
            `Pending Fabric tag assignment '${logicalId}' cannot complete an uncheckpointed '${item.action}' item.`,
          );
        }
        await resumeCompletedItem(options, item, physicalId);
        checkpoint.completedItems[logicalId] = {
          logicalId,
          action: item.action,
          physicalId,
          completedAt: new Date(now()).toISOString(),
        };
        writeCheckpoint(options.checkpointFile, checkpoint);
      }
      recovered.add(logicalId);
    }
  }
  return recovered;
}

async function applyItemTagAssignment(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
  itemPhysicalId: string | undefined,
  now: () => number,
): Promise<NonNullable<ApplyItemResult["tagAssignment"]> | undefined> {
  const assignment = item.tagAssignment;
  if (!assignment) {
    return undefined;
  }
  if (!itemPhysicalId) {
    throw new Error(
      `Fabric tag assignment target '${item.logicalId}' has no physical ID.`,
    );
  }
  const adapter = requireTagAdapter(options, item.logicalId);
  const tagIds = resolveApprovedTagIds(options, checkpoint, item);
  if (assignment.action === "no-op") {
    await adapter.verifyItemAssignment(
      options.approvedPlan.workspaceId,
      itemPhysicalId,
      tagIds,
    );
    return {
      assignmentHash: assignment.assignmentHash,
      tagCount: tagIds.length,
      status: "verified",
    };
  }
  if (assignment.action !== "update") {
    throw new Error(
      `Fabric tag assignment for '${item.logicalId}' cannot be applied while action is '${assignment.action}'.`,
    );
  }
  if (!(options.allowTagAssign ?? false)) {
    throw new Error(
      `Plan requires assigning Fabric tags to '${item.logicalId}', but allow-tag-assign is false.`,
    );
  }

  checkpoint.tagAssignments ??= {};
  const existing = Object.hasOwn(
    checkpoint.tagAssignments,
    item.logicalId,
  )
    ? checkpoint.tagAssignments[item.logicalId]
    : undefined;
  if (
    existing &&
    (existing.assignmentHash !== assignment.assignmentHash ||
      existing.itemPhysicalId !== itemPhysicalId ||
      existing.tagIds.length !== tagIds.length ||
      !tagIds.every((id) => existing.tagIds.includes(id)))
  ) {
    throw new Error(
      `Fabric tag assignment checkpoint changed after approval for '${item.logicalId}'.`,
    );
  }
  const live = await adapter.planItemAssignment(
    options.approvedPlan.workspaceId,
    itemPhysicalId,
    tagIds,
  );
  if (live.action === "no-op") {
    const timestamp = new Date(now()).toISOString();
    checkpoint.tagAssignments[item.logicalId] = {
      logicalId: item.logicalId,
      assignmentHash: assignment.assignmentHash,
      itemPhysicalId,
      tagIds,
      phase: "verified",
      submittedAt: existing?.submittedAt ?? timestamp,
      verifiedAt: timestamp,
      updatedAt: timestamp,
    };
    writeCheckpoint(options.checkpointFile, checkpoint);
    return {
      assignmentHash: assignment.assignmentHash,
      tagCount: tagIds.length,
      status: existing?.phase === "submitting" ? "updated" : "verified",
    };
  }

  const submittedAt =
    existing?.submittedAt ?? new Date(now()).toISOString();
  checkpoint.tagAssignments[item.logicalId] = {
    logicalId: item.logicalId,
    assignmentHash: assignment.assignmentHash,
    itemPhysicalId,
    tagIds,
    phase: "submitting",
    submittedAt,
    updatedAt: new Date(now()).toISOString(),
  };
  writeCheckpoint(options.checkpointFile, checkpoint);
  await adapter.applyItemTags(
    options.approvedPlan.workspaceId,
    itemPhysicalId,
    live.missingTagIds,
  );
  await adapter.verifyItemAssignment(
    options.approvedPlan.workspaceId,
    itemPhysicalId,
    tagIds,
  );
  const verifiedAt = new Date(now()).toISOString();
  checkpoint.tagAssignments[item.logicalId] = {
    logicalId: item.logicalId,
    assignmentHash: assignment.assignmentHash,
    itemPhysicalId,
    tagIds,
    phase: "verified",
    submittedAt,
    verifiedAt,
    updatedAt: verifiedAt,
  };
  writeCheckpoint(options.checkpointFile, checkpoint);
  return {
    assignmentHash: assignment.assignmentHash,
    tagCount: tagIds.length,
    status: "updated",
  };
}

function resolveApprovedTagIds(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
): string[] {
  const assignment = item.tagAssignment;
  if (!assignment) {
    return [];
  }
  return assignment.tagLogicalIds.map((logicalId) => {
    const tag = options.approvedPlan.items.find(
      (candidate) => candidate.logicalId === logicalId,
    );
    if (!tag || tag.type !== "FabricTag") {
      throw new Error(
        `Fabric tag assignment '${item.logicalId}' references invalid FabricTag '${logicalId}'.`,
      );
    }
    const completed = getCompletedItem(checkpoint, logicalId);
    if (tag.action === "create") {
      if (
        !completed ||
        completed.action !== "create" ||
        !completed.physicalId
      ) {
        throw new Error(
          `FabricTag '${logicalId}' has not been materialized for '${item.logicalId}'.`,
        );
      }
      return completed.physicalId;
    }
    if (
      tag.action !== "no-op" ||
      !tag.physicalId ||
      (completed && completed.physicalId !== tag.physicalId)
    ) {
      throw new Error(
        `FabricTag '${logicalId}' does not have an approved physical ID for '${item.logicalId}'.`,
      );
    }
    return tag.physicalId;
  });
}

function assertCheckpointedItemSourceUnchanged(
  approved: PlannedItem,
  current: PlannedItem,
): void {
  const approvedSource = comparableItemSource(approved);
  const currentSource = comparableItemSource(current);
  if (stableJson(approvedSource) !== stableJson(currentSource)) {
    throw new Error(
      `Source content changed after approval for checkpointed item '${approved.logicalId}'. Generate a new plan.`,
    );
  }
}

function comparableItemSource(item: PlannedItem): unknown {
  return {
    logicalId: item.logicalId,
    type: item.type,
    path: item.path,
    displayName: item.displayName,
    contentHash: item.contentHash,
    desiredState: item.desiredState,
    dependsOn: item.dependsOn,
    tagAssignment: item.tagAssignment
      ? {
          assignmentHash: item.tagAssignment.assignmentHash,
          tagLogicalIds: item.tagAssignment.tagLogicalIds,
        }
      : undefined,
    sparkJobArtifacts: comparableSparkJobArtifactSource(item),
    lakehouseTables: item.lakehouseTables
      ? {
          targetLakehouseLogicalId:
            item.lakehouseTables.targetLakehouseLogicalId,
          desiredHash: item.lakehouseTables.desiredHash,
          sourceHash: item.lakehouseTables.sourceHash,
          operations: item.lakehouseTables.operations.map(
            (operation) => ({
              operationId: operation.operationId,
              operationHash: operation.operationHash,
              order: operation.order,
              logicalId: operation.logicalId,
              identifier: operation.identifier,
              desiredHash: operation.desiredHash,
            }),
          ),
        }
      : undefined,
  };
}

function assertApprovedOneLakeEndpointConfiguration(
  options: ApplyPlanOptions,
): void {
  const stagedItems = options.approvedPlan.items.filter(
    (item) => item.sparkJobArtifacts !== undefined,
  );
  if (stagedItems.length === 0) {
    return;
  }
  const dfsEndpoint = requireOneLakeDfsEndpoint(
    options,
    stagedItems[0]!.logicalId,
  );
  const blobEndpoint = requireOneLakeBlobEndpoint(
    options,
    stagedItems[0]!.logicalId,
  );
  const stagerIdentity =
    options.oneLakeArtifactStager?.getEndpointIdentity();
  if (
    !stagerIdentity ||
    stagerIdentity.dfsEndpoint !== dfsEndpoint ||
    stagerIdentity.blobEndpoint !== blobEndpoint
  ) {
    throw new Error(
      "OneLake artifact stager endpoints do not match the apply endpoint configuration.",
    );
  }
  for (const item of stagedItems) {
    const staging = item.sparkJobArtifacts!;
    assertSparkJobArtifactEndpoints(
      staging,
      dfsEndpoint,
      blobEndpoint,
    );
  }
}

function hasSymbolicSparkJobArtifactTarget(
  item: PlannedItem,
): boolean {
  return (
    item.type === "SparkJobDefinition" &&
    item.sparkJobArtifacts?.targetBinding === "symbolic"
  );
}

function hasSymbolicReportBinding(item: PlannedItem): boolean {
  return (
    item.type === "Report" &&
    item.action === "create" &&
    item.materializedDefinitionHash === undefined &&
    item.resolvedBindingsHash === undefined
  );
}

function hasSymbolicKqlDatabaseBinding(
  item: PlannedItem,
): boolean {
  return (
    item.type === "KQLDatabase" &&
    item.action === "create" &&
    item.materializedDefinitionHash === undefined &&
    item.resolvedBindingsHash === undefined
  );
}

function assertSymbolicReportPreflightState(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItem: PlannedItem,
  currentItem: PlannedItem,
  completed: ApplyCheckpoint["completedItems"][string] | undefined,
  hasPendingItem: boolean,
  trustedResume = false,
): void {
  assertCheckpointedItemSourceUnchanged(
    approvedItem,
    currentItem,
  );
  const hasMaterializedDefinition =
    currentItem.materializedDefinitionHash !== undefined;
  const hasResolvedBindings =
    currentItem.resolvedBindingsHash !== undefined;
  if (hasMaterializedDefinition !== hasResolvedBindings) {
    throw new Error(
      `Report '${approvedItem.logicalId}' has incomplete materialization proof.`,
    );
  }

  if (hasMaterializedDefinition) {
    const expected = requireReportRuntimeDefinition(
      { ...options, checkpoint },
      approvedItem.logicalId,
    );
    if (
      currentItem.materializedDefinitionHash !==
        expected.materializedDefinitionHash ||
      currentItem.resolvedBindingsHash !==
        expected.resolvedBindingsHash
    ) {
      throw new Error(
        `Report '${approvedItem.logicalId}' materialized with a different Semantic Model ID after approval.`,
      );
    }
  }
  if (completed) {
    if (
      trustedResume &&
      (currentItem.action === "create" ||
        (currentItem.action === "no-op" &&
          currentItem.physicalId === completed.physicalId))
    ) {
      return;
    }
    if (
      currentItem.action !== "no-op" ||
      currentItem.physicalId !== completed.physicalId
    ) {
      throw new Error(
        `Checkpointed Report '${approvedItem.logicalId}' is not a no-op for physical ID '${completed.physicalId}'.`,
      );
    }
    return;
  }
  if (hasPendingItem) {
    if (
      currentItem.action !== "create" &&
      currentItem.action !== "no-op"
    ) {
      throw new Error(
        `Pending Report '${approvedItem.logicalId}' has unsafe current action '${currentItem.action}'.`,
      );
    }
    return;
  }
  assertItemHasNotDrifted(approvedItem, {
    ...currentItem,
    materializedDefinitionHash: undefined,
    resolvedBindingsHash: undefined,
  });
}

function assertSymbolicKqlDatabasePreflightState(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItem: PlannedItem,
  currentItem: PlannedItem,
  completed: ApplyCheckpoint["completedItems"][string] | undefined,
  hasPendingItem: boolean,
  trustedResume = false,
): void {
  assertCheckpointedItemSourceUnchanged(
    approvedItem,
    currentItem,
  );
  const hasMaterializedDefinition =
    currentItem.materializedDefinitionHash !== undefined;
  const hasResolvedBindings =
    currentItem.resolvedBindingsHash !== undefined;
  if (hasMaterializedDefinition !== hasResolvedBindings) {
    throw new Error(
      `KQL Database '${approvedItem.logicalId}' has incomplete materialization proof.`,
    );
  }
  if (hasMaterializedDefinition) {
    const expected = requireKqlDatabaseRuntimeCreation(
      { ...options, checkpoint },
      approvedItem.logicalId,
    );
    if (
      currentItem.materializedDefinitionHash !==
        expected.materializedDefinitionHash ||
      currentItem.resolvedBindingsHash !==
        expected.resolvedBindingsHash
    ) {
      throw new Error(
        `KQL Database '${approvedItem.logicalId}' materialized with a different Eventhouse ID after approval.`,
      );
    }
  }
  if (completed) {
    if (
      trustedResume &&
      (currentItem.action === "create" ||
        (currentItem.action === "no-op" &&
          currentItem.physicalId === completed.physicalId))
    ) {
      return;
    }
    if (
      currentItem.action !== "no-op" ||
      currentItem.physicalId !== completed.physicalId
    ) {
      throw new Error(
        `Checkpointed KQL Database '${approvedItem.logicalId}' is not a no-op for physical ID '${completed.physicalId}'.`,
      );
    }
    return;
  }
  if (hasPendingItem) {
    if (
      currentItem.action !== "create" &&
      currentItem.action !== "no-op"
    ) {
      throw new Error(
        `Pending KQL Database '${approvedItem.logicalId}' has unsafe current action '${currentItem.action}'.`,
      );
    }
    return;
  }
  assertItemHasNotDrifted(approvedItem, {
    ...currentItem,
    materializedDefinitionHash: undefined,
    resolvedBindingsHash: undefined,
  });
}

function assertSymbolicSparkJobArtifactPreflightState(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItem: PlannedItem,
  currentItem: PlannedItem,
  completed:
    | ApplyCheckpoint["completedItems"][string]
    | undefined,
  hasPendingItem: boolean,
  trustedResume: boolean,
  deferPendingTargetRecovery = false,
  requireMaterializedTarget = false,
): void {
  const approved = approvedItem.sparkJobArtifacts;
  const current = currentItem.sparkJobArtifacts;
  if (
    approvedItem.type !== "SparkJobDefinition" ||
    approved?.targetBinding !== "symbolic" ||
    !current
  ) {
    throw new Error(
      `Symbolic Spark Job artifact plan payload is missing for '${approvedItem.logicalId}'.`,
    );
  }
  assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);

  const approvedTarget = options.approvedPlan.items.find(
    (candidate) =>
      candidate.logicalId === approved.targetLakehouseLogicalId,
  );
  const currentTarget = options.currentPlan.items.find(
    (candidate) =>
      candidate.logicalId === approved.targetLakehouseLogicalId,
  );
  if (
    !approvedTarget ||
    approvedTarget.type !== "Lakehouse" ||
    !currentTarget ||
    currentTarget.type !== "Lakehouse"
  ) {
    throw new Error(
      `Spark Job artifact target '${approved.targetLakehouseLogicalId}' is missing or is not a Lakehouse.`,
    );
  }
  assertCheckpointedItemSourceUnchanged(
    approvedTarget,
    currentTarget,
  );
  if (approvedTarget.action !== "create") {
    throw new Error(
      `Spark Job artifact target '${approvedTarget.logicalId}' was not approved for creation.`,
    );
  }

  const completedTarget = getCompletedItem(
    checkpoint,
    approvedTarget.logicalId,
  );
  if (!completedTarget) {
    if (requireMaterializedTarget) {
      throw new Error(
        `Spark Job artifact recovery requires a completed target Lakehouse checkpoint for '${approvedItem.logicalId}'.`,
      );
    }
    if (
      deferPendingTargetRecovery &&
      hasApprovedPendingCreateRecovery(
        options,
        checkpoint,
        approvedTarget,
      )
    ) {
      return;
    }
    if (
      currentTarget.action !== "create" ||
      current.targetBinding !== "symbolic"
    ) {
      throw new Error(
        `Spark Job artifact target changed before creation for '${approvedItem.logicalId}'.`,
      );
    }
    assertItemHasNotDrifted(approvedItem, currentItem);
    return;
  }

  const targetLakehouseId = completedTarget.physicalId;
  if (!targetLakehouseId) {
    throw new Error(
      `Completed target Lakehouse '${approvedTarget.logicalId}' has no physical ID.`,
    );
  }
  const currentPlanStillSymbolic =
    currentTarget.action === "create" &&
    current.targetBinding === "symbolic";
  const currentPlanMaterialized =
    currentTarget.action === "no-op" &&
    currentTarget.physicalId === targetLakehouseId &&
    current.targetBinding === "physical" &&
    current.targetLakehousePhysicalId === targetLakehouseId;
  if (requireMaterializedTarget && currentPlanStillSymbolic) {
    throw new Error(
      `Spark Job artifact recovery requires the current plan to resolve the exact checkpointed Lakehouse ID for '${approvedItem.logicalId}'.`,
    );
  }
  if (
    completedTarget.action !== "create" ||
    (!currentPlanStillSymbolic && !currentPlanMaterialized)
  ) {
    throw new Error(
      `Spark Job artifact target did not materialize to the exact checkpointed Lakehouse ID for '${approvedItem.logicalId}'.`,
    );
  }

  if (currentPlanMaterialized) {
    assertCurrentSparkJobArtifactMaterialization(
      options,
      checkpoint,
      approvedItem,
      currentItem,
      targetLakehouseId,
    );
  } else if (
    currentItem.materializedDefinitionHash !==
      approvedItem.materializedDefinitionHash ||
    currentItem.resolvedBindingsHash !==
      approvedItem.resolvedBindingsHash
  ) {
    throw new Error(
      `Spark Job Definition '${approvedItem.logicalId}' contains unexpected materialization proof while its artifact target is symbolic.`,
    );
  }

  if (completed) {
    if (
      !trustedResume &&
      (currentItem.action !== "no-op" ||
        currentItem.physicalId !== completed.physicalId)
    ) {
      throw new Error(
        `Checkpointed item '${approvedItem.logicalId}' is not a no-op for physical ID '${completed.physicalId}' in the current Fabric plan.`,
      );
    }
    return;
  }
  if (hasPendingItem) {
    return;
  }

  assertItemHasNotDrifted(approvedItem, {
    ...currentItem,
    materializedDefinitionHash:
      approvedItem.materializedDefinitionHash,
    resolvedBindingsHash: approvedItem.resolvedBindingsHash,
    sparkJobArtifacts: approved,
  });
}

function assertCurrentSparkJobArtifactMaterialization(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItem: PlannedItem,
  currentItem: PlannedItem,
  targetLakehouseId: string,
): void {
  const approved = approvedItem.sparkJobArtifacts;
  const current = currentItem.sparkJobArtifacts;
  if (!approved || !current) {
    throw new Error(
      `Spark Job artifact materialization is missing for '${approvedItem.logicalId}'.`,
    );
  }
  const sources =
    options.loadedManifest.sparkJobArtifactSources?.[
      approvedItem.logicalId
    ] ?? [];
  const expected = materializeSparkJobArtifactUris(
    approved,
    sources,
    requireOneLakeDfsEndpoint(options, approvedItem.logicalId),
    options.approvedPlan.workspaceId,
    targetLakehouseId,
    options.approvedPlan.deploymentId,
    options.approvedPlan.environment,
    approvedItem.logicalId,
  );
  const expectedByName = new Map(
    expected.map((artifact) => [artifact.fileName, artifact]),
  );
  for (const artifact of current.artifacts) {
    const expectedArtifact = expectedByName.get(artifact.fileName);
    if (
      !expectedArtifact ||
      artifact.kind !== expectedArtifact.kind ||
      artifact.contentHash !== expectedArtifact.contentHash ||
      artifact.abfssUri !== expectedArtifact.abfssUri ||
      (artifact.action !== "create" &&
        artifact.action !== "no-op") ||
      (artifact.action === "no-op" &&
        artifact.observedHash !== artifact.contentHash) ||
      (artifact.action === "create" &&
        artifact.observedHash !== "" &&
        artifact.observedHash !== "absent")
    ) {
      throw new Error(
        `Spark Job artifact runtime materialization changed after approval for '${approvedItem.logicalId}'.`,
      );
    }
  }

  const hasMaterializedDefinition =
    currentItem.materializedDefinitionHash !== undefined;
  const hasResolvedBindings =
    currentItem.resolvedBindingsHash !== undefined;
  if (hasMaterializedDefinition !== hasResolvedBindings) {
    throw new Error(
      `Spark Job Definition '${approvedItem.logicalId}' has incomplete materialization proof.`,
    );
  }
  if (
    !allApprovedSparkJobBindingsResolved(
      options,
      checkpoint,
      approvedItem.logicalId,
    )
  ) {
    return;
  }
  const expectedDefinition = requireSparkJobRuntimeDefinition(
    { ...options, checkpoint },
    approvedItem.logicalId,
  );
  if (
    currentItem.materializedDefinitionHash !==
      expectedDefinition.materializedDefinitionHash ||
    currentItem.resolvedBindingsHash !==
      expectedDefinition.resolvedBindingsHash
  ) {
    throw new Error(
      `Spark Job Definition '${approvedItem.logicalId}' materialized with different dependency or artifact IDs after approval.`,
    );
  }
}

function allApprovedSparkJobBindingsResolved(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): boolean {
  const item = options.loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === logicalId,
  );
  const desired =
    options.loadedManifest.itemDefinitions[logicalId];
  if (!item || !desired) {
    throw new Error(
      `Spark Job Definition declarations are missing for '${logicalId}'.`,
    );
  }
  const bindings = validateLogicalReferenceDeclarations({
    item,
    definition: desired,
    itemGraph: options.loadedManifest.manifest.items,
  });
  return Object.values(bindings).every((binding) => {
    if (!binding) {
      return true;
    }
    const approvedDependency = options.approvedPlan.items.find(
      (candidate) => candidate.logicalId === binding.logicalId,
    );
    const completedDependency = getCompletedItem(
      checkpoint,
      binding.logicalId,
    );
    return (
      completedDependency !== undefined ||
      (approvedDependency?.physicalId !== undefined &&
        (approvedDependency.action === "update" ||
          approvedDependency.action === "no-op"))
    );
  });
}

function assertLakehouseTablesPreflightState(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItem: PlannedItem,
  currentItem: PlannedItem,
  completed:
    | ApplyCheckpoint["completedItems"][string]
    | undefined,
  hasBundleCheckpoint: boolean,
  deferPendingTargetRecovery = false,
): void {
  const approved = approvedItem.lakehouseTables;
  const current = currentItem.lakehouseTables;
  if (!approved || !current) {
    throw new Error(
      `LakehouseTables plan payload is missing for '${approvedItem.logicalId}'.`,
    );
  }
  assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
  if (
    current.targetLakehouseLogicalId !==
    approved.targetLakehouseLogicalId
  ) {
    throw new Error(
      `LakehouseTables target logical ID changed after approval for '${approvedItem.logicalId}'.`,
    );
  }

  const approvedTarget = options.approvedPlan.items.find(
    (candidate) =>
      candidate.logicalId === approved.targetLakehouseLogicalId,
  );
  const currentTarget = options.currentPlan.items.find(
    (candidate) =>
      candidate.logicalId === approved.targetLakehouseLogicalId,
  );
  if (
    !approvedTarget ||
    approvedTarget.type !== "Lakehouse" ||
    !currentTarget ||
    currentTarget.type !== "Lakehouse"
  ) {
    throw new Error(
      `LakehouseTables target '${approved.targetLakehouseLogicalId}' is missing or is not a Lakehouse.`,
    );
  }

  if (approved.targetBinding === "physical") {
    const expectedId = approved.targetLakehousePhysicalId;
    if (
      !expectedId ||
      approvedTarget.physicalId !== expectedId ||
      current.targetBinding !== "physical" ||
      current.targetLakehousePhysicalId !== expectedId ||
      currentTarget.physicalId !== expectedId
    ) {
      throw new Error(
        `LakehouseTables physical target changed after approval for '${approvedItem.logicalId}'.`,
      );
    }
    if (completed && completed.physicalId !== expectedId) {
      throw new Error(
        `Checkpointed LakehouseTables item '${approvedItem.logicalId}' is bound to unexpected physical ID '${completed.physicalId}'.`,
      );
    }
    if (!completed && !hasBundleCheckpoint) {
      assertItemHasNotDrifted(approvedItem, currentItem);
    }
    return;
  }

  if (approvedTarget.action !== "create") {
    throw new Error(
      `LakehouseTables symbolic target '${approvedTarget.logicalId}' was not approved for creation.`,
    );
  }
  const completedTarget = getCompletedItem(
    checkpoint,
    approvedTarget.logicalId,
  );
  if (!completedTarget) {
    if (
      deferPendingTargetRecovery &&
      hasApprovedPendingCreateRecovery(
        options,
        checkpoint,
        approvedTarget,
      )
    ) {
      assertCheckpointedItemSourceUnchanged(
        approvedTarget,
        currentTarget,
      );
      return;
    }
    if (
      currentTarget.action !== "create" ||
      current.targetBinding !== "symbolic"
    ) {
      throw new Error(
        `LakehouseTables symbolic target changed before creation for '${approvedItem.logicalId}'.`,
      );
    }
    return;
  }
  const currentPlanStillSymbolic =
    currentTarget.action === "create" &&
    current.targetBinding === "symbolic";
  const currentPlanMaterialized =
    currentTarget.action === "no-op" &&
    currentTarget.physicalId === completedTarget.physicalId &&
    current.targetBinding === "physical" &&
    current.targetLakehousePhysicalId === completedTarget.physicalId;
  if (
    completedTarget.action !== "create" ||
    (!currentPlanStillSymbolic && !currentPlanMaterialized)
  ) {
    throw new Error(
      `LakehouseTables symbolic target did not materialize to the exact checkpointed Lakehouse ID for '${approvedItem.logicalId}'.`,
    );
  }
  if (completed && completed.physicalId !== completedTarget.physicalId) {
    throw new Error(
      `Checkpointed LakehouseTables item '${approvedItem.logicalId}' is not bound to its exact completed target Lakehouse ID.`,
    );
  }
}

function hasApprovedPendingCreateRecovery(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedTarget: PlannedItem,
): boolean {
  if (
    approvedTarget.type !== "Lakehouse" ||
    approvedTarget.action !== "create" ||
    checkpoint.planHash !== options.approvedPlan.planHash
  ) {
    return false;
  }
  const pendingCreate = getPendingCreate(
    checkpoint,
    approvedTarget.logicalId,
  );
  const pendingOperation = getPendingOperation(
    checkpoint,
    approvedTarget.logicalId,
  );
  if (
    (pendingCreate === undefined) ===
    (pendingOperation === undefined)
  ) {
    return false;
  }
  const pending = pendingCreate ?? pendingOperation;
  return (
    pending?.logicalId === approvedTarget.logicalId &&
    pending.action === "create" &&
    pending.materializedDefinitionHash ===
      approvedTarget.materializedDefinitionHash &&
    pending.resolvedBindingsHash ===
      approvedTarget.resolvedBindingsHash
  );
}

async function verifyCheckpointedOneLakeArtifactTargets(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: ReadonlyMap<string, PlannedItem>,
  now: () => number,
): Promise<Map<string, number>> {
  const targetLogicalIds = new Set<string>();
  for (const item of approvedItems.values()) {
    const staging = item.sparkJobArtifacts;
    if (!staging || staging.targetBinding !== "symbolic") {
      continue;
    }
    const hasArtifactState =
      checkpoint.oneLakeArtifacts?.[item.logicalId] !== undefined;
    const hasPendingItem =
      getPendingOperation(checkpoint, item.logicalId) !== undefined ||
      getPendingCreate(checkpoint, item.logicalId) !== undefined ||
      getPendingUpdate(checkpoint, item.logicalId) !== undefined;
    if (hasArtifactState || hasPendingItem) {
      targetLogicalIds.add(staging.targetLakehouseLogicalId);
    }
  }

  const durations = new Map<string, number>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      if (!targetLogicalIds.has(logicalId)) {
        continue;
      }
      const approvedTarget = approvedItems.get(logicalId);
      const completedTarget = getCompletedItem(
        checkpoint,
        logicalId,
      );
      if (
        !approvedTarget ||
        approvedTarget.type !== "Lakehouse" ||
        !completedTarget ||
        completedTarget.action !== "create"
      ) {
        throw new Error(
          `OneLake artifact recovery target '${logicalId}' is missing its approved completed Lakehouse checkpoint.`,
        );
      }
      const startedAt = now();
      await resumeCompletedItem(
        options,
        approvedTarget,
        completedTarget.physicalId,
      );
      durations.set(logicalId, now() - startedAt);
    }
  }
  return durations;
}

async function verifyCheckpointedItems(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  now: () => number,
  previouslyVerified = new Map<string, number>(),
): Promise<Map<string, number>> {
  const durations = new Map(previouslyVerified);
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const completed = getCompletedItem(checkpoint, logicalId);
      if (!completed || durations.has(logicalId)) {
        continue;
      }
      const approvedItem = approvedItems.get(logicalId);
      if (!approvedItem) {
        throw new Error(
          `Approved item '${logicalId}' is missing during checkpoint verification.`,
        );
      }
      const startedAt = now();
      await resumeCompletedItem(options, approvedItem, completed.physicalId);
      durations.set(logicalId, now() - startedAt);
    }
  }
  return durations;
}

function getCompletedItem(
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): ApplyCheckpoint["completedItems"][string] | undefined {
  return Object.hasOwn(checkpoint.completedItems, logicalId)
    ? checkpoint.completedItems[logicalId]
    : undefined;
}

function getPendingOperation(
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): ApplyCheckpoint["pendingOperations"][string] | undefined {
  return Object.hasOwn(checkpoint.pendingOperations, logicalId)
    ? checkpoint.pendingOperations[logicalId]
    : undefined;
}

function getPendingCreate(
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): ApplyCheckpoint["pendingCreates"][string] | undefined {
  return Object.hasOwn(checkpoint.pendingCreates, logicalId)
    ? checkpoint.pendingCreates[logicalId]
    : undefined;
}

function getPendingUpdate(
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): ApplyCheckpoint["pendingUpdates"][string] | undefined {
  return Object.hasOwn(checkpoint.pendingUpdates, logicalId)
    ? checkpoint.pendingUpdates[logicalId]
    : undefined;
}

function getPendingDelete(
  checkpoint: ApplyCheckpoint,
  logicalId: string,
): ApplyCheckpoint["pendingDeletes"][string] | undefined {
  return Object.hasOwn(checkpoint.pendingDeletes, logicalId)
    ? checkpoint.pendingDeletes[logicalId]
    : undefined;
}

function assertItemHasNotDrifted(
  approved: PlannedItem,
  current: PlannedItem,
): void {
  const approvedState = comparableItemState(approved);
  const currentState = comparableItemState(current);
  if (stableJson(approvedState) !== stableJson(currentState)) {
    throw new Error(
      `Fabric state drifted after approval for item '${approved.logicalId}'. Generate a new plan.`,
    );
  }
}

function comparableItemState(item: PlannedItem): unknown {
  return {
    logicalId: item.logicalId,
    type: item.type,
    displayName: item.displayName,
    contentHash: item.contentHash,
    desiredState: item.desiredState,
    dependsOn: item.dependsOn,
    action: item.action,
    physicalId: item.physicalId,
    observedStateHash: item.observedStateHash,
    materializedDefinitionHash:
      item.materializedDefinitionHash,
    resolvedBindingsHash: item.resolvedBindingsHash,
    sparkJobArtifacts: comparableSparkJobArtifactSource(item),
    lakehouseTables: item.lakehouseTables,
    tagAssignment: item.tagAssignment
      ? {
          assignmentHash: item.tagAssignment.assignmentHash,
          tagLogicalIds: item.tagAssignment.tagLogicalIds,
          missingTagLogicalIds:
            item.tagAssignment.missingTagLogicalIds,
          action: item.tagAssignment.action,
        }
      : undefined,
  };
}

function comparableSparkJobArtifactSource(
  item: PlannedItem,
): unknown {
  const staging = item.sparkJobArtifacts;
  if (!staging) {
    return undefined;
  }
  return {
    targetLakehouseLogicalId: staging.targetLakehouseLogicalId,
    oneLakeDfsEndpoint: staging.oneLakeDfsEndpoint,
    oneLakeBlobEndpoint: staging.oneLakeBlobEndpoint,
    stagingHash: staging.stagingHash,
    artifacts: staging.artifacts.map((artifact) => ({
      kind: artifact.kind,
      operationId: artifact.operationId,
      operationHash: artifact.operationHash,
      fileName: artifact.fileName,
      relativeSourcePath: artifact.relativeSourcePath,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
      oneLakePath: artifact.oneLakePath,
    })),
  };
}

async function applyLakehouseTablesItem(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
  startedAt: number,
  now: () => number,
): Promise<ApplyItemResult> {
  const adapter = options.lakehouseTablesAdapter;
  const definition =
    options.loadedManifest.lakehouseTablesDefinitions?.[item.logicalId];
  const plan = item.lakehouseTables;
  if (!adapter || !definition || !plan) {
    throw new Error(
      `LakehouseTables runtime is missing for '${item.logicalId}'.`,
    );
  }
  if (
    plan.operations.some(
      (operation) =>
        operation.action === "create" &&
        operation.resourceKind === "schema",
    ) &&
    !(options.allowLakehouseSchemaCreate ?? false)
  ) {
    throw new Error(
      `Plan requires creating Lakehouse schemas for '${item.logicalId}', but allow-lakehouse-schema-create is false.`,
    );
  }
  if (
    plan.operations.some(
      (operation) =>
        operation.action === "create" &&
        (operation.resourceKind ?? "table") === "table",
    ) &&
    !(options.allowLakehouseTableCreate ?? false)
  ) {
    throw new Error(
      `Plan requires creating Lakehouse tables for '${item.logicalId}', but allow-lakehouse-table-create is false.`,
    );
  }
  if (
    plan.operations.some(
      (operation) =>
        operation.action === "blocked" ||
        operation.action === "adopt",
    )
  ) {
    throw new Error(
      `LakehouseTables item '${item.logicalId}' contains blocked or adoption operations. Phase 3 does not execute ALTER TABLE.`,
    );
  }
  if (item.action !== "create" && item.action !== "no-op") {
    throw new Error(
      `LakehouseTables item '${item.logicalId}' cannot be applied while action is '${item.action}'.`,
    );
  }
  const targetLakehouseId = resolveLakehouseTablesTargetId(
    options,
    item,
  );
  const execution = {
    sourceHash: definition.sourceHash,
    attemptId: `ddl-${sha256(
      stableJson({
        planHash: options.approvedPlan.planHash,
        logicalId: item.logicalId,
      }),
    ).slice(0, 40)}`,
    deploymentId: options.approvedPlan.deploymentId,
    bundleLogicalId: item.logicalId,
    targetLakehouseLogicalId:
      plan.targetLakehouseLogicalId,
  };
  const operations = buildLakehouseDdlCreateOperations(
    definition,
    execution,
  );
  assertLakehouseTablesOperationProof(item, definition, operations);
  await recoverLakehouseTablesCheckpoint(
    options,
    checkpoint,
    item,
    targetLakehouseId,
    operations,
    now,
  );
  const sessionName = createLakehouseTablesSessionName(
    options.approvedPlan.workspaceId,
    targetLakehouseId,
    definition.desiredHash,
    execution,
  );
  const hooks: LakehouseTableExecutionHooks = {
    onSessionSubmitting: (context) => {
      checkpoint.lakehouseTables ??= {};
      checkpoint.lakehouseTables[item.logicalId] = {
        logicalId: item.logicalId,
        targetLakehouseLogicalId:
          plan.targetLakehouseLogicalId,
        targetLakehouseId,
        desiredHash: definition.desiredHash,
        sourceHash: definition.sourceHash,
        attemptId: execution.attemptId,
        sessionName,
        sessionRequestHash: context.requestHash,
        sessionPhase: "submitting",
        sessionSubmittedAt: context.submittedAt,
        completedOperationHashes:
          checkpoint.lakehouseTables[item.logicalId]
            ?.completedOperationHashes ?? [],
        operationReceipts:
          checkpoint.lakehouseTables[item.logicalId]
            ?.operationReceipts ?? [],
        updatedAt: new Date(now()).toISOString(),
      };
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onSessionAccepted: (context) => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      state.sessionId = context.sessionId;
      state.sessionPhase = "accepted";
      state.sessionAcceptedAt = new Date(now()).toISOString();
      state.updatedAt = state.sessionAcceptedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onSessionCreated: () => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      state.sessionPhase = "active";
      state.updatedAt = new Date(now()).toISOString();
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onStatementSubmitting: (context) => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      state.statement = {
        statementAttemptName: context.statementAttemptName,
        purpose: context.purpose,
        tableLogicalId: context.logicalId,
        ...(context.operation
          ? { operationHash: context.operation.operationHash }
          : {}),
        codeHash: context.codeHash,
        phase: "submitting",
        submittedAt: new Date(now()).toISOString(),
      };
      state.updatedAt = state.statement.submittedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onStatementAccepted: (context) => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      if (!state.statement) {
        throw new Error(
          `LakehouseTables statement checkpoint is missing for '${item.logicalId}'.`,
        );
      }
      state.statement.statementId = context.statementId;
      state.statement.phase = "accepted";
      state.statement.acceptedAt = new Date(now()).toISOString();
      state.updatedAt = state.statement.acceptedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onOperationVerified: (context) => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      if (!state.statement) {
        throw new Error(
          `LakehouseTables operation checkpoint is missing for '${item.logicalId}'.`,
        );
      }
      state.statement.phase = "verified";
      state.statement.verifiedAt = new Date(now()).toISOString();
      if (
        !state.completedOperationHashes.includes(
          context.operation.operationHash,
        )
      ) {
        state.completedOperationHashes.push(
          context.operation.operationHash,
        );
      }
      const statement = state.statement;
      if (
        statement.statementId === undefined ||
        !statement.acceptedAt ||
        !statement.verifiedAt
      ) {
        throw new Error(
          `LakehouseTables verified operation receipt is incomplete for '${item.logicalId}'.`,
        );
      }
      state.operationReceipts = state.operationReceipts.filter(
        (receipt) =>
          receipt.operationHash !==
          context.operation.operationHash,
      );
      state.operationReceipts.push({
        operationHash: context.operation.operationHash,
        tableLogicalId: context.operation.logicalId,
        statementAttemptName: statement.statementAttemptName,
        codeHash: statement.codeHash,
        statementId: statement.statementId,
        submittedAt: statement.submittedAt,
        acceptedAt: statement.acceptedAt,
        verifiedAt: statement.verifiedAt,
      });
      state.updatedAt = state.statement.verifiedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onSessionCleanupSubmitting: () => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      state.sessionPhase = "cleanup-submitting";
      state.updatedAt = new Date(now()).toISOString();
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
    onSessionCleanupComplete: () => {
      const state = requireLakehouseTablesCheckpoint(
        checkpoint,
        item.logicalId,
      );
      state.sessionPhase = "cleanup-complete";
      state.cleanupCompletedAt = new Date(now()).toISOString();
      state.updatedAt = state.cleanupCompletedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    },
  };
  const applied =
    item.action === "create"
      ? await adapter.apply(
          options.approvedPlan.workspaceId,
          targetLakehouseId,
          definition,
          execution,
          hooks,
        )
      : await adapter.verify(
          options.approvedPlan.workspaceId,
          targetLakehouseId,
          definition,
          execution,
          hooks,
        );
  if (
    item.action === "no-op" &&
    "matches" in applied &&
    !applied.matches
  ) {
    throw new Error(
      `LakehouseTables verification failed for '${item.logicalId}'.`,
    );
  }
  const finalCheckpoint = requireLakehouseTablesCheckpoint(
    checkpoint,
    item.logicalId,
  );
  if (finalCheckpoint.sessionPhase !== "cleanup-complete") {
    throw new Error(
      `LakehouseTables session cleanup is incomplete for '${item.logicalId}'.`,
    );
  }
  return {
    logicalId: item.logicalId,
    type: item.type,
    action: item.action,
    status: item.action === "create" ? "created" : "verified",
    physicalId: targetLakehouseId,
    durationMs: now() - startedAt,
    lakehouseTables: {
      desiredHash: definition.desiredHash,
      observedStateHash: applied.observedStateHash,
      operationCount:
        "operations" in applied ? applied.operations.length : 0,
    },
  };
}

function resolveLakehouseTablesTargetId(
  options: ApplyPlanOptions,
  item: PlannedItem,
): string {
  const plan = item.lakehouseTables;
  if (!plan) {
    throw new Error(
      `LakehouseTables plan payload is missing for '${item.logicalId}'.`,
    );
  }
  const approvedTarget = options.approvedPlan.items.find(
    (candidate) =>
      candidate.logicalId === plan.targetLakehouseLogicalId,
  );
  if (!approvedTarget || approvedTarget.type !== "Lakehouse") {
    throw new Error(
      `LakehouseTables target '${plan.targetLakehouseLogicalId}' is not an approved Lakehouse item.`,
    );
  }
  if (plan.targetBinding === "physical") {
    if (
      !plan.targetLakehousePhysicalId ||
      approvedTarget.physicalId !== plan.targetLakehousePhysicalId ||
      item.physicalId !== plan.targetLakehousePhysicalId
    ) {
      throw new Error(
        `LakehouseTables physical target proof changed for '${item.logicalId}'.`,
      );
    }
    return plan.targetLakehousePhysicalId;
  }
  if (approvedTarget.action !== "create") {
    throw new Error(
      `LakehouseTables symbolic target '${approvedTarget.logicalId}' was not approved for creation.`,
    );
  }
  const completed = options.checkpoint
    ? getCompletedItem(options.checkpoint, approvedTarget.logicalId)
    : undefined;
  if (!completed?.physicalId) {
    throw new Error(
      `LakehouseTables target '${approvedTarget.logicalId}' has no completed runtime physical ID.`,
    );
  }
  return completed.physicalId;
}

function assertLakehouseTablesOperationProof(
  item: PlannedItem,
  definition: NonNullable<
    LoadedManifest["lakehouseTablesDefinitions"]
  >[string],
  operations: ReturnType<typeof buildLakehouseDdlCreateOperations>,
): void {
  const plan = item.lakehouseTables;
  if (
    !plan ||
    plan.desiredHash !== definition.desiredHash ||
    plan.sourceHash !== definition.sourceHash ||
    plan.operations.length !== operations.length
  ) {
    throw new Error(
      `LakehouseTables source or operation proof changed for '${item.logicalId}'.`,
    );
  }
  for (const [index, operation] of operations.entries()) {
    const approved = plan.operations[index];
    if (
      !approved ||
      approved.operationId !== operation.operationId ||
      approved.operationHash !== operation.operationHash ||
      approved.order !== operation.order ||
      (approved.resourceKind ?? "table") !==
        (operation.kind === "create-schema" ? "schema" : "table") ||
      approved.logicalId !== operation.logicalId ||
      approved.identifier !== operation.identifier ||
      approved.desiredHash !== operation.desiredHash
    ) {
      throw new Error(
        `LakehouseTables operation proof changed for '${item.logicalId}' at order ${index}.`,
      );
    }
  }
}

async function recoverLakehouseTablesCheckpoint(
    options: ApplyPlanOptions,
    checkpoint: ApplyCheckpoint,
    item: PlannedItem,
    targetLakehouseId: string,
    operations: ReturnType<typeof buildLakehouseDdlCreateOperations>,
    now: () => number,
  ): Promise<void> {
    const state = checkpoint.lakehouseTables?.[item.logicalId];
    if (!state || state.sessionPhase === "cleanup-complete") {
      return;
    }
    const adapter = options.lakehouseTablesAdapter;
    if (!adapter) {
      throw new Error(
        `LakehouseTables adapter is missing during recovery for '${item.logicalId}'.`,
      );
    }
    if (state.targetLakehouseId !== targetLakehouseId) {
      throw new Error(
        `LakehouseTables runtime target changed during recovery for '${item.logicalId}'.`,
      );
    }
    if (state.sessionPhase === "cleanup-submitting") {
      if (!state.sessionId) {
        throw new Error(
          `LakehouseTables cleanup checkpoint for '${item.logicalId}' is missing its session ID.`,
        );
      }
      await adapter.deleteSessionById(
        options.approvedPlan.workspaceId,
        targetLakehouseId,
        state.sessionId,
      );
      state.sessionPhase = "cleanup-complete";
      state.cleanupCompletedAt = new Date(now()).toISOString();
      state.updatedAt = state.cleanupCompletedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
      return;
    }
    if (!state.sessionId) {
      const submitted = Date.parse(state.sessionSubmittedAt);
      const discovery = await adapter.discoverSessionAttempt(
        options.approvedPlan.workspaceId,
        targetLakehouseId,
        {
          sessionName: state.sessionName,
          attemptId: state.attemptId,
          requestHash: state.sessionRequestHash,
          submittedAfter: new Date(submitted - 5 * 60_000).toISOString(),
          submittedBefore: new Date(submitted + 5 * 60_000).toISOString(),
        },
      );
      if (discovery.outcome !== "single") {
        throw new Error(
          `Unresolved LakehouseTables session POST for '${item.logicalId}' cannot be recovered safely (${discovery.outcome}). Zero or multiple matches fail closed. Do not resubmit automatically.`,
        );
      }
      if (
        !["starting", "idle", "busy", "running"].includes(
          discovery.session.state ?? "",
        )
      ) {
        throw new Error(
          `Recovered LakehouseTables session for '${item.logicalId}' is unavailable or terminal. Recovery fails closed.`,
        );
      }
      state.sessionId = discovery.session.id;
      state.sessionPhase = "accepted";
      state.sessionAcceptedAt = new Date(now()).toISOString();
      state.updatedAt = state.sessionAcceptedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    }
    if (
      state.statement?.phase === "submitting" &&
      state.statement.statementId === undefined
    ) {
      const statement = await adapter.discoverStatementByMarker(
        options.approvedPlan.workspaceId,
        targetLakehouseId,
        state.sessionId,
        state.statement.statementAttemptName,
        state.statement.codeHash,
      );
      if (statement.outcome !== "single") {
        throw new Error(
          `Ambiguous LakehouseTables statement POST for '${item.logicalId}' cannot be recovered safely. Zero or multiple candidates fail closed.`,
        );
      }
      if (
        !["waiting", "running", "available"].includes(
          statement.state,
        )
      ) {
        throw new Error(
          `Recovered LakehouseTables statement for '${item.logicalId}' is failed, cancelled, or unavailable in state '${statement.state}'.`,
        );
      }
      state.statement.statementId = statement.statementId;
      state.statement.phase = "accepted";
      state.statement.acceptedAt = new Date(now()).toISOString();
      state.updatedAt = state.statement.acceptedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    }
    if (
      state.statement?.phase === "accepted" &&
      state.statement.statementId !== undefined
    ) {
      const operation = state.statement.operationHash
        ? operations.find(
            (candidate) =>
              candidate.operationHash ===
              state.statement?.operationHash,
          )
        : undefined;
      await adapter.resumeAcceptedStatement(
        options.approvedPlan.workspaceId,
        targetLakehouseId,
        state.sessionId,
        state.statement.statementId,
        operation,
      );
      state.statement.phase = "verified";
      state.statement.verifiedAt = new Date(now()).toISOString();
      if (
        operation &&
        !state.completedOperationHashes.includes(operation.operationHash)
      ) {
        state.completedOperationHashes.push(operation.operationHash);
      }
      if (
        operation &&
        state.statement.acceptedAt &&
        state.statement.verifiedAt
      ) {
        state.operationReceipts = state.operationReceipts.filter(
          (receipt) =>
            receipt.operationHash !== operation.operationHash,
        );
        state.operationReceipts.push({
          operationHash: operation.operationHash,
          tableLogicalId: operation.logicalId,
          statementAttemptName:
            state.statement.statementAttemptName,
          codeHash: state.statement.codeHash,
          statementId: state.statement.statementId,
          submittedAt: state.statement.submittedAt,
          acceptedAt: state.statement.acceptedAt,
          verifiedAt: state.statement.verifiedAt,
        });
      }
      state.updatedAt = state.statement.verifiedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    }
    state.sessionPhase = "cleanup-submitting";
    state.updatedAt = new Date(now()).toISOString();
    writeCheckpoint(options.checkpointFile, checkpoint);
    await adapter.deleteSessionById(
      options.approvedPlan.workspaceId,
      targetLakehouseId,
      state.sessionId,
    );
    state.sessionPhase = "cleanup-complete";
    state.cleanupCompletedAt = new Date(now()).toISOString();
    state.updatedAt = state.cleanupCompletedAt;
    writeCheckpoint(options.checkpointFile, checkpoint);
  }

function requireLakehouseTablesCheckpoint(
    checkpoint: ApplyCheckpoint,
    logicalId: string,
  ): NonNullable<ApplyCheckpoint["lakehouseTables"]>[string] {
    const state = checkpoint.lakehouseTables?.[logicalId];
    if (!state) {
      throw new Error(
        `LakehouseTables checkpoint state is missing for '${logicalId}'.`,
      );
    }
    return state;
}

async function reconcileOneLakeArtifactStaging(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: ReadonlyMap<string, PlannedItem>,
  now: () => number,
): Promise<void> {
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const item = approvedItems.get(logicalId);
      if (
        !item ||
        item.type !== "SparkJobDefinition" ||
        !item.sparkJobArtifacts
      ) {
        continue;
      }
      const hasArtifactState =
        checkpoint.oneLakeArtifacts?.[logicalId] !== undefined;
      const hasPendingItem =
        getPendingOperation(checkpoint, logicalId) !== undefined ||
        getPendingCreate(checkpoint, logicalId) !== undefined ||
        getPendingUpdate(checkpoint, logicalId) !== undefined;
      if (hasArtifactState || hasPendingItem) {
        if (hasPendingItem) {
          assertPendingSparkJobArtifactRecoveryProof(
            options,
            checkpoint,
            item,
          );
        }
        await applySparkJobArtifacts(
          options,
          checkpoint,
          item,
          now,
        );
      }
    }
  }
}

function assertPendingSparkJobArtifactRecoveryProof(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
): void {
  const staging = item.sparkJobArtifacts;
  const state = checkpoint.oneLakeArtifacts?.[item.logicalId];
  if (!staging || !state?.completedAt) {
    throw new Error(
      `Pending Spark Job write '${item.logicalId}' is missing completed OneLake artifact staging proof.`,
    );
  }
  for (const artifact of staging.artifacts) {
    if (
      state.artifacts[artifact.operationId]?.phase !== "verified"
    ) {
      throw new Error(
        `Pending Spark Job write '${item.logicalId}' has incomplete OneLake artifact staging proof.`,
      );
    }
  }
  requireSparkJobRuntimeDefinition(
    { ...options, checkpoint },
    item.logicalId,
  );
}

async function applySparkJobArtifacts(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
  now: () => number,
): Promise<void> {
  const staging = item.sparkJobArtifacts;
  if (!staging) {
    return;
  }
  const stager = options.oneLakeArtifactStager;
  if (!stager) {
    throw new Error(
      `OneLake artifact staging client is missing for '${item.logicalId}'.`,
    );
  }
  const sources =
    options.loadedManifest.sparkJobArtifactSources?.[item.logicalId] ?? [];
  const sourceByName = new Map(
    sources.map((source) => [source.fileName, source]),
  );
  const targetLakehouseId = requirePhysicalIdForLogicalDependency(
    options,
    staging.targetLakehouseLogicalId,
    {},
    item.logicalId,
  );
  const approvedTarget = options.approvedPlan.items.find(
    (candidate) =>
      candidate.logicalId ===
      staging.targetLakehouseLogicalId,
  );
  if (!approvedTarget || approvedTarget.type !== "Lakehouse") {
    throw new Error(
      `OneLake artifact target '${staging.targetLakehouseLogicalId}' is not an approved Lakehouse.`,
    );
  }
  if (
    staging.targetBinding === "physical"
      ? staging.targetLakehousePhysicalId !== targetLakehouseId ||
        approvedTarget.physicalId !== targetLakehouseId
      : approvedTarget.action !== "create" ||
        getCompletedItem(
          checkpoint,
          staging.targetLakehouseLogicalId,
        )?.physicalId !== targetLakehouseId
  ) {
    throw new Error(
      `OneLake artifact target binding changed after approval for '${item.logicalId}'.`,
    );
  }
  materializeSparkJobArtifactUris(
    staging,
    sources,
    requireOneLakeDfsEndpoint(options, item.logicalId),
    options.approvedPlan.workspaceId,
    targetLakehouseId,
    options.approvedPlan.deploymentId,
    options.approvedPlan.environment,
    item.logicalId,
  );

  checkpoint.oneLakeArtifacts ??= {};
  let state = checkpoint.oneLakeArtifacts[item.logicalId];
  if (!state) {
    const updatedAt = new Date(now()).toISOString();
    state = {
      logicalId: item.logicalId,
      targetLakehouseLogicalId:
        staging.targetLakehouseLogicalId,
      targetLakehouseId,
      stagingHash: staging.stagingHash,
      artifacts: {},
      updatedAt,
    };
    checkpoint.oneLakeArtifacts[item.logicalId] = state;
    writeCheckpoint(options.checkpointFile, checkpoint);
  }
  if (
    state.targetLakehouseLogicalId !==
      staging.targetLakehouseLogicalId ||
    state.targetLakehouseId !== targetLakehouseId ||
    state.stagingHash !== staging.stagingHash
  ) {
    throw new Error(
      `OneLake artifact checkpoint changed target or source proof for '${item.logicalId}'.`,
    );
  }

  for (const artifact of staging.artifacts) {
    if (artifact.action === "blocked") {
      throw new Error(
        `OneLake artifact '${artifact.fileName}' is blocked and cannot be applied.`,
      );
    }
    if (
      artifact.action === "create" &&
      !(options.allowOneLakeArtifactCreate ?? false)
    ) {
      throw new Error(
        `Plan requires staging OneLake artifact '${artifact.fileName}' for '${item.logicalId}', but allow-onelake-artifact-create is false.`,
      );
    }
    const source = sourceByName.get(artifact.fileName);
    if (!source) {
      throw new Error(
        `OneLake artifact source '${artifact.fileName}' is missing for '${item.logicalId}'.`,
      );
    }
    const descriptor = artifactDescriptor(
      options.approvedPlan.workspaceId,
      targetLakehouseId,
      artifact,
      source,
    );
    const checkpointArtifact = state.artifacts[artifact.operationId];
    if (checkpointArtifact?.phase === "verified") {
      await stager.verify(descriptor);
      continue;
    }
    if (
      checkpointArtifact?.phase === "upload-submitting" &&
      artifact.action !== "create"
    ) {
      throw new Error(
        `OneLake artifact checkpoint for '${artifact.fileName}' cannot upload under an approved no-op operation.`,
      );
    }

    const recordSubmitting = () => {
      const timestamp = new Date(now()).toISOString();
      state!.artifacts[artifact.operationId] = {
        operationId: artifact.operationId,
        operationHash: artifact.operationHash,
        fileName: artifact.fileName,
        oneLakePath: artifact.oneLakePath,
        contentHash: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
        phase: "upload-submitting",
        submittedAt:
          state!.artifacts[artifact.operationId]?.submittedAt ??
          timestamp,
        updatedAt: timestamp,
      };
      state!.updatedAt = timestamp;
      delete state!.completedAt;
      writeCheckpoint(options.checkpointFile, checkpoint);
    };
    const recordVerified = () => {
      const timestamp = new Date(now()).toISOString();
      const submittedAt =
        state!.artifacts[artifact.operationId]?.submittedAt;
      state!.artifacts[artifact.operationId] = {
        operationId: artifact.operationId,
        operationHash: artifact.operationHash,
        fileName: artifact.fileName,
        oneLakePath: artifact.oneLakePath,
        contentHash: artifact.contentHash,
        sizeBytes: artifact.sizeBytes,
        phase: "verified",
        ...(submittedAt ? { submittedAt } : {}),
        verifiedAt: timestamp,
        updatedAt: timestamp,
      };
      state!.updatedAt = timestamp;
      writeCheckpoint(options.checkpointFile, checkpoint);
    };

    if (artifact.action === "create") {
      await stager.uploadImmutable(descriptor, {
        onUploadSubmitting: recordSubmitting,
        onUploadVerified: recordVerified,
      });
    } else {
      await stager.verify(descriptor);
      recordVerified();
    }
  }

  const completedAt = new Date(now()).toISOString();
  state.completedAt = completedAt;
  state.updatedAt = completedAt;
  writeCheckpoint(options.checkpointFile, checkpoint);
}

function requireOneLakeDfsEndpoint(
  options: ApplyPlanOptions,
  logicalId: string,
): string {
  if (!options.oneLakeDfsEndpoint) {
    throw new Error(
      `OneLake DFS endpoint is missing for Spark Job Definition '${logicalId}'.`,
    );
  }
  return options.oneLakeDfsEndpoint;
}

function requireOneLakeBlobEndpoint(
  options: ApplyPlanOptions,
  logicalId: string,
): string {
  if (!options.oneLakeBlobEndpoint) {
    throw new Error(
      `OneLake Blob endpoint is missing for Spark Job Definition '${logicalId}'.`,
    );
  }
  return options.oneLakeBlobEndpoint;
}

function requirePhysicalIdForLogicalDependency(
  options: ApplyPlanOptions,
  targetLogicalId: string,
  knownPhysicalIds: Readonly<Record<string, string>>,
  ownerLogicalId: string,
): string {
  const known = knownPhysicalIds[targetLogicalId];
  if (known) {
    return known;
  }
  const completed = options.checkpoint
    ? getCompletedItem(options.checkpoint, targetLogicalId)
    : undefined;
  const approved = options.approvedPlan.items.find(
    (candidate) => candidate.logicalId === targetLogicalId,
  );
  const current = options.currentPlan.items.find(
    (candidate) => candidate.logicalId === targetLogicalId,
  );
  const physicalId =
    completed?.physicalId ?? approved?.physicalId ?? current?.physicalId;
  if (
    !approved ||
    approved.type !== "Lakehouse" ||
    (current && current.type !== "Lakehouse")
  ) {
    throw new Error(
      `Spark Job Definition '${ownerLogicalId}' has an invalid OneLake Lakehouse dependency '${targetLogicalId}'.`,
    );
  }
  if (!physicalId) {
    throw new Error(
      `Spark Job Definition '${ownerLogicalId}' cannot resolve Lakehouse '${targetLogicalId}' for OneLake artifact staging.`,
    );
  }
  return physicalId;
}

async function applyItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  startedAt: number,
  now: () => number,
  onMutationAccepted: (physicalId: string) => void,
  onOperationAccepted: (
    operation:
      | LakehouseOperationReference
      | EventhouseOperationReference
      | KqlDatabaseOperationReference
      | EnvironmentOperationReference
      | NotebookOperationReference
      | SparkJobOperationReference
      | PipelineOperationReference
      | SemanticModelOperationReference
      | ReportOperationReference
      | EventstreamOperationReference,
  ) => void,
  onCreateSubmitting: () => void,
  onCreateRejected: () => void,
  onUpdateSubmitting: (
    state?: DefinitionItemUpdateRecoveryState,
  ) => void,
  onUpdateRejected: () => void,
  onDeleteSubmitting: () => void,
): Promise<ApplyItemResult> {
  if (
    item.type !== "Lakehouse" &&
    item.type !== "Eventhouse" &&
    item.type !== "KQLDatabase" &&
    item.type !== "Warehouse" &&
    item.type !== "Environment" &&
    item.type !== "SparkCustomPool" &&
    item.type !== "Notebook" &&
    item.type !== "SparkJobDefinition" &&
    item.type !== "DataPipeline" &&
    item.type !== "CopyJob" &&
    item.type !== "SemanticModel" &&
    item.type !== "Report" &&
    item.type !== "FabricTag" &&
    item.type !== "Eventstream"
  ) {
    throw new Error(
      `Apply is not implemented for item '${item.logicalId}' of type ${item.type}.`,
    );
  }
  const desired = options.loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    throw new Error(`Desired definition is missing for '${item.logicalId}'.`);
  }

  if (item.action === "delete") {
    if (!(options.allowDelete ?? false)) {
      throw new Error(
        `Plan requires deleting '${item.logicalId}', but allow-delete is false.`,
      );
    }
    if (
      item.type === "Lakehouse" &&
      !(options.allowLakehouseDataLoss ?? false)
    ) {
      throw new Error(
        `Plan requires deleting Lakehouse '${item.logicalId}', but allow-lakehouse-data-loss is false.`,
      );
    }
    if (
      !item.physicalId ||
      !item.observedStateHash ||
      !isDeletableFabricItemType(item.type)
    ) {
      throw new Error(
        `Delete item '${item.logicalId}' is missing its exact approved deletion proof.`,
      );
    }
    const adapter = requireItemDeletionAdapter(
      options,
      item.logicalId,
    );
    const before = await adapter.verifyApprovedIdentity(
      options.approvedPlan.workspaceId,
      item.physicalId,
      item.type,
      desired,
      item.observedStateHash,
    );
    if (before === "unchanged") {
      await adapter.delete(
        options.approvedPlan.workspaceId,
        item.physicalId,
        onDeleteSubmitting,
      );
    }
    const after = await adapter.verifyApprovedIdentity(
      options.approvedPlan.workspaceId,
      item.physicalId,
      item.type,
      desired,
      item.observedStateHash,
    );
    if (after !== "absent") {
      throw new Error(
        `Delete item '${item.logicalId}' is still present after Fabric accepted the request.`,
      );
    }
    await assertDeletionIdentityIsAbsent(options, item, desired);
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "deleted",
      physicalId: item.physicalId,
      durationMs: now() - startedAt,
    };
  }

  if (item.desiredState === "absent") {
    if (item.action !== "no-op") {
      throw new Error(
        `Absent item '${item.logicalId}' cannot be applied while action is '${item.action}'.`,
      );
    }
    const live = await planDesiredItem(options, item, desired);
    if (
      live.action !== "no-op" ||
      ("physicalId" in live && live.physicalId !== undefined)
    ) {
      throw new Error(
        `Absent item '${item.logicalId}' is no longer absent.`,
      );
    }
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "verified",
      durationMs: now() - startedAt,
    };
  }

  if (item.action === "create") {
    if (!options.allowCreate) {
      throw new Error(
        `Plan requires creating '${item.logicalId}', but allow-create is false.`,
      );
    }
    if (
      item.type === "FabricTag" &&
      !(options.allowTagCreate ?? false)
    ) {
      throw new Error(
        `Plan requires creating Fabric tag '${item.logicalId}', but allow-tag-create is false.`,
      );
    }
    const created = await createDesiredItem(
      options,
      item,
      desired,
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "created",
      physicalId: created.id,
      durationMs: now() - startedAt,
    };
  }

  if (item.action === "update") {
    if (!options.allowUpdate) {
      throw new Error(
        `Plan requires updating '${item.logicalId}', but allow-update is false.`,
      );
    }
    if (!item.physicalId) {
      throw new Error(`Update item '${item.logicalId}' has no physical ID.`);
    }
    const updated = await updateDesiredItem(
      options,
      item,
      item.physicalId,
      desired,
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "updated",
      physicalId: updated.id,
      durationMs: now() - startedAt,
    };
  }

  if (item.action === "no-op") {
    if (!item.physicalId) {
      throw new Error(`No-op item '${item.logicalId}' has no physical ID.`);
    }
    const verified = await verifyDesiredItem(
      options,
      item,
      item.physicalId,
      desired,
    );
    return {
      logicalId: item.logicalId,
      type: item.type,
      action: item.action,
      status: "verified",
      physicalId: verified.id,
      durationMs: now() - startedAt,
    };
  }

  throw new Error(
    `Item '${item.logicalId}' cannot be applied while action is '${item.action}'.`,
  );
}

async function resumeCompletedItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  physicalId: string | undefined,
): Promise<void> {
  if (item.desiredState === "absent") {
    if (!isDeletableFabricItemType(item.type)) {
      throw new Error(
        `Checkpoint resume is not implemented for absent type ${item.type}.`,
      );
    }
    const desired =
      options.loadedManifest.itemDefinitions[item.logicalId];
    if (!desired) {
      throw new Error(
        `Desired definition is missing for '${item.logicalId}'.`,
      );
    }
    const adapter = requireItemDeletionAdapter(
      options,
      item.logicalId,
    );
    if (item.action === "delete") {
      if (!physicalId || !item.observedStateHash) {
        throw new Error(
          `Completed deletion '${item.logicalId}' is missing its approved proof.`,
        );
      }
      const state = await adapter.verifyApprovedIdentity(
        options.approvedPlan.workspaceId,
        physicalId,
        item.type,
        desired,
        item.observedStateHash,
      );
      if (state !== "absent") {
        throw new Error(
          `Checkpointed deletion '${item.logicalId}' is no longer absent.`,
        );
      }
      await assertDeletionIdentityIsAbsent(options, item, desired);
      return;
    }
    const live = await adapter.plan(
      options.approvedPlan.workspaceId,
      item.type,
      desired,
    );
    if (item.action !== "no-op" || live.action !== "no-op") {
      throw new Error(
        `Checkpointed absent item '${item.logicalId}' is no longer absent.`,
      );
    }
    return;
  }
  if (!physicalId) {
    throw new Error(
      `Checkpointed item '${item.logicalId}' has no physical ID.`,
    );
  }
  if (item.type === "LakehouseTables") {
    const adapter = options.lakehouseTablesAdapter;
    const definition =
      options.loadedManifest.lakehouseTablesDefinitions?.[
        item.logicalId
      ];
    const tablePlan = item.lakehouseTables;
    if (!adapter || !definition || !tablePlan) {
      throw new Error(
        `LakehouseTables checkpoint resume runtime is missing for '${item.logicalId}'.`,
      );
    }
    const execution = {
      sourceHash: definition.sourceHash,
      attemptId: `ddl-verify-${sha256(
        stableJson({
          planHash: options.approvedPlan.planHash,
          logicalId: item.logicalId,
        }),
      ).slice(0, 32)}`,
      deploymentId: options.approvedPlan.deploymentId,
      bundleLogicalId: item.logicalId,
      targetLakehouseLogicalId:
        tablePlan.targetLakehouseLogicalId,
    };
    const verification = await adapter.verify(
      options.approvedPlan.workspaceId,
      physicalId,
      definition,
      execution,
    );
    if (!verification.matches) {
      throw new Error(
        `Checkpointed LakehouseTables item '${item.logicalId}' no longer matches the approved definition.`,
      );
    }
    return;
  }
  if (
    item.type !== "Lakehouse" &&
    item.type !== "Eventhouse" &&
    item.type !== "KQLDatabase" &&
    item.type !== "Warehouse" &&
    item.type !== "Environment" &&
    item.type !== "SparkCustomPool" &&
    item.type !== "Notebook" &&
    item.type !== "SparkJobDefinition" &&
    item.type !== "DataPipeline" &&
    item.type !== "CopyJob" &&
    item.type !== "SemanticModel" &&
    item.type !== "Report" &&
    item.type !== "FabricTag" &&
    item.type !== "Eventstream"
  ) {
    throw new Error(
      `Checkpoint resume is not implemented for type ${item.type}.`,
    );
  }
  const desired = options.loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    throw new Error(`Desired definition is missing for '${item.logicalId}'.`);
  }
  if (item.type === "SparkJobDefinition" && item.sparkJobArtifacts) {
    if (!options.checkpoint) {
      throw new Error(
        `Apply checkpoint is missing while verifying Spark Job artifacts for '${item.logicalId}'.`,
      );
    }
    await applySparkJobArtifacts(
      options,
      options.checkpoint,
      item,
      options.now ?? Date.now,
    );
  }
  await verifyDesiredItem(
    options,
    item,
    physicalId,
    desired,
  );
}

async function planDesiredItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  desired: ItemDefinition,
) {
  if (item.desiredState === "absent") {
    if (!isDeletableFabricItemType(item.type)) {
      throw new Error(
        `Deletion planning is not implemented for item '${item.logicalId}' of type ${item.type}.`,
      );
    }
    return requireItemDeletionAdapter(
      options,
      item.logicalId,
    ).plan(
      options.approvedPlan.workspaceId,
      item.type,
      desired,
    );
  }
  if (item.type === "FabricTag") {
    return requireTagAdapter(options, item.logicalId).plan(
      desiredFabricTag(desired),
    );
  }
  if (item.type === "Lakehouse") {
    return options.lakehouseAdapter.plan(
      options.approvedPlan.workspaceId,
      desired,
    );
  }
  if (item.type === "Eventhouse") {
    return requireEventhouseAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
    );
  }
  if (item.type === "KQLDatabase") {
    const materialized = requireKqlDatabaseRuntimeCreation(
      options,
      item.logicalId,
    );
    return {
      ...(await requireKqlDatabaseAdapter(
        options,
        item.logicalId,
      ).plan(
        options.approvedPlan.workspaceId,
        desired,
        materialized,
      )),
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
    };
  }
  if (item.type === "Warehouse") {
    return requireWarehouseAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
    );
  }
  if (item.type === "Environment") {
    return requireEnvironmentAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireEnvironmentDefinition(options, item.logicalId),
    );
  }
  if (item.type === "SparkCustomPool") {
    return requireSparkCustomPoolAdapter(
      options,
      item.logicalId,
    ).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireSparkCustomPoolDefinition(options, item.logicalId),
    );
  }
  if (item.type === "Notebook") {
    return requireNotebookAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireNotebookDefinition(options, item.logicalId),
    );
  }
  if (item.type === "SparkJobDefinition") {
    const materialized = requireSparkJobRuntimeDefinition(
      options,
      item.logicalId,
    );
    return {
      ...(await requireSparkJobAdapter(options, item.logicalId).plan(
        options.approvedPlan.workspaceId,
        desired,
        materialized.definition,
      )),
      ...(materialized.materializedDefinitionHash
        ? {
            materializedDefinitionHash:
              materialized.materializedDefinitionHash,
            resolvedBindingsHash:
              materialized.resolvedBindingsHash,
          }
        : {}),
    };
  }
  if (item.type === "DataPipeline") {
    return requirePipelineAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
      requirePipelineDefinition(options, item.logicalId),
    );
  }
  if (item.type === "CopyJob") {
    return requireCopyJobAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireCopyJobDefinitionFromOptions(options, item.logicalId),
    );
  }
  if (item.type === "SemanticModel") {
    return requireSemanticModelAdapter(
      options,
      item.logicalId,
    ).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireSemanticModelDefinition(
        options,
        item.logicalId,
      ),
    );
  }
  if (item.type === "Report") {
    const materialized = requireReportRuntimeDefinition(
      options,
      item.logicalId,
    );
    return {
      ...(await requireReportAdapter(
        options,
        item.logicalId,
      ).plan(
        options.approvedPlan.workspaceId,
        desired,
        materialized.definition,
      )),
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
    };
  }
  if (item.type === "Eventstream") {
    return requireEventstreamAdapter(options, item.logicalId).plan(
      options.approvedPlan.workspaceId,
      desired,
      requireEventstreamDefinition(options, item.logicalId),
    );
  }
  throw new Error(
    `Fabric planning is not implemented for item '${item.logicalId}' of type ${item.type}.`,
  );
}

async function assertDeletionIdentityIsAbsent(
  options: ApplyPlanOptions,
  item: PlannedItem,
  desired: ItemDefinition,
): Promise<void> {
  if (!isDeletableFabricItemType(item.type)) {
    throw new Error(
      `Deletion verification is not implemented for item '${item.logicalId}' of type ${item.type}.`,
    );
  }
  const live = await requireItemDeletionAdapter(
    options,
    item.logicalId,
  ).plan(
    options.approvedPlan.workspaceId,
    item.type,
    desired,
  );
  if (live.action !== "no-op" || live.physicalId) {
    throw new Error(
      `A different ${item.type} now occupies the approved deletion identity for '${item.logicalId}'. Generate a new plan before deleting it.`,
    );
  }
}

async function createDesiredItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  desired: ItemDefinition,
  onMutationAccepted: (physicalId: string) => void,
  onOperationAccepted: (
    operation:
      | LakehouseOperationReference
      | EventhouseOperationReference
      | KqlDatabaseOperationReference
      | WarehouseOperationReference
      | EnvironmentOperationReference
      | NotebookOperationReference
      | SparkJobOperationReference
      | PipelineOperationReference
      | SemanticModelOperationReference
      | ReportOperationReference
      | EventstreamOperationReference,
  ) => void,
  onCreateSubmitting: () => void,
  onCreateRejected: () => void,
) {
  if (item.type === "FabricTag") {
    onCreateSubmitting();
    const created = await requireTagAdapter(
      options,
      item.logicalId,
    ).create(desiredFabricTag(desired));
    onMutationAccepted(created.id);
    return created;
  }
  if (item.type === "Lakehouse") {
    return options.lakehouseAdapter.create(
      options.approvedPlan.workspaceId,
      desired,
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Eventhouse") {
    return requireEventhouseAdapter(
      options,
      item.logicalId,
    ).create(
      options.approvedPlan.workspaceId,
      desired,
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "KQLDatabase") {
    return requireKqlDatabaseAdapter(
      options,
      item.logicalId,
    ).create(
      options.approvedPlan.workspaceId,
      desired,
      requireKqlDatabaseRuntimeCreation(
        options,
        item.logicalId,
      ),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Warehouse") {
    return requireWarehouseAdapter(
      options,
      item.logicalId,
    ).create(
      options.approvedPlan.workspaceId,
      desired,
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Environment") {
    return requireEnvironmentAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireEnvironmentDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "SparkCustomPool") {
    return requireSparkCustomPoolAdapter(
      options,
      item.logicalId,
    ).create(
      options.approvedPlan.workspaceId,
      desired,
      requireSparkCustomPoolDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Notebook") {
    return requireNotebookAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireNotebookDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "SparkJobDefinition") {
    return requireSparkJobAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireSparkJobDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "DataPipeline") {
    return requirePipelineAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requirePipelineDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "CopyJob") {
    return requireCopyJobAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireCopyJobDefinitionFromOptions(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted as
        | ((operation: CopyJobOperationReference) => void)
        | undefined,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "SemanticModel") {
    return requireSemanticModelAdapter(
      options,
      item.logicalId,
    ).create(
      options.approvedPlan.workspaceId,
      desired,
      requireSemanticModelDefinition(
        options,
        item.logicalId,
      ),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Report") {
    return requireReportAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireReportDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  if (item.type === "Eventstream") {
    return requireEventstreamAdapter(options, item.logicalId).create(
      options.approvedPlan.workspaceId,
      desired,
      requireEventstreamDefinition(options, item.logicalId),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
      onCreateRejected,
    );
  }
  throw new Error(
    `Create is not implemented for item '${item.logicalId}' of type ${item.type}.`,
  );
}

async function resumeCreateDesiredItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  desired: ItemDefinition,
  operation:
    | LakehouseOperationReference
    | EventhouseOperationReference
    | KqlDatabaseOperationReference
    | WarehouseOperationReference
    | EnvironmentOperationReference
    | NotebookOperationReference
    | SparkJobOperationReference
    | PipelineOperationReference
    | CopyJobOperationReference
    | SemanticModelOperationReference
    | ReportOperationReference
    | EventstreamOperationReference,
  onMutationAccepted: (physicalId: string) => void,
) {
  if (item.type === "Lakehouse") {
    return options.lakehouseAdapter.resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Eventhouse") {
    return requireEventhouseAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "KQLDatabase") {
    return requireKqlDatabaseAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireKqlDatabaseRuntimeCreation(
        options,
        item.logicalId,
      ),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Warehouse") {
    return requireWarehouseAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Environment") {
    return requireEnvironmentAdapter(options, item.logicalId).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireEnvironmentDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Notebook") {
    return requireNotebookAdapter(options, item.logicalId).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireNotebookDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "SparkJobDefinition") {
    return requireSparkJobAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireSparkJobDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "DataPipeline") {
    return requirePipelineAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requirePipelineDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "CopyJob") {
    return requireCopyJobAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireCopyJobDefinitionFromOptions(options, item.logicalId),
      operation as CopyJobOperationReference,
      onMutationAccepted,
    );
  }
  if (item.type === "SemanticModel") {
    return requireSemanticModelAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireSemanticModelDefinition(
        options,
        item.logicalId,
      ),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Report") {
    return requireReportAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireReportDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  if (item.type === "Eventstream") {
    return requireEventstreamAdapter(
      options,
      item.logicalId,
    ).resumeCreate(
      options.approvedPlan.workspaceId,
      desired,
      requireEventstreamDefinition(options, item.logicalId),
      operation,
      onMutationAccepted,
    );
  }
  throw new Error(
    `Create resume is not implemented for item '${item.logicalId}' of type ${item.type}.`,
  );
}

async function updateDesiredItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  physicalId: string,
  desired: ItemDefinition,
  onMutationAccepted?: (physicalId: string) => void,
  onUpdateSubmitting?: (
    state?: DefinitionItemUpdateRecoveryState,
  ) => void,
  onUpdateRejected?: () => void,
) {
  if (item.type === "Lakehouse") {
    return options.lakehouseAdapter.update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Eventhouse") {
    return requireEventhouseAdapter(
      options,
      item.logicalId,
    ).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "KQLDatabase") {
    return requireKqlDatabaseAdapter(
      options,
      item.logicalId,
    ).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireKqlDatabaseRuntimeCreation(
        options,
        item.logicalId,
      ),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Warehouse") {
    return requireWarehouseAdapter(
      options,
      item.logicalId,
    ).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Report") {
    return requireReportAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireReportDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "SparkCustomPool") {
    return requireSparkCustomPoolAdapter(
      options,
      item.logicalId,
    ).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSparkCustomPoolDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Environment") {
    return requireEnvironmentAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireEnvironmentDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Notebook") {
    return requireNotebookAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireNotebookDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "SparkJobDefinition") {
    return requireSparkJobAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSparkJobDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "DataPipeline") {
    return requirePipelineAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requirePipelineDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "CopyJob") {
    return requireCopyJobAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireCopyJobDefinitionFromOptions(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "SemanticModel") {
    return requireSemanticModelAdapter(
      options,
      item.logicalId,
    ).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSemanticModelDefinition(
        options,
        item.logicalId,
      ),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  if (item.type === "Eventstream") {
    return requireEventstreamAdapter(options, item.logicalId).update(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireEventstreamDefinition(options, item.logicalId),
      onMutationAccepted,
      onUpdateSubmitting,
      onUpdateRejected,
    );
  }
  throw new Error(
    `Update is not implemented for item '${item.logicalId}' of type ${item.type}.`,
  );
}

async function verifyDesiredItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  physicalId: string,
  desired: ItemDefinition,
) {
  if (item.type === "FabricTag") {
    return requireTagAdapter(options, item.logicalId).verify(
      desiredFabricTag(desired),
      physicalId,
    );
  }
  if (item.type === "Lakehouse") {
    return options.lakehouseAdapter.verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
    );
  }
  if (item.type === "Eventhouse") {
    return requireEventhouseAdapter(
      options,
      item.logicalId,
    ).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
    );
  }
  if (item.type === "KQLDatabase") {
    return requireKqlDatabaseAdapter(
      options,
      item.logicalId,
    ).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireKqlDatabaseRuntimeCreation(
        options,
        item.logicalId,
      ),
    );
  }
  if (item.type === "Warehouse") {
    return requireWarehouseAdapter(
      options,
      item.logicalId,
    ).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
    );
  }
  if (item.type === "Environment") {
    return requireEnvironmentAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireEnvironmentDefinition(options, item.logicalId),
    );
  }
  if (item.type === "SparkCustomPool") {
    return requireSparkCustomPoolAdapter(
      options,
      item.logicalId,
    ).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSparkCustomPoolDefinition(options, item.logicalId),
    );
  }
  if (item.type === "Notebook") {
    return requireNotebookAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireNotebookDefinition(options, item.logicalId),
    );
  }
  if (item.type === "SparkJobDefinition") {
    return requireSparkJobAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSparkJobDefinition(options, item.logicalId),
    );
  }
  if (item.type === "DataPipeline") {
    return requirePipelineAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requirePipelineDefinition(options, item.logicalId),
    );
  }
  if (item.type === "CopyJob") {
    return requireCopyJobAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireCopyJobDefinitionFromOptions(options, item.logicalId),
    );
  }
  if (item.type === "SemanticModel") {
    return requireSemanticModelAdapter(
      options,
      item.logicalId,
    ).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireSemanticModelDefinition(
        options,
        item.logicalId,
      ),
    );
  }
  if (item.type === "Report") {
    return requireReportAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireReportDefinition(options, item.logicalId),
    );
  }
  if (item.type === "Eventstream") {
    return requireEventstreamAdapter(options, item.logicalId).verify(
      options.approvedPlan.workspaceId,
      physicalId,
      desired,
      requireEventstreamDefinition(options, item.logicalId),
    );
  }
  throw new Error(
    `Verification is not implemented for item '${item.logicalId}' of type ${item.type}.`,
  );
}

function requireTagAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["tagAdapter"]> {
  if (!options.tagAdapter) {
    throw new Error(
      `Fabric tag adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.tagAdapter;
}

function desiredFabricTag(desired: ItemDefinition) {
  return {
    displayName: desired.displayName,
    scope: desired.scope ?? ({ type: "Tenant" } as const),
  };
}

function requireItemDeletionAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["itemDeletionAdapter"]> {
  if (!options.itemDeletionAdapter) {
    throw new Error(
      `Deletion adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.itemDeletionAdapter;
}

function requireEnvironmentAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["environmentAdapter"]> {
  if (!options.environmentAdapter) {
    throw new Error(
      `Environment adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.environmentAdapter;
}

function requireEventhouseAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["eventhouseAdapter"]> {
  if (!options.eventhouseAdapter) {
    throw new Error(
      `Eventhouse adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.eventhouseAdapter;
}

function requireKqlDatabaseAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["kqlDatabaseAdapter"]> {
  if (!options.kqlDatabaseAdapter) {
    throw new Error(
      `KQL Database adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.kqlDatabaseAdapter;
}

function requireKqlDatabaseRuntimeCreation(
  options: ApplyPlanOptions,
  logicalId: string,
): KqlDatabaseLogicalReferenceMaterialization {
  const item = options.loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === logicalId,
  );
  const desired =
    options.loadedManifest.itemDefinitions[logicalId];
  if (!item || !desired) {
    throw new Error(
      `KQL Database declarations are missing for '${logicalId}'.`,
    );
  }
  const bindings = validateLogicalReferenceDeclarations({
    item,
    definition: desired,
    itemGraph: options.loadedManifest.manifest.items,
  });
  const binding = Object.values(bindings)[0];
  if (!binding || binding.targetType !== "Eventhouse") {
    throw new Error(
      `KQL Database '${logicalId}' has no valid Eventhouse binding.`,
    );
  }
  const completed = options.checkpoint
    ? getCompletedItem(options.checkpoint, binding.logicalId)
    : undefined;
  const approvedDependency = options.approvedPlan.items.find(
    (candidate) => candidate.logicalId === binding.logicalId,
  );
  const currentDependency = options.currentPlan.items.find(
    (candidate) => candidate.logicalId === binding.logicalId,
  );
  if (
    !approvedDependency ||
    approvedDependency.type !== "Eventhouse" ||
    (currentDependency &&
      currentDependency.type !== "Eventhouse")
  ) {
    throw new Error(
      `KQL Database '${logicalId}' has an invalid Eventhouse dependency '${binding.logicalId}'.`,
    );
  }
  const physicalId =
    completed?.physicalId ??
    approvedDependency.physicalId ??
    currentDependency?.physicalId;
  if (!physicalId) {
    throw new Error(
      `KQL Database '${logicalId}' cannot materialize Eventhouse '${binding.logicalId}' because its physical ID is not available.`,
    );
  }
  const materialized =
    materializeKqlDatabaseCreationWithProof(
      desired,
      bindings,
      { [binding.logicalId]: physicalId },
    );
  assertLogicalReferenceCheckpointProof(
    options,
    logicalId,
    materialized,
  );
  return materialized;
}

function requireWarehouseAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["warehouseAdapter"]> {
  if (!options.warehouseAdapter) {
    throw new Error(
      `Warehouse adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.warehouseAdapter;
}

function requireEnvironmentDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.environmentDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `Environment definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireNotebookAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["notebookAdapter"]> {
  if (!options.notebookAdapter) {
    throw new Error(
      `Notebook adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.notebookAdapter;
}

function requireNotebookDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.notebookDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `Notebook definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireSparkJobAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["sparkJobAdapter"]> {
  if (!options.sparkJobAdapter) {
    throw new Error(
      `Spark Job Definition adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.sparkJobAdapter;
}

interface RuntimeSparkJobDefinition {
  definition: FabricDefinition;
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
}

function requireSparkJobRuntimeDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
): RuntimeSparkJobDefinition {
  const sourceDefinition =
    options.loadedManifest.sparkJobDefinitions[logicalId];
  if (!sourceDefinition) {
    throw new Error(
      `Spark Job Definition snapshot is missing for '${logicalId}'.`,
    );
  }
  const item = options.loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === logicalId,
  );
  const desired =
    options.loadedManifest.itemDefinitions[logicalId];
  if (!item || !desired) {
    throw new Error(
      `Spark Job Definition declarations are missing for '${logicalId}'.`,
    );
  }
  const bindings = validateLogicalReferenceDeclarations({
    item,
    definition: desired,
    itemGraph: options.loadedManifest.manifest.items,
  });
  const artifactSources =
    options.loadedManifest.sparkJobArtifactSources?.[logicalId] ?? [];
  const staging = options.approvedPlan.items.find(
    (candidate) => candidate.logicalId === logicalId,
  )?.sparkJobArtifacts;
  if (
    (artifactSources.length === 0) !== (staging === undefined)
  ) {
    throw new Error(
      `Spark Job artifact staging source does not match the approved plan for '${logicalId}'.`,
    );
  }
  if (
    staging &&
    bindings[DEFAULT_LAKEHOUSE_BINDING_TARGET]?.logicalId !==
      staging.targetLakehouseLogicalId
  ) {
    throw new Error(
      `Spark Job artifact target changed after approval for '${logicalId}'.`,
    );
  }
  if (Object.keys(bindings).length === 0 && !staging) {
    assertLogicalReferenceCheckpointProof(
      options,
      logicalId,
      undefined,
    );
    return { definition: sourceDefinition };
  }

  const physicalIds: Record<string, string> = {};
  for (const binding of Object.values(bindings)) {
    if (!binding) {
      continue;
    }
    const completed = options.checkpoint
      ? getCompletedItem(options.checkpoint, binding.logicalId)
      : undefined;
    const approvedDependency =
      options.approvedPlan.items.find(
        (candidate) =>
          candidate.logicalId === binding.logicalId,
      );
    const currentDependency = options.currentPlan.items.find(
      (candidate) => candidate.logicalId === binding.logicalId,
    );
    const physicalId =
      completed?.physicalId ??
      approvedDependency?.physicalId ??
      currentDependency?.physicalId;
    if (!physicalId) {
      throw new Error(
        `Spark Job Definition '${logicalId}' cannot materialize logical dependency '${binding.logicalId}' because its physical ID is not available.`,
      );
    }
    physicalIds[binding.logicalId] = physicalId;
  }

  const artifactMaterializations = staging
    ? materializeSparkJobArtifactUris(
        staging,
        artifactSources,
        requireOneLakeDfsEndpoint(options, logicalId),
        options.approvedPlan.workspaceId,
        requirePhysicalIdForLogicalDependency(
          options,
          staging.targetLakehouseLogicalId,
          physicalIds,
          logicalId,
        ),
        options.approvedPlan.deploymentId,
        options.approvedPlan.environment,
        logicalId,
      )
    : [];
  const materialized = materializeSparkJobDefinitionWithProof(
    sourceDefinition,
    bindings,
    physicalIds,
    artifactMaterializations,
  );
  assertLogicalReferenceCheckpointProof(
    options,
    logicalId,
    materialized,
  );
  return materialized;
}

function requireSparkJobDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
): FabricDefinition {
  return requireSparkJobRuntimeDefinition(
    options,
    logicalId,
  ).definition;
}

function logicalReferenceCheckpointProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
): Pick<
  SparkJobLogicalReferenceMaterialization &
    ReportLogicalReferenceMaterialization &
    KqlDatabaseLogicalReferenceMaterialization,
  "materializedDefinitionHash" | "resolvedBindingsHash"
> | Record<string, never> {
  if (
    item.type !== "SparkJobDefinition" &&
    item.type !== "Report" &&
    item.type !== "KQLDatabase"
  ) {
    return {};
  }
  const materialized =
    item.type === "Report"
      ? requireReportRuntimeDefinition(options, item.logicalId)
      : item.type === "KQLDatabase"
        ? requireKqlDatabaseRuntimeCreation(
            options,
            item.logicalId,
          )
      : requireSparkJobRuntimeDefinition(
          options,
          item.logicalId,
        );
  return materialized.materializedDefinitionHash &&
    materialized.resolvedBindingsHash
    ? {
        materializedDefinitionHash:
          materialized.materializedDefinitionHash,
        resolvedBindingsHash: materialized.resolvedBindingsHash,
      }
    : {};
}

function assertLogicalReferenceCheckpointProof(
  options: ApplyPlanOptions,
  logicalId: string,
  materialized:
    | SparkJobLogicalReferenceMaterialization
    | ReportLogicalReferenceMaterialization
    | KqlDatabaseLogicalReferenceMaterialization
    | undefined,
): void {
  const checkpoint = options.checkpoint;
  if (!checkpoint) {
    return;
  }
  const pending =
    getPendingCreate(checkpoint, logicalId) ??
    getPendingOperation(checkpoint, logicalId) ??
    getPendingUpdate(checkpoint, logicalId);
  if (!pending) {
    return;
  }
  const hasPendingProof =
    pending.materializedDefinitionHash !== undefined ||
    pending.resolvedBindingsHash !== undefined;
  if (!materialized) {
    if (hasPendingProof) {
      throw new Error(
        `Pending write for '${logicalId}' contains unexpected logical-reference materialization proof.`,
      );
    }
    return;
  }
  if (
    pending.materializedDefinitionHash !==
      materialized.materializedDefinitionHash ||
    pending.resolvedBindingsHash !==
      materialized.resolvedBindingsHash
  ) {
    throw new Error(
      `Pending write for '${logicalId}' was materialized with different dependency IDs and cannot be resumed.`,
    );
  }
}

function requirePipelineAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["pipelineAdapter"]> {
  if (!options.pipelineAdapter) {
    throw new Error(
      `Data Pipeline adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.pipelineAdapter;
}

function requirePipelineDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.pipelineDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `Data Pipeline definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireCopyJobAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["copyJobAdapter"]> {
  if (!options.copyJobAdapter) {
    throw new Error(
      `Copy Job adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.copyJobAdapter;
}

function requireCopyJobDefinitionFromOptions(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.copyJobDefinitions?.[logicalId];
  if (!definition) {
    throw new Error(
      `Copy Job definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireSemanticModelAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["semanticModelAdapter"]> {
  if (!options.semanticModelAdapter) {
    throw new Error(
      `Semantic Model adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.semanticModelAdapter;
}

function requireSemanticModelDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.semanticModelDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `Semantic Model definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireReportAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["reportAdapter"]> {
  if (!options.reportAdapter) {
    throw new Error(
      `Report adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.reportAdapter;
}

function requireEventstreamAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["eventstreamAdapter"]> {
  if (!options.eventstreamAdapter) {
    throw new Error(
      `Eventstream adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.eventstreamAdapter;
}

function requireEventstreamDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.eventstreamDefinitions?.[logicalId];
  if (!definition) {
    throw new Error(
      `Eventstream definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function requireReportRuntimeDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
): ReportLogicalReferenceMaterialization {
  const sourceDefinition =
    options.loadedManifest.reportDefinitions?.[logicalId];
  const item = options.loadedManifest.manifest.items.find(
    (candidate) => candidate.logicalId === logicalId,
  );
  const desired =
    options.loadedManifest.itemDefinitions[logicalId];
  if (!sourceDefinition || !item || !desired) {
    throw new Error(
      `Report definition or declarations are missing for '${logicalId}'.`,
    );
  }
  const bindings = validateLogicalReferenceDeclarations({
    item,
    definition: desired,
    itemGraph: options.loadedManifest.manifest.items,
  });
  const binding = Object.values(bindings)[0];
  if (!binding || binding.targetType !== "SemanticModel") {
    throw new Error(
      `Report '${logicalId}' has no valid Semantic Model binding.`,
    );
  }
  const completed = options.checkpoint
    ? getCompletedItem(options.checkpoint, binding.logicalId)
    : undefined;
  const approvedDependency = options.approvedPlan.items.find(
    (candidate) => candidate.logicalId === binding.logicalId,
  );
  const currentDependency = options.currentPlan.items.find(
    (candidate) => candidate.logicalId === binding.logicalId,
  );
  if (
    !approvedDependency ||
    approvedDependency.type !== "SemanticModel" ||
    (currentDependency &&
      currentDependency.type !== "SemanticModel")
  ) {
    throw new Error(
      `Report '${logicalId}' has an invalid Semantic Model dependency '${binding.logicalId}'.`,
    );
  }
  const physicalId =
    completed?.physicalId ??
    approvedDependency.physicalId ??
    currentDependency?.physicalId;
  if (!physicalId) {
    throw new Error(
      `Report '${logicalId}' cannot materialize Semantic Model '${binding.logicalId}' because its physical ID is not available.`,
    );
  }
  const materialized = materializeReportDefinitionWithProof(
    sourceDefinition,
    bindings,
    { [binding.logicalId]: physicalId },
  );
  assertLogicalReferenceCheckpointProof(
    options,
    logicalId,
    materialized,
  );
  return materialized;
}

function requireReportDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
): FabricDefinition {
  return requireReportRuntimeDefinition(
    options,
    logicalId,
  ).definition;
}

function requireSparkCustomPoolAdapter(
  options: ApplyPlanOptions,
  logicalId: string,
): NonNullable<ApplyPlanOptions["sparkCustomPoolAdapter"]> {
  if (!options.sparkCustomPoolAdapter) {
    throw new Error(
      `Spark custom pool adapter was not initialized for item '${logicalId}'.`,
    );
  }
  return options.sparkCustomPoolAdapter;
}

function requireSparkCustomPoolDefinition(
  options: ApplyPlanOptions,
  logicalId: string,
) {
  const definition =
    options.loadedManifest.sparkCustomPoolDefinitions[logicalId];
  if (!definition) {
    throw new Error(
      `Spark custom pool definition snapshot is missing for '${logicalId}'.`,
    );
  }
  return definition;
}

function hasEnvironmentRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDeploymentMarker?: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
    publishState?: string;
    targetVersion?: string;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "Environment") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireEnvironmentDefinition(
    options,
    item.logicalId,
  );
  const expectedMarker = getFabricDeploymentMarker(desiredDefinition);
  const expectedDefinitionHash = hashFabricDefinition(
    desiredDefinition,
    includesPlatformPart(desiredDefinition),
  );
  const desiredStagingMatches =
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash &&
    live.stagedDeploymentMarker === expectedMarker;
  if (desiredStagingMatches) {
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash &&
    live.stagedDeploymentMarker === intent.stagedDeploymentMarker &&
    live.publishState === intent.publishState &&
    live.targetVersion === intent.targetVersion
  );
}

function hasNotebookRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "Notebook") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireNotebookDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash = hashNotebookDefinition(
    desiredDefinition,
    notebookIncludesPlatformPart(desiredDefinition),
  );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasSparkJobRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "SparkJobDefinition") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireSparkJobDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash = hashSparkJobDefinition(
    desiredDefinition,
    sparkJobIncludesPlatformPart(desiredDefinition),
  );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasPipelineRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "DataPipeline") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requirePipelineDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash = hashPipelineDefinition(
    desiredDefinition,
    pipelineIncludesPlatformPart(desiredDefinition),
  );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasCopyJobRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "CopyJob") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireCopyJobDefinitionFromOptions(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash = hashCopyJobDefinition(
    desiredDefinition,
    copyJobIncludesPlatformPart(desiredDefinition),
  );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    return true;
  }

  // No further recovery path: re-run update or escalate.
  // NOTE: branch 3 (checking intent.phase === "metadata-submitting") was
  // removed — CopyJob update() is PATCH-only and never emits a phase-tagged
  // checkpoint, so that branch was unreachable.
  return false;
}

function hasSemanticModelRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
    currentAuxiliaryHash?: string;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "SemanticModel") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireSemanticModelDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash =
    intent?.phase === "definition-staged" &&
    intent.stagedDefinitionHash
      ? intent.stagedDefinitionHash
      : hashSemanticModelDefinition(
          desiredDefinition,
          semanticModelIncludesPlatformPart(desiredDefinition),
          semanticModelIncludesDiagramLayoutPart(desiredDefinition),
          semanticModelIncludesCopilotParts(desiredDefinition),
        );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    // When an effective full replacement was staged, additionally verify that
    // the preserved auxiliary parts were not silently lost. An ambiguous
    // accepted replacement with missing preserved parts must be re-applied.
    if (
      intent?.preservedAuxiliaryHash !== undefined &&
      live.currentAuxiliaryHash !== intent.preservedAuxiliaryHash
    ) {
      return false;
    }
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated" &&
      intent.phase !== "definition-submitting")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasReportRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
    currentAuxiliaryHash?: string;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "Report") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireReportDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash =
    intent?.phase === "definition-staged" &&
    intent.stagedDefinitionHash
      ? intent.stagedDefinitionHash
      : hashReportDefinition(
          desiredDefinition,
          reportIncludesPlatformPart(desiredDefinition),
          reportIncludesDiagramLayoutPart(desiredDefinition),
        );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    if (
      intent?.preservedAuxiliaryHash !== undefined &&
      live.currentAuxiliaryHash !== intent.preservedAuxiliaryHash
    ) {
      return false;
    }
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated" &&
      intent.phase !== "definition-submitting")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasEventstreamRecoveryProof(
  options: ApplyPlanOptions,
  item: PlannedItem,
  live: {
    action: PlannedAction;
    observedStateHash: string;
    stagedDefinitionHash?: string;
    managedMetadataMatches?: boolean;
  },
  intent?: ApplyCheckpoint["pendingUpdates"][string],
): boolean {
  if (item.type !== "Eventstream") {
    return false;
  }
  if (live.observedStateHash === item.observedStateHash) {
    return true;
  }
  const desiredDefinition = requireEventstreamDefinition(
    options,
    item.logicalId,
  );
  const expectedDefinitionHash = hashEventstreamDefinition(
    desiredDefinition,
    eventstreamIncludesPlatformPart(desiredDefinition),
    eventstreamIncludesPropertiesPart(desiredDefinition),
  );
  if (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === expectedDefinitionHash
  ) {
    return true;
  }
  if (
    !intent ||
    (intent.phase !== "metadata-submitting" &&
      intent.phase !== "metadata-updated")
  ) {
    return false;
  }
  return (
    live.managedMetadataMatches === true &&
    live.stagedDefinitionHash === intent.stagedDefinitionHash
  );
}

function hasSparkCustomPoolRecoveryProof(
  item: PlannedItem,
  live: {
    observedStateHash: string;
  },
): boolean {
  return (
    item.type === "SparkCustomPool" &&
    live.observedStateHash === item.observedStateHash
  );
}

function recordPendingUpdate(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  item: PlannedItem,
  state: DefinitionItemUpdateRecoveryState | undefined,
  now: () => number,
): void {
  if (!item.physicalId) {
    throw new Error(`Update item '${item.logicalId}' has no physical ID.`);
  }
  const existing = getPendingUpdate(checkpoint, item.logicalId);
  const proof = logicalReferenceCheckpointProof(options, item);
  checkpoint.pendingUpdates[item.logicalId] = {
    logicalId: item.logicalId,
    action: "update",
    physicalId: item.physicalId,
    submittedAt:
      existing?.submittedAt ?? new Date(now()).toISOString(),
    ...proof,
    ...(state?.phase ? { phase: state.phase } : {}),
    ...(state?.stagedDefinitionHash
      ? { stagedDefinitionHash: state.stagedDefinitionHash }
      : {}),
    ...(state?.stagedDeploymentMarker
      ? { stagedDeploymentMarker: state.stagedDeploymentMarker }
      : {}),
    ...(state?.publishState
      ? { publishState: state.publishState }
      : {}),
    ...(state?.targetVersion
      ? { targetVersion: state.targetVersion }
      : {}),
    ...(state?.preservedAuxiliaryHash
      ? {
          preservedAuxiliaryHash:
            state.preservedAuxiliaryHash,
        }
      : {}),
  };
  writeCheckpoint(options.checkpointFile, checkpoint);
}

function requirePhysicalId(result: ApplyItemResult, logicalId: string): string {
  if (!result.physicalId) {
    throw new Error(`Applied item '${logicalId}' did not return a physical ID.`);
  }
  return result.physicalId;
}

function buildResult(
  plan: DeploymentPlan,
  status: ApplyResult["status"],
  startedAt: number,
  completedAt: number,
  items: ApplyItemResult[],
  workspaceId: string = plan.workspaceId,
  workspace?: ApplyWorkspaceResult,
  requiresItemReplan = false,
  networkProtection?: ApplyNetworkProtectionResult,
): ApplyResult {
  return {
    schemaVersion: "1",
    status,
    deploymentId: plan.deploymentId,
    workspaceId,
    environment: plan.environment,
    planHash: plan.planHash,
    ...(plan.sourceCommit ? { sourceCommit: plan.sourceCommit } : {}),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    ...(workspace ? { workspace } : {}),
    ...(requiresItemReplan
      ? { requiresItemReplan: true }
      : {}),
    items,
    ...(networkProtection ? { networkProtection } : {}),
  };
}
