import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
} from "../src/types";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const TAG_ID = "22222222-2222-4222-8222-222222222222";
const LAKEHOUSE_ID = "33333333-3333-4333-8333-333333333333";
const ASSIGNMENT_HASH = "a".repeat(64);

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
  semanticModelDefinitions: {},
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

function assignmentPlan(action: "update" | "no-op"): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit",
  });
  plan.items = plan.items.map((item) =>
    item.logicalId === "reviewTag"
      ? {
          ...item,
          action: "no-op",
          reason: "exists",
          observedStateHash: "tag-state",
          physicalId: TAG_ID,
        }
      : {
          ...item,
          action: "no-op",
          reason: "exists",
          observedStateHash: "lakehouse-state",
          physicalId: LAKEHOUSE_ID,
          tagAssignment: {
            assignmentHash: ASSIGNMENT_HASH,
            tagLogicalIds: ["reviewTag"],
            missingTagLogicalIds:
              action === "update" ? ["reviewTag"] : [],
            action,
            observedStateHash:
              action === "update" ? "tags-absent" : "tags-present",
            reason: action,
          },
        },
  );
  return rehashPlan(plan);
}

function tagOnlyPlan(action: "create" | "no-op"): {
  loaded: LoadedManifest;
  plan: DeploymentPlan;
} {
  const tagLoaded: LoadedManifest = {
    ...loaded,
    itemContentHashes: { reviewTag: "tag-content" },
    itemDirectories: { reviewTag: "items/tags/review" },
    itemDefinitions: { reviewTag: loaded.itemDefinitions.reviewTag! },
    manifest: {
      ...loaded.manifest,
      items: [loaded.manifest.items[0]!],
    },
  };
  const plan = buildPlan(tagLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash: action === "create" ? "absent" : "tag-state",
    ...(action === "no-op" ? { physicalId: TAG_ID } : {}),
  };
  return { loaded: tagLoaded, plan: rehashPlan(plan) };
}

function files() {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-tag-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  return {
    plan: vi.fn(async () => ({
      action: "no-op" as const,
      reason: "exists",
      observedStateHash: "lakehouse-state",
      physicalId: LAKEHOUSE_ID,
    })),
    create: vi.fn(),
    update: vi.fn(),
    resumeCreate: vi.fn(),
    verify: vi.fn(
      async (
        _workspaceId: string,
        physicalId: string,
        desired: ItemDefinition,
      ) => ({
        id: physicalId,
        displayName: desired.displayName,
      }),
    ),
  };
}

function tagAdapter(options: {
  assigned?: boolean;
  exists?: boolean;
  failAfterAssign?: boolean;
  failAfterCreate?: boolean;
} = {}) {
  let assigned = options.assigned ?? false;
  let exists = options.exists ?? true;
  let failAfterAssign = options.failAfterAssign ?? false;
  let failAfterCreate = options.failAfterCreate ?? false;
  return {
    plan: vi.fn(async () => ({
      action: exists ? ("no-op" as const) : ("create" as const),
      reason: exists ? "exists" : "absent",
      observedStateHash: exists ? "tag-state" : "absent",
      ...(exists ? { physicalId: TAG_ID } : {}),
    })),
    create: vi.fn(async () => {
      exists = true;
      if (failAfterCreate) {
        failAfterCreate = false;
        throw new Error("ambiguous tag create");
      }
      return {
        id: TAG_ID,
        displayName: "Phase 4 Review",
        scope: { type: "Tenant" as const },
      };
    }),
    verify: vi.fn(async () => {
      if (!exists) {
        throw new Error("tag missing");
      }
      return {
        id: TAG_ID,
        displayName: "Phase 4 Review",
        scope: { type: "Tenant" as const },
      };
    }),
    planItemAssignment: vi.fn(async () => ({
      action: assigned ? ("no-op" as const) : ("update" as const),
      reason: assigned ? "assigned" : "missing",
      desiredTagIds: [TAG_ID],
      observedTagIds: assigned ? [TAG_ID] : [],
      missingTagIds: assigned ? [] : [TAG_ID],
      observedStateHash: assigned ? "tags-present" : "tags-absent",
    })),
    applyItemTags: vi.fn(async () => {
      assigned = true;
      if (failAfterAssign) {
        failAfterAssign = false;
        throw new Error("ambiguous tag assignment");
      }
    }),
    verifyItemAssignment: vi.fn(async () => {
      if (!assigned) {
        throw new Error("tag assignment missing");
      }
      return [TAG_ID];
    }),
  };
}

describe("Fabric tag guarded apply", () => {
  it("requires the independent tag assignment safeguard", async () => {
    const plan = assignmentPlan("update");
    const runtimeTags = tagAdapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        tagAdapter: runtimeTags,
        allowCreate: false,
        allowUpdate: false,
        allowTagAssign: false,
        ...files(),
      }),
    ).rejects.toThrow("allow-tag-assign is false");

    expect(runtimeTags.applyItemTags).not.toHaveBeenCalled();
  });

  it("applies missing tags additively and checkpoints verification", async () => {
    const plan = assignmentPlan("update");
    const runtimeTags = tagAdapter();
    const output = files();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      tagAdapter: runtimeTags,
      allowCreate: false,
      allowUpdate: false,
      allowTagAssign: true,
      ...output,
    });

    expect(runtimeTags.applyItemTags).toHaveBeenCalledWith(
      WORKSPACE,
      LAKEHOUSE_ID,
      [TAG_ID],
    );
    expect(result.items[1]).toMatchObject({
      logicalId: "bronze",
      status: "updated",
      tagAssignment: {
        assignmentHash: ASSIGNMENT_HASH,
        tagCount: 1,
        status: "updated",
      },
    });
    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    );
    expect(checkpoint.tagAssignments.bronze).toMatchObject({
      assignmentHash: ASSIGNMENT_HASH,
      itemPhysicalId: LAKEHOUSE_ID,
      tagIds: [TAG_ID],
      phase: "verified",
    });
  });

  it("recovers an ambiguous assignment without posting it twice", async () => {
    const approved = assignmentPlan("update");
    const runtimeTags = tagAdapter({ failAfterAssign: true });
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        tagAdapter: runtimeTags,
        allowCreate: false,
        allowUpdate: false,
        allowTagAssign: true,
        ...output,
      }),
    ).rejects.toThrow("ambiguous tag assignment");

    const current = assignmentPlan("no-op");
    const resumed = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: current,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      tagAdapter: runtimeTags,
      allowCreate: false,
      allowUpdate: false,
      allowTagAssign: true,
      ...output,
    });

    expect(runtimeTags.applyItemTags).toHaveBeenCalledTimes(1);
    expect(resumed.items.map((item) => item.status)).toEqual([
      "resumed",
      "resumed",
    ]);
  });

  it("requires the independent tag creation safeguard", async () => {
    const fixture = tagOnlyPlan("create");

    await expect(
      applyApprovedPlan({
        approvedPlan: fixture.plan,
        currentPlan: fixture.plan,
        loadedManifest: fixture.loaded,
        lakehouseAdapter: lakehouseAdapter(),
        tagAdapter: tagAdapter({ exists: false }),
        allowCreate: true,
        allowUpdate: false,
        allowTagCreate: false,
        ...files(),
      }),
    ).rejects.toThrow("allow-tag-create is false");
  });

  it("recovers an ambiguous tag create from the catalog", async () => {
    const fixture = tagOnlyPlan("create");
    const runtimeTags = tagAdapter({
      exists: false,
      failAfterCreate: true,
    });
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: fixture.plan,
        currentPlan: fixture.plan,
        loadedManifest: fixture.loaded,
        lakehouseAdapter: lakehouseAdapter(),
        tagAdapter: runtimeTags,
        allowCreate: true,
        allowUpdate: false,
        allowTagCreate: true,
        ...output,
      }),
    ).rejects.toThrow("ambiguous tag create");

    const current = tagOnlyPlan("no-op").plan;
    const resumed = await applyApprovedPlan({
      approvedPlan: fixture.plan,
      currentPlan: current,
      loadedManifest: fixture.loaded,
      lakehouseAdapter: lakehouseAdapter(),
      tagAdapter: runtimeTags,
      allowCreate: true,
      allowUpdate: false,
      allowTagCreate: true,
      ...output,
    });

    expect(runtimeTags.create).toHaveBeenCalledTimes(1);
    expect(resumed.items[0]).toMatchObject({
      logicalId: "reviewTag",
      status: "resumed",
      physicalId: TAG_ID,
    });
  });
});
