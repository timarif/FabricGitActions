import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import { createCheckpoint, writeCheckpoint } from "../src/checkpoint";
import {
  getFabricDeploymentMarker,
  hashFabricDefinition,
} from "../src/fabric/definition";
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
  itemContentHashes: { environment: "content" },
  itemDirectories: { environment: "items/environment" },
  itemDefinitions: {
    environment: { displayName: "Spark", description: "Desired" },
  },
  environmentDefinitions: {
    environment: {
      parts: [
        {
          path: "Libraries/PublicLibraries/environment.yml",
          payload: Buffer.from("dependencies: []\n").toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "Setting/Sparkcompute.yml",
          payload: Buffer.from(`
enable_native_execution_engine: false
driver_cores: 8
driver_memory: 56g
executor_cores: 8
executor_memory: 56g
dynamic_executor_allocation:
  enabled: true
  min_executors: 1
  max_executors: 8
runtime_version: 1.3
`).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    },
  },
  notebookDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "environment",
        type: "Environment",
        path: "items/environment",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
): DeploymentPlan {
  return makePlanFor(loaded, action, observedStateHash, physicalId);
}

function makePlanFor(
  loadedManifest: LoadedManifest,
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loadedManifest, {
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
  const root = mkdtempSync(path.join(tmpdir(), "fabric-environment-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  return {
    plan: vi.fn(async () => ({
      action: "create" as const,
      reason: "unused",
      observedStateHash: "unused",
    })),
    create: vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    }),
    update: vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    }),
    resumeCreate: vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    }),
    verify: vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    }),
  };
}

function environmentAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash = plannedAction === "create" ? "absent" : "observed",
  physicalId = "environment-existing",
  stagedMarker: string | undefined =
    plannedAction === "update"
      ? getFabricDeploymentMarker(
          loaded.environmentDefinitions.environment!,
        )
      : undefined,
  stagedDefinitionHash: string | undefined = stagedMarker,
  managedMetadataMatches = true,
  publishState?: string,
  targetVersion?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedMarker ? { stagedDeploymentMarker: stagedMarker } : {}),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches,
      ...(publishState ? { publishState } : {}),
      ...(targetVersion ? { targetVersion } : {}),
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["environmentDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("environment-created");
        return {
          id: "environment-created",
          displayName: "Spark",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["environmentDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateSubmitting?: () => void,
      ) => {
        onUpdateSubmitting?.();
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "Spark",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["environmentDefinitions"][string],
        _operation: { operationId?: string; location?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("environment-created");
        return {
          id: "environment-created",
          displayName: "Spark",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Spark",
      description: "Desired",
    })),
  };
}

describe("guarded Environment apply", () => {
  it("creates and checkpoints a published Environment", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = environmentAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.environment,
      loaded.environmentDefinitions.environment,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8")).completedItems
        .environment.physicalId,
    ).toBe("environment-created");
  });

  it("updates an Environment only through the Environment adapter", async () => {
    const plan = makePlan("update", "before", "environment-existing");
    const output = files();
    const adapter = environmentAdapter(
      "update",
      "before",
      "environment-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledWith(
      "workspace",
      "environment-existing",
      loaded.itemDefinitions.environment,
      loaded.environmentDefinitions.environment,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("finishes an interrupted Environment create when discovery finds an unpublished item", async () => {
    const approvedPlan = makePlan("create", "absent");
    const currentPlan = makePlan(
      "update",
      "partially-created",
      "environment-created",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingCreates.environment = {
      logicalId: "environment",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "partially-created",
      "environment-created",
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("preflights every item before mutating Environment recovery state", async () => {
    const withUnsupported: LoadedManifest = {
      ...loaded,
      itemContentHashes: {
        ...loaded.itemContentHashes,
        sparkJob: "spark-job-content",
      },
      itemDirectories: {
        ...loaded.itemDirectories,
        sparkJob: "items/spark-job",
      },
      itemDefinitions: {
        ...loaded.itemDefinitions,
        sparkJob: { displayName: "Spark Job" },
      },
      manifest: {
        ...loaded.manifest,
        items: [
          ...loaded.manifest.items,
          {
            logicalId: "sparkJob",
            type: "SparkJobDefinition",
            path: "items/spark-job",
          },
        ],
      },
    };
    const approvedPlan = buildPlan(withUnsupported, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    approvedPlan.items[0] = {
      ...approvedPlan.items[0]!,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(approvedPlan);
    const current = rehashPlan({
      ...approved,
      items: approved.items.map((item) =>
        item.logicalId === "environment"
          ? {
              ...item,
              action: "update" as const,
              reason: "partially created",
              physicalId: "environment-created",
              observedStateHash: "partial",
            }
          : item,
      ),
    });
    const output = files();
    const checkpoint = createCheckpoint(approved);
    checkpoint.pendingCreates.environment = {
      logicalId: "environment",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "partial",
      "environment-created",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: withUnsupported,
        lakehouseAdapter: lakehouseAdapter(),
        environmentAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("Apply is not implemented");

    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("resumes an accepted Environment create operation before continuing", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingOperations.environment = {
      logicalId: "environment",
      action: "create",
      operationId: "operation-1",
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.resumeCreate).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.environment,
      loaded.environmentDefinitions.environment,
      { operationId: "operation-1" },
      expect.any(Function),
    );
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("retries an interrupted Environment update until it verifies as no-op", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const currentPlan = makePlan(
      "update",
      "partially-updated",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "partially-updated",
      "environment-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("fails closed when interrupted Environment drift has no deployment marker", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const currentPlan = makePlan(
      "update",
      "unproven-drift",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "unproven-drift",
      "environment-existing",
      "",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        environmentAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");

    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("fails closed when staged content changed after the deployment marker was written", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const currentPlan = makePlan(
      "update",
      "concurrent-drift",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const marker = getFabricDeploymentMarker(
      loaded.environmentDefinitions.environment!,
    );
    const adapter = environmentAdapter(
      "update",
      "concurrent-drift",
      "environment-existing",
      marker,
      "different-staged-definition",
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        environmentAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");

    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("fails closed when concurrent metadata drift remains after staging", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-drift",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const marker = getFabricDeploymentMarker(
      loaded.environmentDefinitions.environment!,
    );
    const adapter = environmentAdapter(
      "update",
      "metadata-drift",
      "environment-existing",
      marker,
      marker,
      false,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        environmentAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");

    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("can safely reissue an update when the live state still matches the approved pre-state", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "before",
      "environment-existing",
      "",
      "",
      false,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan: approvedPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted metadata update only when its checkpointed definition and publish state still match", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "environment-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-applied",
      "environment-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "a".repeat(64);
    checkpoint.pendingUpdates.environment = {
      logicalId: "environment",
      action: "update",
      physicalId: "environment-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
      publishState: "Success",
      targetVersion: "version-1",
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = environmentAdapter(
      "update",
      "metadata-applied",
      "environment-existing",
      "",
      stagedDefinitionHash,
      true,
      "Success",
      "version-1",
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("recovers a partially created Environment without Spark settings from its exact staged definition", async () => {
    const withoutSpark: LoadedManifest = {
      ...loaded,
      environmentDefinitions: {
        environment: {
          parts: [
            loaded.environmentDefinitions.environment!.parts[0]!,
          ],
        },
      },
    };
    const approvedPlan = makePlanFor(
      withoutSpark,
      "create",
      "absent",
    );
    const currentPlan = makePlanFor(
      withoutSpark,
      "update",
      "partially-created",
      "environment-created",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingCreates.environment = {
      logicalId: "environment",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const desiredDefinition =
      withoutSpark.environmentDefinitions.environment!;
    const stagedDefinitionHash = hashFabricDefinition(
      desiredDefinition,
      false,
    );
    const adapter = environmentAdapter(
      "update",
      "partially-created",
      "environment-created",
      "",
      stagedDefinitionHash,
      true,
      "Success",
      "version-1",
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: withoutSpark,
      lakehouseAdapter: lakehouseAdapter(),
      environmentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
    expect(adapter.create).not.toHaveBeenCalled();
  });
});
