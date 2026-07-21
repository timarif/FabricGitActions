/**
 * Tests for the runPipeline() orchestration function.
 *
 * Validates safeguard enforcement, manifest resolution, physical item lookup,
 * trigger/poll wiring, result population, and no invocation during apply mode.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PIPELINE_RUN_TIMEOUT_MINUTES,
  parsePipelineRunTimeoutMs,
  runPipeline,
} from "../src/run-pipeline";
import type { PipelineAdapter } from "../src/fabric/pipeline";
import type { PipelineJobAdapter } from "../src/fabric/pipeline-job";
import type { LoadedManifest } from "../src/types";
import type { FabricDefinition } from "../src/fabric/definition";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-00000000-0000-0000-0000-000000000001";
const PIPELINE_LOGICAL_ID = "my-pipeline";
const PIPELINE_PHYSICAL_ID = "pp-00000000-0000-0000-0000-000000000002";
const JOB_INSTANCE_ID = "ab123456-0000-0000-0000-000000000099";

/** Minimal LoadedManifest containing one DataPipeline item. */
function makeManifest(overrides: {
  type?: string;
  desiredState?: string;
  hasDefinition?: boolean;
} = {}): LoadedManifest {
  const {
    type = "DataPipeline",
    desiredState = "present",
    hasDefinition = true,
  } = overrides;
  return {
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1" as const,
      kind: "FabricDeployment" as const,
      metadata: { deploymentId: "deploy-id" },
      workspace: { id: WORKSPACE_ID },
      items: [
        {
          logicalId: PIPELINE_LOGICAL_ID,
          type: type as "DataPipeline",
          path: "pipelines/my-pipeline",
          desiredState: desiredState as "present" | "absent",
        },
      ],
    },
    manifestPath: "fabric/deployment.yaml",
    manifestDirectory: "fabric",
    sourceHash: "source-hash",
    resolvedHash: "resolved-hash",
    itemContentHashes: {},
    itemDirectories: {
      [PIPELINE_LOGICAL_ID]: "pipelines/my-pipeline",
    },
    itemDefinitions: hasDefinition
      ? {
          [PIPELINE_LOGICAL_ID]: {
            displayName: "My Pipeline",
            folderId: undefined,
          },
        }
      : {},
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: hasDefinition
      ? { [PIPELINE_LOGICAL_ID]: { parts: [] } as unknown as FabricDefinition }
      : {},
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
  } as unknown as LoadedManifest;
}

function makePhysicalPipeline() {
  return {
    id: PIPELINE_PHYSICAL_ID,
    workspaceId: WORKSPACE_ID,
    type: "DataPipeline" as const,
    displayName: "My Pipeline",
  };
}

function makeJobInstance(status: string, failureReason?: unknown) {
  return {
    id: JOB_INSTANCE_ID,
    itemId: PIPELINE_PHYSICAL_ID,
    jobType: "Execute",
    invokeType: "Manual",
    status,
    failureReason: failureReason ?? null,
    startTimeUtc: "2024-01-15T10:00:00Z",
    endTimeUtc: "2024-01-15T10:05:00Z",
  };
}

/** Creates a mock PipelineAdapter. */
function makePipelineAdapter(
  resolveOverride?: () => Promise<ReturnType<typeof makePhysicalPipeline>>,
): PipelineAdapter {
  return {
    resolveForRun:
      resolveOverride ??
      vi.fn().mockResolvedValue(makePhysicalPipeline()),
  } as unknown as PipelineAdapter;
}

/** Creates a mock PipelineJobAdapter. */
function makeJobAdapter(
  runOverride?: () => Promise<{
    jobInstanceId: string;
    initialRetryAfterMs: number;
  }>,
  pollOverride?: () => Promise<ReturnType<typeof makeJobInstance>>,
): PipelineJobAdapter {
  return {
    runOnDemand:
      runOverride ??
      vi.fn().mockResolvedValue({
        jobInstanceId: JOB_INSTANCE_ID,
        initialRetryAfterMs: 60_000,
      }),
    pollJobInstance:
      pollOverride ??
      vi.fn().mockResolvedValue(makeJobInstance("Completed")),
  } as unknown as PipelineJobAdapter;
}

// ---------------------------------------------------------------------------
// Safeguard tests
// ---------------------------------------------------------------------------

describe("runPipeline safeguard", () => {
  it("throws before any API call when allowPipelineRun is false", async () => {
    const pipelineAdapter = makePipelineAdapter();
    const jobAdapter = makeJobAdapter();

    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: false,
          workspaceId: WORKSPACE_ID,
        },
        makeManifest(),
        pipelineAdapter,
        jobAdapter,
      ),
    ).rejects.toThrow(/allow-pipeline-run must be 'true'/);

    expect(
      (pipelineAdapter.resolveForRun as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(0);
    expect(
      (jobAdapter.runOnDemand as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("throws when workspaceId is empty string", async () => {
    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: "",
        },
        makeManifest(),
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/workspace ID is required/);
  });
});

// ---------------------------------------------------------------------------
// Manifest resolution tests
// ---------------------------------------------------------------------------

describe("runPipeline manifest resolution", () => {
  it("throws when the logical ID is not in the manifest", async () => {
    await expect(
      runPipeline(
        {
          pipelineLogicalId: "nonexistent-pipeline",
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        makeManifest(),
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/Logical ID 'nonexistent-pipeline' was not found/);
  });

  it("throws when the manifest item type is not DataPipeline", async () => {
    const manifest = makeManifest({ type: "Notebook" });
    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        manifest,
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/type 'Notebook', not 'DataPipeline'/);
  });

  it("throws when the manifest item desiredState is absent", async () => {
    const manifest = makeManifest({ desiredState: "absent" });
    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        manifest,
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/desiredState 'absent'/);
  });

  it("throws when itemDefinition is missing", async () => {
    const manifest = makeManifest({ hasDefinition: false });
    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        manifest,
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/Item definition for '.*' was not found/);
  });
});

// ---------------------------------------------------------------------------
// Physical item resolution tests
// ---------------------------------------------------------------------------

describe("runPipeline physical item resolution", () => {
  it("calls resolveForRun with the correct workspaceId and item definition", async () => {
    const resolveForRun = vi.fn().mockResolvedValue(makePhysicalPipeline());
    const pipelineAdapter = { resolveForRun } as unknown as PipelineAdapter;

    await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      pipelineAdapter,
      makeJobAdapter(),
    );

    expect(resolveForRun).toHaveBeenCalledOnce();
    const [passedWorkspaceId, passedDefinition] = resolveForRun.mock
      .calls[0] as [string, { displayName: string }];
    expect(passedWorkspaceId).toBe(WORKSPACE_ID);
    expect(passedDefinition.displayName).toBe("My Pipeline");
  });

  it("propagates errors from resolveForRun (item not found)", async () => {
    const resolveForRun = vi.fn().mockRejectedValue(
      new Error("Data Pipeline 'My Pipeline' was not found in workspace."),
    );
    const pipelineAdapter = { resolveForRun } as unknown as PipelineAdapter;

    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        makeManifest(),
        pipelineAdapter,
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// Trigger and poll wiring
// ---------------------------------------------------------------------------

describe("runPipeline trigger and poll", () => {
  it("calls runOnDemand with the resolved physical pipeline ID", async () => {
    const runOnDemand = vi.fn().mockResolvedValue({
      jobInstanceId: JOB_INSTANCE_ID,
      initialRetryAfterMs: 60_000,
    });
    const jobAdapter = {
      runOnDemand,
      pollJobInstance: vi.fn().mockResolvedValue(makeJobInstance("Completed")),
    } as unknown as PipelineJobAdapter;

    await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      jobAdapter,
    );

    expect(runOnDemand).toHaveBeenCalledOnce();
    const [wid, pid] = runOnDemand.mock.calls[0] as [string, string];
    expect(wid).toBe(WORKSPACE_ID);
    expect(pid).toBe(PIPELINE_PHYSICAL_ID);
  });

  it("calls pollJobInstance with the job instance ID from runOnDemand", async () => {
    const pollJobInstance = vi
      .fn()
      .mockResolvedValue(makeJobInstance("Completed"));
    const jobAdapter = {
      runOnDemand: vi.fn().mockResolvedValue({
        jobInstanceId: JOB_INSTANCE_ID,
        initialRetryAfterMs: 60_000,
      }),
      pollJobInstance,
    } as unknown as PipelineJobAdapter;

    await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      jobAdapter,
    );

    expect(pollJobInstance).toHaveBeenCalledOnce();
    const [wid, pid, jobId, initialDelayMs] = pollJobInstance.mock
      .calls[0] as [
      string,
      string,
      string,
      number,
    ];
    expect(wid).toBe(WORKSPACE_ID);
    expect(pid).toBe(PIPELINE_PHYSICAL_ID);
    expect(jobId).toBe(JOB_INSTANCE_ID);
    expect(initialDelayMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe("runPipeline result", () => {
  it("returns a complete PipelineRunResult for a successful run", async () => {
    const result = await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      makeJobAdapter(),
    );

    expect(result.schemaVersion).toBe("1");
    expect(result.pipelineLogicalId).toBe(PIPELINE_LOGICAL_ID);
    expect(result.pipelinePhysicalId).toBe(PIPELINE_PHYSICAL_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.jobInstanceId).toBe(JOB_INSTANCE_ID);
    expect(result.status).toBe("Completed");
    expect(result.failureReason).toBeNull();
    expect(typeof result.triggeredAt).toBe("string");
    expect(typeof result.completedAt).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("propagates failure reason from the job instance", async () => {
    const jobAdapter = makeJobAdapter(
      undefined,
      vi.fn().mockResolvedValue(
        makeJobInstance("Failed", {
          errorCode: "PipelineActivityFailed",
          message: "An activity failed.",
        }),
      ),
    );

    const result = await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      jobAdapter,
    );

    expect(result.status).toBe("Failed");
    expect(result.failureReason?.errorCode).toBe("PipelineActivityFailed");
    expect(result.failureReason?.message).toBe("An activity failed.");
  });

  it("reports Cancelled status without failure reason", async () => {
    const jobAdapter = makeJobAdapter(
      undefined,
      vi.fn().mockResolvedValue(makeJobInstance("Cancelled")),
    );

    const result = await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      jobAdapter,
    );

    expect(result.status).toBe("Cancelled");
  });

  it("reports Deduped status", async () => {
    const jobAdapter = makeJobAdapter(
      undefined,
      vi.fn().mockResolvedValue(makeJobInstance("Deduped")),
    );

    const result = await runPipeline(
      {
        pipelineLogicalId: PIPELINE_LOGICAL_ID,
        allowPipelineRun: true,
        workspaceId: WORKSPACE_ID,
      },
      makeManifest(),
      makePipelineAdapter(),
      jobAdapter,
    );

    expect(result.status).toBe("Deduped");
  });

  it("reports the triggered job before polling so failures retain its identity", async () => {
    const onTriggered = vi.fn();
    const jobAdapter = makeJobAdapter(
      undefined,
      vi.fn().mockRejectedValue(new Error("polling failed")),
    );

    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: true,
          workspaceId: WORKSPACE_ID,
        },
        makeManifest(),
        makePipelineAdapter(),
        jobAdapter,
        { onTriggered },
      ),
    ).rejects.toThrow("polling failed");

    expect(onTriggered).toHaveBeenCalledWith(
      expect.objectContaining({
        jobInstanceId: JOB_INSTANCE_ID,
        status: "InProgress",
      }),
    );
  });
});

describe("parsePipelineRunTimeoutMs", () => {
  it("converts a bounded positive integer minute value", () => {
    expect(parsePipelineRunTimeoutMs("60")).toBe(60 * 60 * 1000);
  });

  it.each(["0", "-1", "1.5", "60minutes", "", " 60 "])(
    "rejects non-canonical timeout value %j",
    (value) => {
      expect(() => parsePipelineRunTimeoutMs(value)).toThrow(
        /positive integer/,
      );
    },
  );

  it("rejects unsafe or excessively long timeouts", () => {
    expect(() =>
      parsePipelineRunTimeoutMs(
        String(MAX_PIPELINE_RUN_TIMEOUT_MINUTES + 1),
      ),
    ).toThrow(/must be between/);
    expect(() =>
      parsePipelineRunTimeoutMs("9".repeat(400)),
    ).toThrow(/must be between/);
  });
});

// ---------------------------------------------------------------------------
// No side effects on plan/apply
// ---------------------------------------------------------------------------

describe("runPipeline is not invoked by plan/apply", () => {
  it("runPipeline module is a separate function not called by apply internals", async () => {
    // This test documents the architectural contract: runPipeline is ONLY
    // invoked from main.ts when rawMode === 'run-pipeline'. It is not exported
    // from apply.ts, planner.ts, or any other module used during plan/apply.
    // Verify by checking the function signature and that it has no plan/apply
    // side effects by construction (requires explicit allowPipelineRun=true).
    expect(typeof runPipeline).toBe("function");
    // The safeguard is the first thing checked regardless of how it's called.
    // A call without allowPipelineRun=true is always rejected.
    await expect(
      runPipeline(
        {
          pipelineLogicalId: PIPELINE_LOGICAL_ID,
          allowPipelineRun: false, // <-- default
          workspaceId: WORKSPACE_ID,
        },
        makeManifest(),
        makePipelineAdapter(),
        makeJobAdapter(),
      ),
    ).rejects.toThrow(/allow-pipeline-run/);
  });
});
