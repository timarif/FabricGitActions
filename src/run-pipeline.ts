/**
 * runPipeline — orchestrates the run-pipeline mode.
 *
 * Resolves the logical pipeline ID to a physical Fabric item, triggers an
 * on-demand job execution via PipelineJobAdapter, polls to terminal state,
 * and returns a structured result. All execution side effects are gated by
 * the allow-pipeline-run safeguard.
 */

import type { PipelineAdapter } from "./fabric/pipeline";
import type { PipelineJobAdapter } from "./fabric/pipeline-job";
import type { LoadedManifest } from "./types";

export const MAX_PIPELINE_RUN_TIMEOUT_MINUTES = 24 * 60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunPipelineRequest {
  pipelineLogicalId: string;
  allowPipelineRun: boolean;
  workspaceId: string;
}

export interface PipelineRunResult {
  schemaVersion: "1";
  pipelineLogicalId: string;
  pipelinePhysicalId: string;
  workspaceId: string;
  jobInstanceId: string;
  status: string;
  triggeredAt: string;
  completedAt?: string;
  durationMs: number;
  failureReason?: { errorCode?: string; message?: string } | null;
}

export interface RunPipelineHooks {
  onTriggered?: (result: PipelineRunResult) => void;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runPipeline(
  request: RunPipelineRequest,
  loadedManifest: LoadedManifest,
  pipelineAdapter: PipelineAdapter,
  pipelineJobAdapter: PipelineJobAdapter,
  hooks: RunPipelineHooks = {},
): Promise<PipelineRunResult> {
  // ------------------------------------------------------------------
  // 1. Safeguard — fail closed before touching any Fabric API.
  // ------------------------------------------------------------------
  if (!request.allowPipelineRun) {
    throw new Error(
      "allow-pipeline-run must be 'true' to trigger a Data Pipeline job. " +
        "This safeguard prevents unintended pipeline execution.",
    );
  }

  if (!request.workspaceId) {
    throw new Error(
      "A workspace ID is required for run-pipeline mode. " +
        "Set workspace-id input or add workspace.id to the manifest.",
    );
  }

  // ------------------------------------------------------------------
  // 2. Locate and validate the manifest item.
  // ------------------------------------------------------------------
  const manifestItem = loadedManifest.manifest.items.find(
    (item) => item.logicalId === request.pipelineLogicalId,
  );
  if (!manifestItem) {
    throw new Error(
      `Logical ID '${request.pipelineLogicalId}' was not found in the deployment manifest.`,
    );
  }
  if (manifestItem.type !== "DataPipeline") {
    throw new Error(
      `Manifest item '${request.pipelineLogicalId}' is of type '${manifestItem.type}', not 'DataPipeline'. ` +
        "run-pipeline mode only supports DataPipeline items.",
    );
  }
  const desiredState = manifestItem.desiredState ?? "present";
  if (desiredState !== "present") {
    throw new Error(
      `Data Pipeline '${request.pipelineLogicalId}' has desiredState '${desiredState}'. ` +
        "Only items with desiredState 'present' can be run.",
    );
  }

  const itemDefinition =
    loadedManifest.itemDefinitions[request.pipelineLogicalId];
  if (!itemDefinition) {
    throw new Error(
      `Item definition for '${request.pipelineLogicalId}' was not found in the loaded manifest.`,
    );
  }

  // ------------------------------------------------------------------
  // 3. Resolve physical item using the existing folder-aware adapter.
  // ------------------------------------------------------------------
  const physicalPipeline = await pipelineAdapter.resolveForRun(
    request.workspaceId,
    itemDefinition,
  );

  // ------------------------------------------------------------------
  // 4. Trigger and poll.
  // ------------------------------------------------------------------
  const triggeredAt = new Date().toISOString();

  const trigger = await pipelineJobAdapter.runOnDemand(
    request.workspaceId,
    physicalPipeline.id,
  );
  const pendingResult: PipelineRunResult = {
    schemaVersion: "1",
    pipelineLogicalId: request.pipelineLogicalId,
    pipelinePhysicalId: physicalPipeline.id,
    workspaceId: request.workspaceId,
    jobInstanceId: trigger.jobInstanceId,
    status: "InProgress",
    triggeredAt,
    durationMs: 0,
    failureReason: null,
  };
  hooks.onTriggered?.(pendingResult);

  const instance = await pipelineJobAdapter.pollJobInstance(
    request.workspaceId,
    physicalPipeline.id,
    trigger.jobInstanceId,
    trigger.initialRetryAfterMs,
  );

  const completedAt = new Date().toISOString();

  return {
    schemaVersion: "1",
    pipelineLogicalId: request.pipelineLogicalId,
    pipelinePhysicalId: physicalPipeline.id,
    workspaceId: request.workspaceId,
    jobInstanceId: trigger.jobInstanceId,
    status: instance.status,
    triggeredAt,
    completedAt,
    durationMs:
      new Date(completedAt).getTime() - new Date(triggeredAt).getTime(),
    failureReason: instance.failureReason ?? null,
  };
}

export function parsePipelineRunTimeoutMs(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `pipeline-run-timeout-minutes must be a positive integer; received '${value}'.`,
    );
  }
  const minutes = Number(value);
  if (
    !Number.isSafeInteger(minutes) ||
    minutes > MAX_PIPELINE_RUN_TIMEOUT_MINUTES
  ) {
    throw new Error(
      `pipeline-run-timeout-minutes must be between 1 and ${MAX_PIPELINE_RUN_TIMEOUT_MINUTES}; received '${value}'.`,
    );
  }
  return minutes * 60 * 1000;
}
