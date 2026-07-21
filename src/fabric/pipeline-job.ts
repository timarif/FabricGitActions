/**
 * PipelineJobAdapter — wraps the DataPipeline-specific run-on-demand job
 * scheduler endpoints documented in the Fabric REST API.
 *
 * Authoritative spec:
 *   POST /v1/workspaces/{wid}/dataPipelines/{pid}/jobs/execute/instances
 *   GET  /v1/workspaces/{wid}/dataPipelines/{pid}/jobs/execute/instances/{jobInstanceId}
 *   source: microsoft/fabric-rest-api-specs:dataPipeline/swagger.json
 */

import type { FabricClient } from "./client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelineJobStatus =
  | "NotStarted"
  | "InProgress"
  | "Completed"
  | "Failed"
  | "Cancelled"
  | "Deduped"
  | (string & {});

/**
 * Statuses that indicate the job has finished and will not change further.
 * Source: DataPipelineExecuteJobInstance schema + example responses.
 */
export const TERMINAL_JOB_STATUSES = new Set<string>([
  "Completed",
  "Failed",
  "Cancelled",
  "Deduped",
]);

export interface PipelineJobFailureReason {
  errorCode?: string;
  message?: string;
  details?: unknown;
}

/** Matches DataPipelineExecuteJobInstance → ItemJobInstance in the spec. */
export interface PipelineJobInstance {
  id: string;
  itemId: string;
  jobType: string;
  invokeType: string;
  status: PipelineJobStatus;
  rootActivityId?: string;
  startTimeUtc?: string;
  endTimeUtc?: string;
  failureReason?: PipelineJobFailureReason | null;
}

export interface PipelineJobTrigger {
  jobInstanceId: string;
  initialRetryAfterMs: number;
}

export interface PipelineJobAdapterOptions {
  /** Maximum polling duration in milliseconds. Default: 60 minutes. */
  timeoutMs?: number;
  /** Base poll interval when no Retry-After header is present. Default: 10 s. */
  pollIntervalMs?: number;
  /** Injected for testing. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for testing. */
  now?: () => number;
}

export const DEFAULT_PIPELINE_JOB_TIMEOUT_MS = 60 * 60 * 1000; // 60 min
export const DEFAULT_PIPELINE_JOB_POLL_INTERVAL_MS = 10_000; // 10 s

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class PipelineJobAdapter {
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: FabricClient,
    options: PipelineJobAdapterOptions = {},
  ) {
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_PIPELINE_JOB_TIMEOUT_MS;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_PIPELINE_JOB_POLL_INTERVAL_MS;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /**
   * Triggers an on-demand execution of the pipeline and returns the job
   * instance ID extracted from the 202 Location header.
   *
   * Endpoint: POST .../dataPipelines/{pid}/jobs/execute/instances
   * Accepts:  202 Accepted — no body; Location header points to the instance.
   * Error codes: InsufficientPrivileges, InvalidJobType,
   *              TooManyRequestsForJobs, ItemNotFound.
   */
  async runOnDemand(
    workspaceId: string,
    pipelineId: string,
  ): Promise<PipelineJobTrigger> {
    const response = await this.client.request(
      "POST",
      pipelineJobsPath(workspaceId, pipelineId),
      {
        retryable: false,
        acceptedStatuses: [202],
      },
    );
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        "Data Pipeline run-on-demand response is missing the Location header.",
      );
    }
    const jobInstanceId = extractJobInstanceId(location);
    if (!jobInstanceId) {
      throw new Error(
        `Data Pipeline run-on-demand Location header does not contain a recognizable job instance ID: ${location}`,
      );
    }
    return {
      jobInstanceId,
      initialRetryAfterMs: readRetryAfterMs(
        response.headers.get("retry-after"),
        this.pollIntervalMs,
      ),
    };
  }

  /**
   * Polls the job instance until it reaches a terminal status or the timeout
   * expires. Respects the Retry-After header on each poll response.
   *
   * Endpoint: GET .../dataPipelines/{pid}/jobs/execute/instances/{jobInstanceId}
   * Terminal: Completed | Failed | Cancelled | Deduped
   */
  async pollJobInstance(
    workspaceId: string,
    pipelineId: string,
    jobInstanceId: string,
    initialDelayMs = 0,
  ): Promise<PipelineJobInstance> {
    const deadline = this.now() + this.timeoutMs;
    const pollPath = pipelineJobInstancePath(
      workspaceId,
      pipelineId,
      jobInstanceId,
    );

    if (initialDelayMs > 0) {
      await this.sleep(
        Math.min(initialDelayMs, Math.max(0, deadline - this.now())),
      );
    }

    while (true) {
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw new Error(
          `Data Pipeline job '${jobInstanceId}' did not reach a terminal state within ${this.timeoutMs / 1000}s.`,
        );
      }

      const response = await this.client.request<PipelineJobInstance>(
        "GET",
        pollPath,
        { retryable: true },
      );

      const instance = response.body;
      if (!instance || typeof instance.status !== "string") {
        throw new Error(
          `Data Pipeline job instance '${jobInstanceId}' response is missing or has an invalid status field.`,
        );
      }
      if (!sameUuid(instance.id, jobInstanceId)) {
        throw new Error(
          `Data Pipeline job instance read-back returned ID '${instance.id}' instead of '${jobInstanceId}'.`,
        );
      }
      if (!sameUuid(instance.itemId, pipelineId)) {
        throw new Error(
          `Data Pipeline job instance '${jobInstanceId}' belongs to item '${instance.itemId}' instead of '${pipelineId}'.`,
        );
      }
      if (
        typeof instance.jobType !== "string" ||
        instance.jobType.toLowerCase() !== "execute"
      ) {
        throw new Error(
          `Data Pipeline job instance '${jobInstanceId}' returned unexpected jobType '${instance.jobType}'.`,
        );
      }

      if (TERMINAL_JOB_STATUSES.has(instance.status)) {
        return instance;
      }

      const delay = readRetryAfterMs(
        response.headers.get("retry-after"),
        this.pollIntervalMs,
      );

      await this.sleep(Math.min(delay, deadline - this.now()));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pipelineJobsPath(
  workspaceId: string,
  pipelineId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(pipelineId)}/jobs/execute/instances`;
}

function pipelineJobInstancePath(
  workspaceId: string,
  pipelineId: string,
  jobInstanceId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/dataPipelines/${encodeURIComponent(pipelineId)}/jobs/execute/instances/${encodeURIComponent(jobInstanceId)}`;
}

/**
 * Extracts the job instance UUID from the Location header returned by the
 * run-on-demand 202 response.
 *
 * Spec example Location value:
 *   https://.../v1/workspaces/{wid}/items/{pid}/jobs/instances/{jobInstanceId}
 */
export function extractJobInstanceId(location: string): string | undefined {
  const match =
    /\/jobs\/instances\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
      location,
    );
  return match?.[1];
}

function readRetryAfterMs(
  value: string | null,
  fallbackMs: number,
): number {
  return value !== null && /^\d+$/.test(value)
    ? Math.max(1000, Number(value) * 1000)
    : fallbackMs;
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
