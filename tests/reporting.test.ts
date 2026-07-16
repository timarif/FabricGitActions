import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writePlan } from "../src/reporting";
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
});
