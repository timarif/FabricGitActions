/**
 * Tests for PipelineJobAdapter and extractJobInstanceId.
 *
 * Uses spec-sourced response shapes from:
 *   microsoft/fabric-rest-api-specs:dataPipeline/swagger.json
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PIPELINE_JOB_POLL_INTERVAL_MS,
  DEFAULT_PIPELINE_JOB_TIMEOUT_MS,
  extractJobInstanceId,
  PipelineJobAdapter,
  TERMINAL_JOB_STATUSES,
  type PipelineJobInstance,
} from "../src/fabric/pipeline-job";
import type { FabricClient } from "../src/fabric/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";
const PIPELINE_ID = "pp-00000000-0000-0000-0000-000000000002";
const JOB_INSTANCE_ID = "ab123456-0000-0000-0000-000000000099";

/** Build a minimal DataPipelineExecuteJobInstance response body. */
function makeInstance(
  status: string,
  failureReason?: PipelineJobInstance["failureReason"],
): PipelineJobInstance {
  return {
    id: JOB_INSTANCE_ID,
    itemId: PIPELINE_ID,
    jobType: "Execute",
    invokeType: "Manual",
    status,
    rootActivityId: "root-activity-id",
    startTimeUtc: "2024-01-15T10:00:00Z",
    endTimeUtc: status === "Completed" ? "2024-01-15T10:05:00Z" : undefined,
    failureReason: failureReason ?? null,
  };
}

/** Build a spec-compliant Location header value for the 202 run response. */
function makeLocation(jobInstanceId: string): string {
  return `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE_ID}/items/${PIPELINE_ID}/jobs/instances/${jobInstanceId}`;
}

function mockClient(overrides: Partial<FabricClient> = {}): FabricClient {
  return {
    request: vi.fn(),
    listAll: vi.fn(),
    waitForOperation: vi.fn(),
    waitForOperationCompletion: vi.fn(),
    ...overrides,
  } as unknown as FabricClient;
}

// ---------------------------------------------------------------------------
// extractJobInstanceId
// ---------------------------------------------------------------------------

describe("extractJobInstanceId", () => {
  it("extracts UUID from a spec-compliant Location URL", () => {
    expect(
      extractJobInstanceId(
        `https://api.fabric.microsoft.com/v1/workspaces/ws-1/items/pp-2/jobs/instances/${JOB_INSTANCE_ID}`,
      ),
    ).toBe(JOB_INSTANCE_ID);
  });

  it("extracts UUID from a Location URL with a trailing slash", () => {
    expect(
      extractJobInstanceId(
        `https://api.fabric.microsoft.com/v1/workspaces/ws-1/items/pp-2/jobs/instances/${JOB_INSTANCE_ID}/`,
      ),
    ).toBe(JOB_INSTANCE_ID);
  });

  it("returns undefined for a Location without a UUID segment", () => {
    expect(
      extractJobInstanceId(
        "https://api.fabric.microsoft.com/v1/operations/someOpId",
      ),
    ).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(extractJobInstanceId("")).toBeUndefined();
  });

  it("is case-insensitive for hex digits", () => {
    const upper = JOB_INSTANCE_ID.toUpperCase();
    expect(
      extractJobInstanceId(
        `https://api.fabric.microsoft.com/v1/workspaces/ws/items/pp/jobs/instances/${upper}`,
      ),
    ).toBe(upper);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_JOB_STATUSES
// ---------------------------------------------------------------------------

describe("TERMINAL_JOB_STATUSES", () => {
  it("contains Completed", () => {
    expect(TERMINAL_JOB_STATUSES.has("Completed")).toBe(true);
  });
  it("contains Failed", () => {
    expect(TERMINAL_JOB_STATUSES.has("Failed")).toBe(true);
  });
  it("contains Cancelled", () => {
    expect(TERMINAL_JOB_STATUSES.has("Cancelled")).toBe(true);
  });
  it("contains Deduped", () => {
    expect(TERMINAL_JOB_STATUSES.has("Deduped")).toBe(true);
  });
  it("does not contain InProgress", () => {
    expect(TERMINAL_JOB_STATUSES.has("InProgress")).toBe(false);
  });
  it("does not contain NotStarted", () => {
    expect(TERMINAL_JOB_STATUSES.has("NotStarted")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PipelineJobAdapter.runOnDemand
// ---------------------------------------------------------------------------

describe("PipelineJobAdapter.runOnDemand", () => {
  it("POSTs to the DataPipeline-specific jobs/execute/instances path", async () => {
    const requestFn = vi.fn().mockResolvedValueOnce({
      status: 202,
      headers: new Map([["location", makeLocation(JOB_INSTANCE_ID)]]),
      body: undefined,
    });
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client);

    await adapter.runOnDemand(WORKSPACE_ID, PIPELINE_ID);

    expect(requestFn).toHaveBeenCalledOnce();
    const [method, urlPath] = requestFn.mock.calls[0] as [string, string];
    expect(method).toBe("POST");
    expect(urlPath).toContain(
      `/v1/workspaces/${WORKSPACE_ID}/dataPipelines/${PIPELINE_ID}/jobs/execute/instances`,
    );
  });

  it("returns the job instance ID and initial Retry-After delay", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 202,
        headers: new Map([
          ["location", makeLocation(JOB_INSTANCE_ID)],
          ["retry-after", "60"],
        ]),
        body: undefined,
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client);

    const result = await adapter.runOnDemand(WORKSPACE_ID, PIPELINE_ID);

    expect(result).toEqual({
      jobInstanceId: JOB_INSTANCE_ID,
      initialRetryAfterMs: 60_000,
    });
  });

  it("uses the configured poll interval when trigger Retry-After is absent", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 202,
        headers: new Map([["location", makeLocation(JOB_INSTANCE_ID)]]),
        body: undefined,
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, {
      pollIntervalMs: 12_000,
    });

    await expect(
      adapter.runOnDemand(WORKSPACE_ID, PIPELINE_ID),
    ).resolves.toMatchObject({ initialRetryAfterMs: 12_000 });
  });

  it("throws when the 202 response has no Location header", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 202,
        headers: new Map<string, string>(),
        body: undefined,
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client);

    await expect(
      adapter.runOnDemand(WORKSPACE_ID, PIPELINE_ID),
    ).rejects.toThrow(/missing the Location header/);
  });

  it("throws when the Location header contains no recognizable UUID", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 202,
        headers: new Map([
          ["location", "https://api.fabric.microsoft.com/v1/operations/opId"],
        ]),
        body: undefined,
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client);

    await expect(
      adapter.runOnDemand(WORKSPACE_ID, PIPELINE_ID),
    ).rejects.toThrow(/Location header does not contain a recognizable job instance ID/);
  });
});

// ---------------------------------------------------------------------------
// PipelineJobAdapter.pollJobInstance
// ---------------------------------------------------------------------------

describe("PipelineJobAdapter.pollJobInstance", () => {
  /** Builds a mock client that returns a sequence of statuses. */
  function buildPollingClient(statuses: string[]): FabricClient {
    let callIndex = 0;
    const requestFn = vi.fn().mockImplementation(() => {
      const status = statuses[callIndex++] ?? "Completed";
      return Promise.resolve({
        status: 200,
        headers: new Map([["retry-after", "1"]]),
        body: makeInstance(status),
      });
    });
    return mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
  }

  it("returns immediately when the first poll reports Completed", async () => {
    const client = buildPollingClient(["Completed"]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, { sleep, pollIntervalMs: 1 });

    const result = await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
    );

    expect(result.status).toBe("Completed");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("polls through InProgress → Completed and returns the final instance", async () => {
    const client = buildPollingClient(["InProgress", "InProgress", "Completed"]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, {
      sleep,
      pollIntervalMs: 1,
    });

    const result = await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
    );

    expect(result.status).toBe("Completed");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits the trigger Retry-After delay before the first poll", async () => {
    const client = buildPollingClient(["Completed"]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, {
      sleep,
      pollIntervalMs: 1,
    });

    await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
      60_000,
    );

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(60_000);
  });

  it("returns on Failed status with failureReason populated", async () => {
    let callCount = 0;
    const requestFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        status: 200,
        headers: new Map<string, string>(),
        body: makeInstance("Failed", {
          errorCode: "PipelineActivityFailed",
          message: "Activity failed.",
        }),
      });
    });
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, { sleep, pollIntervalMs: 1 });

    const result = await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
    );

    expect(result.status).toBe("Failed");
    expect(result.failureReason?.errorCode).toBe("PipelineActivityFailed");
    expect(callCount).toBe(1);
  });

  it("returns on Cancelled status", async () => {
    const client = buildPollingClient(["Cancelled"]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, { sleep, pollIntervalMs: 1 });

    const result = await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
    );

    expect(result.status).toBe("Cancelled");
  });

  it("returns on Deduped status", async () => {
    const client = buildPollingClient(["Deduped"]);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const adapter = new PipelineJobAdapter(client, { sleep, pollIntervalMs: 1 });

    const result = await adapter.pollJobInstance(
      WORKSPACE_ID,
      PIPELINE_ID,
      JOB_INSTANCE_ID,
    );

    expect(result.status).toBe("Deduped");
  });

  it("throws after timeout when job stays InProgress", async () => {
    const requestFn = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve({
          status: 200,
          headers: new Map<string, string>(),
          body: makeInstance("InProgress"),
        }),
      );
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    let fakeTime = 0;
    const now = () => fakeTime;
    const adapter = new PipelineJobAdapter(client, {
      sleep,
      now,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    // Advance time past timeout after first sleep call
    sleep.mockImplementation(() => {
      fakeTime += 200;
      return Promise.resolve();
    });

    await expect(
      adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID),
    ).rejects.toThrow(/did not reach a terminal state/);
  });

  it("respects the Retry-After header on each poll response", async () => {
    let callCount = 0;
    const requestFn = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        status: 200,
        headers: new Map([["retry-after", "30"]]),
        body: callCount < 3 ? makeInstance("InProgress") : makeInstance("Completed"),
      });
    });
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const sleepArgs: number[] = [];
    const sleep = vi.fn().mockImplementation((ms: number) => {
      sleepArgs.push(ms);
      return Promise.resolve();
    });
    const adapter = new PipelineJobAdapter(client, {
      sleep,
      pollIntervalMs: 10_000, // would yield 10 s without Retry-After
      timeoutMs: DEFAULT_PIPELINE_JOB_TIMEOUT_MS,
    });

    await adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID);

    // Retry-After: 30 means 30_000 ms — must NOT use pollIntervalMs (10_000)
    expect(sleepArgs.every((ms) => ms === 30_000)).toBe(true);
  });

  it("throws when the response body has no status field", async () => {
    const requestFn = vi.fn().mockResolvedValueOnce({
      status: 200,
      headers: new Map<string, string>(),
      body: { id: JOB_INSTANCE_ID }, // missing status
    });
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, {
      sleep: vi.fn(),
      pollIntervalMs: 1,
    });

    await expect(
      adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID),
    ).rejects.toThrow(/missing or has an invalid status field/);
  });

  it("rejects a job response for a different instance", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map<string, string>(),
        body: {
          ...makeInstance("Completed"),
          id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        },
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, { sleep: vi.fn() });

    await expect(
      adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID),
    ).rejects.toThrow(/returned ID/);
  });

  it("compares job and item UUIDs without case sensitivity", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map<string, string>(),
        body: makeInstance("Completed"),
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, { sleep: vi.fn() });

    await expect(
      adapter.pollJobInstance(
        WORKSPACE_ID.toUpperCase(),
        PIPELINE_ID.toUpperCase(),
        JOB_INSTANCE_ID.toUpperCase(),
      ),
    ).resolves.toMatchObject({ status: "Completed" });
  });

  it("rejects a job response for a different pipeline", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map<string, string>(),
        body: {
          ...makeInstance("Completed"),
          itemId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        },
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, { sleep: vi.fn() });

    await expect(
      adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID),
    ).rejects.toThrow(/belongs to item/);
  });

  it("rejects an unexpected job type", async () => {
    const client = mockClient({
      request: vi.fn().mockResolvedValueOnce({
        status: 200,
        headers: new Map<string, string>(),
        body: {
          ...makeInstance("Completed"),
          jobType: "Pipeline",
        },
      }) as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, { sleep: vi.fn() });

    await expect(
      adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID),
    ).rejects.toThrow(/unexpected jobType/);
  });

  it("uses the correct GET path for polling", async () => {
    const requestFn = vi.fn().mockResolvedValueOnce({
      status: 200,
      headers: new Map<string, string>(),
      body: makeInstance("Completed"),
    });
    const client = mockClient({
      request: requestFn as unknown as FabricClient["request"],
    });
    const adapter = new PipelineJobAdapter(client, {
      sleep: vi.fn(),
      pollIntervalMs: 1,
    });

    await adapter.pollJobInstance(WORKSPACE_ID, PIPELINE_ID, JOB_INSTANCE_ID);

    const [method, urlPath] = requestFn.mock.calls[0] as [string, string];
    expect(method).toBe("GET");
    expect(urlPath).toContain(
      `/dataPipelines/${PIPELINE_ID}/jobs/execute/instances/${JOB_INSTANCE_ID}`,
    );
  });

  it("defaults poll interval is 10 seconds and timeout is 60 minutes", () => {
    expect(DEFAULT_PIPELINE_JOB_POLL_INTERVAL_MS).toBe(10_000);
    expect(DEFAULT_PIPELINE_JOB_TIMEOUT_MS).toBe(60 * 60 * 1000);
  });
});
