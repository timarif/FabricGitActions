import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "22222222-2222-4222-8222-222222222222";
const LAKEHOUSE_ID = "33333333-3333-4333-8333-333333333333";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: {
    reviewTag: "tag-content",
    bronze: "lakehouse-content",
  },
  itemDirectories: {
    reviewTag: "items/tags/review",
    bronze: "items/lakehouses/bronze",
  },
  itemDefinitions: {
    reviewTag: {
      displayName: "Phase 4 Review",
      scope: { type: "Tenant" },
    },
    bronze: {
      displayName: "Bronze",
      tags: ["reviewTag"],
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
    metadata: { deploymentId: "tags" },
    workspace: { id: WORKSPACE },
    items: [
      {
        logicalId: "reviewTag",
        type: "FabricTag",
        path: "items/tags/review",
      },
      {
        logicalId: "bronze",
        type: "Lakehouse",
        path: "items/lakehouses/bronze",
        dependsOn: ["reviewTag"],
      },
    ],
  },
};

function adapters(
  tagAction: "create" | "no-op" | "blocked",
  assignmentAction: "update" | "no-op" = "update",
) {
  const unsupported = {
    plan: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
  return {
    lakehouse: {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "exists",
        observedStateHash: "lakehouse-state",
        physicalId: LAKEHOUSE_ID,
      })),
    },
    environment: unsupported,
    notebook: unsupported,
    sparkJob: unsupported,
    pipeline: unsupported,
    sparkCustomPool: unsupported,
    tags: {
      plan: vi.fn(async () => ({
        action: tagAction,
        reason: tagAction,
        observedStateHash: "tag-state",
        ...(tagAction === "no-op" ? { physicalId: TAG_ID } : {}),
      })),
      planItemAssignment: vi.fn(async () => ({
        action: assignmentAction,
        reason: assignmentAction,
        desiredTagIds: [TAG_ID],
        observedTagIds:
          assignmentAction === "no-op" ? [TAG_ID] : [],
        missingTagIds:
          assignmentAction === "update" ? [TAG_ID] : [],
        observedStateHash: "assignment-state",
      })),
    },
  };
}

describe("Fabric tag live planning", () => {
  it("plans same-deployment tag creation before a symbolic assignment", async () => {
    const runtime = adapters("create");
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const enriched = await enrichPlanWithFabric(plan, loaded, runtime);

    expect(enriched.stages).toEqual([["reviewTag"], ["bronze"]]);
    expect(enriched.items[0]).toMatchObject({
      logicalId: "reviewTag",
      action: "create",
    });
    expect(enriched.items[1]?.tagAssignment).toMatchObject({
      action: "update",
      tagLogicalIds: ["reviewTag"],
      missingTagLogicalIds: ["reviewTag"],
    });
    expect(runtime.tags.planItemAssignment).not.toHaveBeenCalled();
  });

  it("plans an additive assignment for an existing tag and item", async () => {
    const runtime = adapters("no-op", "update");
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const enriched = await enrichPlanWithFabric(plan, loaded, runtime);

    expect(runtime.tags.planItemAssignment).toHaveBeenCalledWith(
      WORKSPACE,
      LAKEHOUSE_ID,
      [TAG_ID],
    );
    expect(enriched.items[1]?.tagAssignment).toMatchObject({
      action: "update",
      missingTagLogicalIds: ["reviewTag"],
      observedStateHash: "assignment-state",
    });
  });

  it("plans a complete no-op when the desired tag is already assigned", async () => {
    const runtime = adapters("no-op", "no-op");
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const enriched = await enrichPlanWithFabric(plan, loaded, runtime);

    expect(enriched.items[1]?.tagAssignment).toMatchObject({
      action: "no-op",
      missingTagLogicalIds: [],
    });
  });

  it("blocks assignment when the desired catalog tag is blocked", async () => {
    const runtime = adapters("blocked");
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const enriched = await enrichPlanWithFabric(plan, loaded, runtime);

    expect(enriched.items[0]?.action).toBe("blocked");
    expect(enriched.items[1]?.tagAssignment).toMatchObject({
      action: "blocked",
      missingTagLogicalIds: ["reviewTag"],
    });
  });
});
