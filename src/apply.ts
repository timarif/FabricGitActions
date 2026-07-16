import { stableJson } from "./hash";
import {
  assertDistinctFilePaths,
  assertOutputPathOutsideItems,
} from "./reporting";
import type {
  LakehouseAdapter,
  LakehouseOperationReference,
} from "./fabric/lakehouse";
import { FabricOperationFailedError } from "./fabric/client";
import {
  createCheckpoint,
  loadCheckpoint,
  writeApplyResult,
  writeCheckpoint,
} from "./checkpoint";
import type {
  ApplyCheckpoint,
  ApplyItemResult,
  ApplyResult,
  DeploymentPlan,
  LoadedManifest,
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
  allowCreate: boolean;
  allowUpdate: boolean;
  checkpointFile: string;
  resultFile: string;
  itemDirectories?: string[];
  now?: () => number;
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
    const recoveredUpdates = await reconcilePendingUpdates(
      options,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const recoveredCreates = await reconcilePendingCreates(
      options,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const resumedOperations = await resumePendingOperations(
      options,
      checkpoint,
      approvedItems,
      currentItems,
      now,
    );
    const trustedResumes = new Set([
      ...recoveredUpdates,
      ...recoveredCreates,
      ...resumedOperations,
    ]);
    preflightPlan(
      options,
      checkpoint,
      approvedItems,
      currentItems,
      trustedResumes,
    );
    const resumedDurations = await verifyCheckpointedItems(
      options,
      checkpoint,
      approvedItems,
      now,
    );

    for (const stage of options.approvedPlan.stages) {
      for (const logicalId of stage) {
        const approvedItem = approvedItems.get(logicalId);
        const currentItem = currentItems.get(logicalId);
        if (!approvedItem || !currentItem) {
          throw new Error(`Plan item '${logicalId}' is missing during apply.`);
        }

        const itemStartedAt = now();
        const completed = getCompletedItem(checkpoint, logicalId);
        if (completed) {
          results.push({
            logicalId,
            type: approvedItem.type,
            action: approvedItem.action,
            status: "resumed",
            physicalId: completed.physicalId,
            durationMs: resumedDurations.get(logicalId) ?? 0,
          });
          continue;
        }

        await assertFreshItemHasNotDrifted(options, approvedItem);
        let result: ApplyItemResult;
        try {
          result = await applyItem(
            options,
            approvedItem,
            itemStartedAt,
            now,
            (physicalId) => {
              delete checkpoint.pendingCreates[logicalId];
              delete checkpoint.pendingOperations[logicalId];
              delete checkpoint.pendingUpdates[logicalId];
              checkpoint.completedItems[logicalId] = {
                logicalId,
                action: approvedItem.action,
                physicalId,
                completedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            (operation) => {
              delete checkpoint.pendingCreates[logicalId];
              checkpoint.pendingOperations[logicalId] = {
                logicalId,
                action: "create",
                ...operation,
                acceptedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              checkpoint.pendingCreates[logicalId] = {
                logicalId,
                action: "create",
                submittedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              delete checkpoint.pendingCreates[logicalId];
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              if (!approvedItem.physicalId) {
                throw new Error(
                  `Update item '${logicalId}' has no physical ID.`,
                );
              }
              checkpoint.pendingUpdates[logicalId] = {
                logicalId,
                action: "update",
                physicalId: approvedItem.physicalId,
                submittedAt: new Date(now()).toISOString(),
              };
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
            () => {
              delete checkpoint.pendingUpdates[logicalId];
              writeCheckpoint(options.checkpointFile, checkpoint);
            },
          );
        } catch (error) {
          if (
            error instanceof FabricOperationFailedError &&
            approvedItem.action === "create"
          ) {
            const reconciled = await reconcileInitialTerminalCreate(
              options,
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
        results.push(result);
        delete checkpoint.pendingCreates[logicalId];
        delete checkpoint.pendingOperations[logicalId];
        delete checkpoint.pendingUpdates[logicalId];
        checkpoint.completedItems[logicalId] = {
          logicalId,
          action: approvedItem.action,
          physicalId: requirePhysicalId(result, logicalId),
          completedAt: new Date(now()).toISOString(),
        };
        writeCheckpoint(options.checkpointFile, checkpoint);
      }

    }

    const result = buildResult(
      options.approvedPlan,
      "succeeded",
      startedAt,
      now(),
      results,
    );
    writeApplyResult(options.resultFile, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
    );
    if (resultWritable) {
      try {
        writeApplyResult(options.resultFile, result);
      } catch (reportingError) {
        throw new AggregateError(
          [error, reportingError],
          `${message} Result reporting also failed.`,
        );
      }
    }
    throw error;
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
  const live = await options.lakehouseAdapter.plan(
    options.approvedPlan.workspaceId,
    desired,
  );
  if (live.action === "create") {
    delete checkpoint.pendingOperations[item.logicalId];
    writeCheckpoint(options.checkpointFile, checkpoint);
    return undefined;
  }
  if (live.action !== "no-op" || !live.physicalId) {
    return undefined;
  }
  const verified = await options.lakehouseAdapter.verify(
    options.approvedPlan.workspaceId,
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
  const desired =
    options.loadedManifest.itemDefinitions[approvedItem.logicalId];
  if (!desired) {
    throw new Error(
      `Desired definition is missing for '${approvedItem.logicalId}'.`,
    );
  }
  const live = await options.lakehouseAdapter.plan(
    options.approvedPlan.workspaceId,
    desired,
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
    ...(live.physicalId ? { physicalId: live.physicalId } : {}),
  };
  assertItemHasNotDrifted(approvedItem, freshItem);
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
    workspaceId: approvedPlan.workspaceId,
    environment: approvedPlan.environment,
    sourceCommit: approvedPlan.sourceCommit,
    sourceHash: approvedPlan.sourceHash,
    resolvedHash: approvedPlan.resolvedHash,
    stages: approvedPlan.stages,
  };
  const currentIdentity = {
    deploymentId: currentPlan.deploymentId,
    workspaceId: currentPlan.workspaceId,
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
      if (approvedItem.type !== "Lakehouse") {
        throw new Error(
          `Apply is not implemented for item '${logicalId}' of type ${approvedItem.type}.`,
        );
      }
      if (!options.loadedManifest.itemDefinitions[logicalId]) {
        throw new Error(`Desired definition is missing for '${logicalId}'.`);
      }
      const completed = getCompletedItem(checkpoint, logicalId);
      if (completed) {
        assertCheckpointedItemSourceUnchanged(approvedItem, currentItem);
        if (resumedOperations.has(logicalId)) {
          continue;
        }
        if (
          currentItem.action !== "no-op" ||
          currentItem.physicalId !== completed.physicalId
        ) {
          throw new Error(
            `Checkpointed item '${logicalId}' is not a no-op for physical ID '${completed.physicalId}' in the current Fabric plan.`,
          );
        }

        continue;
      }

      assertItemHasNotDrifted(approvedItem, currentItem);
      if (approvedItem.action === "create" && !options.allowCreate) {
        throw new Error(
          `Plan requires creating '${logicalId}', but allow-create is false.`,
        );
      }
      if (approvedItem.action === "update" && !options.allowUpdate) {
        throw new Error(
          `Plan requires updating '${logicalId}', but allow-update is false.`,
        );
      }
      if (
        (approvedItem.action === "update" ||
          approvedItem.action === "no-op") &&
        !approvedItem.physicalId
      ) {
        throw new Error(
          `${approvedItem.action} item '${logicalId}' has no physical ID.`,
        );
      }
      if (
        approvedItem.action !== "create" &&
        approvedItem.action !== "update" &&
        approvedItem.action !== "no-op"
      ) {
        throw new Error(
          `Item '${logicalId}' cannot be applied while action is '${approvedItem.action}'.`,
        );
      }
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
      if (!approvedItem || approvedItem.type !== "Lakehouse") {
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
        const created = await options.lakehouseAdapter.resumeCreate(
          options.approvedPlan.workspaceId,
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
          live = await options.lakehouseAdapter.plan(
            options.approvedPlan.workspaceId,
            desired,
          );
        } catch (reconciliationError) {
          throw new AggregateError(
            [operationError, reconciliationError],
            `Could not resume or reconcile create operation for '${logicalId}'.`,
          );
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
        const verified = await options.lakehouseAdapter.verify(
          options.approvedPlan.workspaceId,
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
        approvedItem.type !== "Lakehouse" ||
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
      const live = await options.lakehouseAdapter.plan(
        options.approvedPlan.workspaceId,
        desired,
      );
      if (live.action !== "no-op" || !live.physicalId) {
        throw new Error(
          `Create intent for '${logicalId}' has no resumable operation reference and current Fabric state is '${live.action}'. Wait for visibility or start a reviewed recovery before retrying.`,
        );
      }
      const verified = await options.lakehouseAdapter.verify(
        options.approvedPlan.workspaceId,
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
        approvedItem.type !== "Lakehouse" ||
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
      const live = await options.lakehouseAdapter.plan(
        options.approvedPlan.workspaceId,
        desired,
      );
      if (
        live.action !== "no-op" ||
        live.physicalId !== intent.physicalId
      ) {
        throw new Error(
          `Update intent for '${logicalId}' cannot be reconciled because current Fabric state is '${live.action}'. Wait for visibility or start a reviewed recovery before retrying.`,
        );
      }
      const verified = await options.lakehouseAdapter.verify(
        options.approvedPlan.workspaceId,
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
  };
}

async function verifyCheckpointedItems(
  options: ApplyPlanOptions,
  checkpoint: ApplyCheckpoint,
  approvedItems: Map<string, PlannedItem>,
  now: () => number,
): Promise<Map<string, number>> {
  const durations = new Map<string, number>();
  for (const stage of options.approvedPlan.stages) {
    for (const logicalId of stage) {
      const completed = getCompletedItem(checkpoint, logicalId);
      if (!completed) {
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
  };
}

async function applyItem(
  options: ApplyPlanOptions,
  item: PlannedItem,
  startedAt: number,
  now: () => number,
  onMutationAccepted: (physicalId: string) => void,
  onOperationAccepted: (operation: LakehouseOperationReference) => void,
  onCreateSubmitting: () => void,
  onCreateRejected: () => void,
  onUpdateSubmitting: () => void,
  onUpdateRejected: () => void,
): Promise<ApplyItemResult> {
  if (item.type !== "Lakehouse") {
    throw new Error(
      `Apply is not implemented for item '${item.logicalId}' of type ${item.type}.`,
    );
  }
  const desired = options.loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    throw new Error(`Desired definition is missing for '${item.logicalId}'.`);
  }

  if (item.action === "create") {
    if (!options.allowCreate) {
      throw new Error(
        `Plan requires creating '${item.logicalId}', but allow-create is false.`,
      );
    }
    const created = await options.lakehouseAdapter.create(
      options.approvedPlan.workspaceId,
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
    const updated = await options.lakehouseAdapter.update(
      options.approvedPlan.workspaceId,
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
    const verified = await options.lakehouseAdapter.verify(
      options.approvedPlan.workspaceId,
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
  physicalId: string,
): Promise<void> {
  if (item.type !== "Lakehouse") {
    throw new Error(
      `Checkpoint resume is not implemented for type ${item.type}.`,
    );
  }
  const desired = options.loadedManifest.itemDefinitions[item.logicalId];
  if (!desired) {
    throw new Error(`Desired definition is missing for '${item.logicalId}'.`);
  }
  await options.lakehouseAdapter.verify(
    options.approvedPlan.workspaceId,
    physicalId,
    desired,
  );
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
): ApplyResult {
  return {
    schemaVersion: "1",
    status,
    deploymentId: plan.deploymentId,
    workspaceId: plan.workspaceId,
    environment: plan.environment,
    planHash: plan.planHash,
    ...(plan.sourceCommit ? { sourceCommit: plan.sourceCommit } : {}),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    items,
  };
}
