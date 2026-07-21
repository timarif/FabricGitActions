import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const actionCore = vi.hoisted(() => {
  const inputs = new Map<string, string>();
  return {
    inputs,
    getInput: vi.fn((name: string) => inputs.get(name) ?? ""),
    getIDToken: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    summary: {
      addHeading: vi.fn().mockReturnThis(),
      addTable: vi.fn().mockReturnThis(),
      addRaw: vi.fn().mockReturnThis(),
      write: vi.fn(),
    },
  };
});

vi.mock("@actions/core", () => actionCore);

import { PipelineAdapter } from "../src/fabric/pipeline";
import { PipelineJobAdapter } from "../src/fabric/pipeline-job";
import { run } from "../src/main";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PIPELINE_ID = "22222222-2222-4222-8222-222222222222";
const JOB_INSTANCE_ID = "33333333-3333-4333-8333-333333333333";

function createManifestFixture(): {
  manifestPath: string;
  definitionPath: string;
  resultPath: string;
} {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-main-run-pipeline-"),
  );
  const itemDirectory = path.join(
    root,
    "items",
    "pipelines",
    "sample",
  );
  const definitionDirectory = path.join(itemDirectory, "definition");
  mkdirSync(definitionDirectory, { recursive: true });
  const manifestPath = path.join(root, "deployment.yaml");
  const definitionPath = path.join(
    definitionDirectory,
    "pipeline-content.json",
  );
  const resultPath = path.join(root, "pipeline-run-result.json");
  writeFileSync(
    manifestPath,
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: run-pipeline-test
workspace:
  id: ${WORKSPACE_ID}
items:
  - logicalId: samplePipeline
    type: DataPipeline
    path: items/pipelines/sample
`,
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "item.yaml"),
    "displayName: Sample Pipeline\n",
    "utf8",
  );
  writeFileSync(
    definitionPath,
    JSON.stringify({ properties: { activities: [] } }),
    "utf8",
  );
  return { manifestPath, definitionPath, resultPath };
}

function configureInputs(
  manifestPath: string,
  resultPath: string,
): void {
  for (const [name, value] of Object.entries({
    mode: "run-pipeline",
    manifest: manifestPath,
    "workspace-id": WORKSPACE_ID,
    "pipeline-logical-id": "samplePipeline",
    "allow-pipeline-run": "true",
    "pipeline-run-timeout-minutes": "1",
    "pipeline-run-result-file": resultPath,
    "auth-mode": "service-principal-secret",
    "tenant-id": "tenant",
    "client-id": "client",
    "client-secret": "secret",
  })) {
    actionCore.inputs.set(name, value);
  }
}

function mockSuccessfulRun(): void {
  vi.spyOn(
    PipelineAdapter.prototype,
    "resolveForRun",
  ).mockResolvedValue({
    id: PIPELINE_ID,
    workspaceId: WORKSPACE_ID,
    type: "DataPipeline",
    displayName: "Sample Pipeline",
  });
  vi.spyOn(
    PipelineJobAdapter.prototype,
    "runOnDemand",
  ).mockResolvedValue({
    jobInstanceId: JOB_INSTANCE_ID,
    initialRetryAfterMs: 1,
  });
  vi.spyOn(
    PipelineJobAdapter.prototype,
    "pollJobInstance",
  ).mockResolvedValue({
    id: JOB_INSTANCE_ID,
    itemId: PIPELINE_ID,
    jobType: "execute",
    invokeType: "Manual",
    status: "Completed",
    failureReason: null,
  });
}

describe("main run-pipeline mode", () => {
  beforeEach(() => {
    actionCore.inputs.clear();
    actionCore.getInput.mockClear();
    actionCore.setFailed.mockClear();
    actionCore.setOutput.mockClear();
    actionCore.setSecret.mockClear();
    vi.restoreAllMocks();
  });

  it("writes outputs and a completed result artifact", async () => {
    const fixture = createManifestFixture();
    configureInputs(fixture.manifestPath, fixture.resultPath);
    mockSuccessfulRun();

    await run();

    expect(actionCore.setFailed).not.toHaveBeenCalled();
    expect(actionCore.setOutput).toHaveBeenCalledWith(
      "pipeline-job-instance-id",
      JOB_INSTANCE_ID,
    );
    expect(actionCore.setOutput).toHaveBeenCalledWith(
      "pipeline-job-status",
      "Completed",
    );
    expect(
      JSON.parse(readFileSync(fixture.resultPath, "utf8")),
    ).toMatchObject({
      pipelineLogicalId: "samplePipeline",
      pipelinePhysicalId: PIPELINE_ID,
      jobInstanceId: JOB_INSTANCE_ID,
      status: "Completed",
    });
  });

  it("rejects unsafe result paths before triggering a job", async () => {
    const fixture = createManifestFixture();
    configureInputs(
      fixture.manifestPath,
      fixture.definitionPath,
    );
    const runOnDemand = vi.spyOn(
      PipelineJobAdapter.prototype,
      "runOnDemand",
    );

    await run();

    expect(runOnDemand).not.toHaveBeenCalled();
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("Pipeline run result file"),
    );
  });

  it("rejects a directory result target before triggering a job", async () => {
    const fixture = createManifestFixture();
    mkdirSync(fixture.resultPath);
    configureInputs(fixture.manifestPath, fixture.resultPath);
    const runOnDemand = vi.spyOn(
      PipelineJobAdapter.prototype,
      "runOnDemand",
    );

    await run();

    expect(runOnDemand).not.toHaveBeenCalled();
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("must be a file path"),
    );
  });

  it("rejects malformed timeout input before triggering a job", async () => {
    const fixture = createManifestFixture();
    configureInputs(fixture.manifestPath, fixture.resultPath);
    actionCore.inputs.set(
      "pipeline-run-timeout-minutes",
      "60minutes",
    );
    const runOnDemand = vi.spyOn(
      PipelineJobAdapter.prototype,
      "runOnDemand",
    );

    await run();

    expect(runOnDemand).not.toHaveBeenCalled();
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("positive integer"),
    );
  });

  it("fails closed before resolving or triggering when authorization is absent", async () => {
    const fixture = createManifestFixture();
    configureInputs(fixture.manifestPath, fixture.resultPath);
    actionCore.inputs.set("allow-pipeline-run", "false");
    const resolveForRun = vi.spyOn(
      PipelineAdapter.prototype,
      "resolveForRun",
    );
    const runOnDemand = vi.spyOn(
      PipelineJobAdapter.prototype,
      "runOnDemand",
    );

    await run();

    expect(resolveForRun).not.toHaveBeenCalled();
    expect(runOnDemand).not.toHaveBeenCalled();
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("allow-pipeline-run"),
    );
  });

  it("persists the job identity when polling fails", async () => {
    const fixture = createManifestFixture();
    configureInputs(fixture.manifestPath, fixture.resultPath);
    mockSuccessfulRun();
    vi.spyOn(
      PipelineJobAdapter.prototype,
      "pollJobInstance",
    ).mockRejectedValue(new Error("polling unavailable"));

    await run();

    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("polling unavailable"),
    );
    expect(existsSync(fixture.resultPath)).toBe(true);
    expect(
      JSON.parse(readFileSync(fixture.resultPath, "utf8")),
    ).toMatchObject({
      jobInstanceId: JOB_INSTANCE_ID,
      status: "InProgress",
    });
    expect(actionCore.setOutput).toHaveBeenCalledWith(
      "pipeline-job-instance-id",
      JOB_INSTANCE_ID,
    );
  });
});
