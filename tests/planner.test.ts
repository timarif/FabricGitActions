import { describe, expect, it } from "vitest";

import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const loadedManifest: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { lakehouse: "content-v1" },
  itemDirectories: { lakehouse: "items/lakehouse" },
  itemDefinitions: {
    lakehouse: {
      displayName: "Lakehouse",
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace-1" },
    items: [
      {
        logicalId: "lakehouse",
        type: "Lakehouse",
        path: "items/lakehouse",
      },
    ],
  },
};

describe("deployment planner", () => {
  it("creates a deterministic plan hash", () => {
    const first = buildPlan(loadedManifest, {
      mode: "plan",
      environment: "dev",
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const second = buildPlan(loadedManifest, {
      mode: "plan",
      environment: "dev",
      now: new Date("2026-02-01T00:00:00Z"),
    });

    expect(first.planHash).toBe(second.planHash);
    expect(first.generatedAt).not.toBe(second.generatedAt);
    expect(first.stages).toEqual([["lakehouse"]]);
    expect(first.items[0]?.contentHash).toBe("content-v1");
    expect(first.items[0]?.displayName).toBe("Lakehouse");
  });

  it("lets the action input override the manifest workspace", () => {
    const plan = buildPlan(loadedManifest, {
      mode: "validate",
      environment: "test",
      workspaceId: "workspace-2",
    });

    expect(plan.workspaceId).toBe("workspace-2");
    expect(plan.environment).toBe("test");
  });

  it("changes the plan hash when deployable item content changes", () => {
    const first = buildPlan(loadedManifest, {
      mode: "plan",
      environment: "dev",
    });
    const second = buildPlan(
      {
        ...loadedManifest,
        itemContentHashes: { lakehouse: "content-v2" },
      },
      {
        mode: "plan",
        environment: "dev",
      },
    );

    expect(first.planHash).not.toBe(second.planHash);
  });

  it("builds a deterministic pending target for a managed workspace", () => {
    const managed: LoadedManifest = {
      ...loadedManifest,
      manifest: {
        ...loadedManifest.manifest,
        workspace: {
          displayName: "tva-Analytics",
          description: "Managed workspace",
          capacityId: "capacity-1",
        },
        items: [],
      },
      itemContentHashes: {},
      itemDirectories: {},
      itemDefinitions: {},
    };

    const plan = buildPlan(managed, {
      mode: "plan",
      environment: "dev",
    });

    expect(plan.workspaceId).toMatch(/^pending:[a-f0-9]{64}$/);
    expect(plan.workspace).toMatchObject({
      displayName: "tva-Analytics",
      action: "unknown",
    });
    expect(plan.stages).toEqual([]);
    expect(plan.items).toEqual([]);
  });
});
