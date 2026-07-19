import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertDistinctFilePaths,
  assertOutputPathOutsideItems,
  writeJobSummary,
  writePlan,
} from "../src/reporting";
import type { DeploymentPlan } from "../src/types";

const plan: DeploymentPlan = {
  schemaVersion: "1",
  mode: "plan",
  deploymentId: "sample",
  environment: "dev",
  workspaceId: "workspace-1",
  sourceHash: "source",
  resolvedHash: "resolved",
  planHash: "plan",
  generatedAt: "2026-01-01T00:00:00.000Z",
  stages: [["lakehouse"]],
  items: [
    {
      logicalId: "lakehouse",
      type: "Lakehouse",
      path: "items/lakehouse",
      dependsOn: [],
      desiredState: "present",
      contentHash: "content",
      displayName: "Lakehouse",
      action: "unknown",
      reason: "test",
    },
  ],
};

describe("plan reporting", () => {
  it("rejects plan output inside a deployable item directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const itemDirectory = path.join(root, "items/lakehouse");
    mkdirSync(itemDirectory, { recursive: true });

    expect(() =>
      writePlan(plan, path.join(itemDirectory, "fabric-plan.json"), [
        itemDirectory,
      ]),
    ).toThrow("Plan file must not be written inside a deployable item directory");
  });

  it("rejects output inside a declared item directory that does not exist yet", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const itemDirectory = path.join(root, "items", "future");

    expect(() =>
      assertOutputPathOutsideItems(
        path.join(itemDirectory, "checkpoint.json"),
        [itemDirectory],
        "Checkpoint file",
      ),
    ).toThrow(
      "Checkpoint file must not be written inside a deployable item directory",
    );
  });

  it("rejects deployment artifacts that resolve to the same path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const artifact = path.join(root, "artifact.json");

    expect(() =>
      assertDistinctFilePaths([
        { label: "Approved plan file", filePath: artifact },
        { label: "Current plan file", filePath: artifact },
      ]),
    ).toThrow("must not use the same path");
  });

  it("rejects dangling symbolic links in output paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const linkPath = path.join(root, "plan-link.json");
    const missingTarget = path.join(root, "missing", "plan.json");
    try {
      symlinkSync(missingTarget, linkPath, "file");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EPERM"
      ) {
        return;
      }
      throw error;
    }

    expect(() => writePlan(plan, linkPath)).toThrow(
      "contains a dangling symbolic link",
    );
  });

  it("renders network protection surfaces in the job summary", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-summary-"));
    const summaryFile = path.join(root, "summary.md");
    writeFileSync(summaryFile, "", "utf8");
    const previousEnv = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summaryFile;
    try {
      await writeJobSummary({
        ...plan,
        networkProtection: {
          workspaceId: "workspace-1",
          communicationPolicy: {
            action: "update",
            reason: "Outbound default action differs.",
            desiredHash: "a".repeat(64),
            observedStateHash: "b".repeat(64),
            desiredInboundDefaultAction: "Allow",
            desiredOutboundDefaultAction: "Deny",
            observedInboundDefaultAction: "Allow",
            observedOutboundDefaultAction: "Allow",
            isRelaxation: false,
          },
          outboundCloudConnectionRules: {
            action: "update",
            reason: "Outbound access protection is not yet enabled.",
            desiredHash: "c".repeat(64),
          },
        },
      });
    } finally {
      if (previousEnv === undefined) {
        delete process.env.GITHUB_STEP_SUMMARY;
      } else {
        process.env.GITHUB_STEP_SUMMARY = previousEnv;
      }
    }

    const content = readFileSync(summaryFile, "utf8");
    expect(content).toContain("Network protection");
    expect(content).toContain("Communication policy");
    expect(content).toContain("inbound Allow, outbound Deny");
    expect(content).toContain("Outbound cloud connection rules");
  });
});
