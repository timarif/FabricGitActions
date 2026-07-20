import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { eventhouse: "content" },
  itemDirectories: { eventhouse: "items/eventhouse" },
  itemDefinitions: {
    eventhouse: {
      displayName: "Telemetry",
      description: "Events",
      minimumConsumptionUnits: 2.25,
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
    metadata: { deploymentId: "eventhouse-sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "eventhouse",
        type: "Eventhouse",
        path: "items/eventhouse",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash: string,
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
    path.join(tmpdir(), "fabric-eventhouse-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function unusedLakehouseAdapter() {
  const fail = vi.fn(async () => {
    throw new Error("Lakehouse adapter should not be called.");
  });
  return {
    plan: fail,
    create: fail,
    update: fail,
    resumeCreate: fail,
    verify: fail,
  };
}

function eventhouseAdapter(
  plannedAction: "create" | "update" | "no-op",
  observedStateHash: string,
  physicalId = "eh-existing",
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
    })),
    create: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("eh-created");
        return {
          id: "eh-created",
          displayName: "Telemetry",
          properties: { minimumConsumptionUnits: 2.25 },
        };
      },
    ),
    update: vi.fn(
      async (
        _workspaceId: string,
        eventhouseId: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onMutationAccepted?.(eventhouseId);
        return {
          id: eventhouseId,
          displayName: "Telemetry",
          properties: { minimumConsumptionUnits: 2.25 },
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("eh-created");
        return {
          id: "eh-created",
          displayName: "Telemetry",
          properties: { minimumConsumptionUnits: 2.25 },
        };
      },
    ),
    verify: vi.fn(
      async (_workspaceId: string, eventhouseId: string) => ({
        id: eventhouseId,
        displayName: "Telemetry",
        properties: { minimumConsumptionUnits: 2.25 },
      }),
    ),
  };
}

describe("guarded Eventhouse apply", () => {
  it("creates and checkpoints an Eventhouse behind allow-create", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = eventhouseAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventhouseAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(existsSync(output.checkpointFile)).toBe(true);
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .completedItems.eventhouse.physicalId,
    ).toBe("eh-created");
  });

  it("uses the generic update safeguard for Eventhouse metadata", async () => {
    const plan = makePlan("update", "before", "eh-existing");
    const output = files();
    const adapter = eventhouseAdapter(
      "update",
      "before",
      "eh-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventhouseAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledWith(
      "workspace",
      "eh-existing",
      loaded.itemDefinitions.eventhouse,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("resumes an accepted Eventhouse create without reissuing it", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    writeFileSync(
      output.checkpointFile,
      JSON.stringify({
        schemaVersion: "1",
        deploymentId: plan.deploymentId,
        workspaceId: plan.workspaceId,
        environment: plan.environment,
        planHash: plan.planHash,
        sourceCommit: plan.sourceCommit,
        completedItems: {},
        pendingOperations: {
          eventhouse: {
            logicalId: "eventhouse",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const adapter = eventhouseAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventhouseAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.resumeCreate).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.eventhouse,
      { operationId: "operation-1" },
      expect.any(Function),
    );
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguously completed Eventhouse metadata update", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "eh-existing",
    );
    const currentPlan = makePlan(
      "no-op",
      "after",
      "eh-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.eventhouse = {
      logicalId: "eventhouse",
      action: "update",
      physicalId: "eh-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = eventhouseAdapter(
      "no-op",
      "after",
      "eh-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventhouseAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.verify).toHaveBeenCalledWith(
      "workspace",
      "eh-existing",
      loaded.itemDefinitions.eventhouse,
    );
    expect(adapter.update).not.toHaveBeenCalled();
  });
});
