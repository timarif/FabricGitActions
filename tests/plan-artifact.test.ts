import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadApprovedPlan } from "../src/plan-artifact";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

function createPlan() {
  const loaded: LoadedManifest = {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: { lakehouse: "content" },
    itemDirectories: { lakehouse: "items/lakehouse" },
    itemDefinitions: { lakehouse: { displayName: "Bronze" } },
    environmentDefinitions: {},
    notebookDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "sample" },
      workspace: { id: "workspace" },
      items: [
        {
          logicalId: "lakehouse",
          type: "Lakehouse",
          path: "items/lakehouse",
        },
      ],
    },
  };
  return buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
}

describe("approved plan loading", () => {
  it("loads a valid approved plan", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    writeFileSync(planPath, JSON.stringify(plan), "utf8");

    expect(loadApprovedPlan(planPath).planHash).toBe(plan.planHash);
  });

  it("rejects a plan changed after hashing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items[0]!.displayName = "Tampered";
    writeFileSync(planPath, JSON.stringify(plan), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "Approved plan hash is invalid",
    );
  });

  it("rejects items omitted from deployment stages", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items.push({
      ...plan.items[0]!,
      logicalId: "unreachable",
    });
    const rehashed = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(rehashed), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow("invalid structure");
  });
});
