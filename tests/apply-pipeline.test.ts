import {
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { hashPipelineDefinition } from "../src/fabric/pipeline-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const pipelineDefinition = {
  parts: [
    {
      path: "pipeline-content.json",
      payload: Buffer.from(
        JSON.stringify({
          properties: {
            activities: [],
          },
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { pipeline: "content" },
  itemDirectories: { pipeline: "items/pipeline" },
  itemDefinitions: {
    pipeline: { displayName: "Pipeline", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: { pipeline: pipelineDefinition },
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "pipeline",
        type: "DataPipeline",
        path: "items/pipeline",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash,
    ...(physicalId ? { physicalId } : {}),
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-pipeline-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  const fail = async () => {
    throw new Error("Lakehouse adapter should not be called.");
  };
  return {
    plan: vi.fn(fail),
    create: vi.fn(fail),
    update: vi.fn(fail),
    resumeCreate: vi.fn(fail),
    verify: vi.fn(fail),
  };
}

function pipelineAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash =
    plannedAction === "create" ? "absent" : "observed",
  physicalId = "pipeline-existing",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash
        ? { stagedDefinitionHash }
        : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["pipelineDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("pipeline-created");
        return {
          id: "pipeline-created",
          displayName: "Pipeline",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["pipelineDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateCheckpoint?: (state?: {
          phase:
            | "metadata-submitting"
            | "metadata-updated"
            | "definition-staged";
          stagedDefinitionHash: string;
        }) => void,
      ) => {
        onUpdateCheckpoint?.({
          phase: "metadata-submitting",
          stagedDefinitionHash: "a".repeat(64),
        });
        onUpdateCheckpoint?.({
          phase: "definition-staged",
          stagedDefinitionHash: hashPipelineDefinition(
            pipelineDefinition,
            false,
          ),
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "Pipeline",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["pipelineDefinitions"][string],
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("pipeline-created");
        return {
          id: "pipeline-created",
          displayName: "Pipeline",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Pipeline",
      description: "Desired",
    })),
  };
}

describe("guarded Data Pipeline apply", () => {
  it("creates and checkpoints a Data Pipeline", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = pipelineAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      pipelineAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems.pipeline.physicalId,
    ).toBe("pipeline-created");
  });

  it("updates through the Data Pipeline adapter", async () => {
    const plan = makePlan(
      "update",
      "before",
      "pipeline-existing",
    );
    const output = files();
    const adapter = pipelineAdapter(
      "update",
      "before",
      "pipeline-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      pipelineAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("verifies a no-op Data Pipeline", async () => {
    const plan = makePlan(
      "no-op",
      "observed",
      "pipeline-existing",
    );
    const output = files();
    const adapter = pipelineAdapter(
      "no-op",
      "observed",
      "pipeline-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      pipelineAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted definition update", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "pipeline-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "pipeline-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.pipeline = {
      logicalId: "pipeline",
      action: "update",
      physicalId: "pipeline-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = pipelineAdapter(
      "update",
      "metadata-updated",
      "pipeline-existing",
      stagedDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      pipelineAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});
