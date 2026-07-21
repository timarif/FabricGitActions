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
import { hashEventstreamDefinition } from "../src/fabric/eventstream-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const eventstreamDefinition = {
  parts: [
    {
      path: "eventstream.json",
      payload: Buffer.from(
        JSON.stringify({
          compatibilityLevel: "1.1",
          sources: [],
          destinations: [],
          operators: [],
          streams: [],
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
  itemContentHashes: { eventstream: "content" },
  itemDirectories: { eventstream: "items/eventstream" },
  itemDefinitions: {
    eventstream: { displayName: "Telemetry Stream", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  eventstreamDefinitions: { eventstream: eventstreamDefinition },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "eventstream-sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "eventstream",
        type: "Eventstream",
        path: "items/eventstream",
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
    path.join(tmpdir(), "fabric-eventstream-apply-"),
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

function eventstreamAdapter(
  plannedAction: "create" | "update" | "no-op",
  observedStateHash: string,
  physicalId = "es-existing",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        _definition: unknown,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("es-created");
        return {
          id: "es-created",
          displayName: "Telemetry Stream",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspaceId: string,
        eventstreamId: string,
        _desired: ItemDefinition,
        _definition: unknown,
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
          stagedDefinitionHash: hashEventstreamDefinition(
            eventstreamDefinition,
            false,
            false,
          ),
        });
        onMutationAccepted?.(eventstreamId);
        return {
          id: eventstreamId,
          displayName: "Telemetry Stream",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspaceId: string,
        _desired: ItemDefinition,
        _definition: unknown,
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("es-created");
        return {
          id: "es-created",
          displayName: "Telemetry Stream",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(
      async (_workspaceId: string, eventstreamId: string) => ({
        id: eventstreamId,
        displayName: "Telemetry Stream",
        description: "Desired",
      }),
    ),
  };
}

describe("guarded Eventstream apply", () => {
  it("blocks create when allow-create is false", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = eventstreamAdapter("create", "absent");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        eventstreamAdapter: adapter,
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-create is false");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("blocks update when allow-update is false", async () => {
    const plan = makePlan("update", "before", "es-existing");
    const output = files();
    const adapter = eventstreamAdapter(
      "update",
      "before",
      "es-existing",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: unusedLakehouseAdapter(),
        eventstreamAdapter: adapter,
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-update is false");
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("creates and checkpoints an Eventstream behind allow-create", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = eventstreamAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventstreamAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledOnce();
    expect(existsSync(output.checkpointFile)).toBe(true);
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .completedItems.eventstream.physicalId,
    ).toBe("es-created");
  });

  it("resumes an accepted Eventstream create without reissuing it", async () => {
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
          eventstream: {
            logicalId: "eventstream",
            action: "create",
            operationId: "operation-1",
            acceptedAt: new Date().toISOString(),
          },
        },
      }),
      "utf8",
    );
    const adapter = eventstreamAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventstreamAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.resumeCreate).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.eventstream,
      eventstreamDefinition,
      { operationId: "operation-1" },
      expect.any(Function),
    );
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("resumes a pending create found already published (no-op) without recreating it", async () => {
    const approvedPlan = makePlan("create", "absent");
    const currentPlan = makePlan("create", "absent");
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingCreates.eventstream = {
      logicalId: "eventstream",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = eventstreamAdapter("no-op", "already-created", "es-created");

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventstreamAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.verify).toHaveBeenCalled();
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("recovers an interrupted definition update", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "es-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "es-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = hashEventstreamDefinition(
      eventstreamDefinition,
      false,
      false,
    );
    checkpoint.pendingUpdates.eventstream = {
      logicalId: "eventstream",
      action: "update",
      physicalId: "es-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = eventstreamAdapter(
      "update",
      "metadata-updated",
      "es-existing",
      stagedDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: unusedLakehouseAdapter(),
      eventstreamAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});
