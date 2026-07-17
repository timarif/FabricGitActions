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
import { hashSparkJobDefinition } from "../src/fabric/spark-job-definition";
import {
  materializeSparkJobDefinitionWithProof,
  validateLogicalReferenceDeclarations,
} from "../src/fabric/logical-references";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const sparkJobDefinition = {
  format: "SparkJobDefinitionV2",
  parts: [
    {
      path: "SparkJobDefinitionV1.json",
      payload: Buffer.from(
        JSON.stringify({
          executableFile: "main.py",
          additionalLibraryUris: [],
          language: "Python",
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
    {
      path: "Main/main.py",
      payload: Buffer.from("print('hello')\n").toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { sparkJob: "content" },
  itemDirectories: { sparkJob: "items/spark-job" },
  itemDefinitions: {
    sparkJob: { displayName: "Hello", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: { sparkJob: sparkJobDefinition },
  pipelineDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "sparkJob",
        type: "SparkJobDefinition",
        path: "items/spark-job",
      },
    ],
  },
};

const referencedLoaded: LoadedManifest = {
  ...loaded,
  itemContentHashes: {
    bronze: "lakehouse-content",
    sparkJob: "content",
  },
  itemDirectories: {
    bronze: "items/bronze",
    sparkJob: "items/spark-job",
  },
  itemDefinitions: {
    bronze: { displayName: "Bronze" },
    sparkJob: {
      displayName: "Hello",
      description: "Desired",
      references: { defaultLakehouse: "bronze" },
    },
  },
  manifest: {
    ...loaded.manifest,
    items: [
      {
        logicalId: "bronze",
        type: "Lakehouse",
        path: "items/bronze",
      },
      {
        logicalId: "sparkJob",
        type: "SparkJobDefinition",
        path: "items/spark-job",
        dependsOn: ["bronze"],
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

function makeReferencedPlan(
  lakehouseAction: PlannedAction,
  sparkAction: PlannedAction,
  lakehousePhysicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(referencedLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: lakehouseAction,
    reason: lakehouseAction,
    observedStateHash:
      lakehouseAction === "create" ? "absent" : "lakehouse-state",
    ...(lakehousePhysicalId
      ? { physicalId: lakehousePhysicalId }
      : {}),
  };
  plan.items[1] = {
    ...plan.items[1]!,
    action: sparkAction,
    reason: sparkAction,
    observedStateHash:
      sparkAction === "create" ? "absent" : "spark-state",
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-spark-job-apply-"),
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

function sparkJobAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash =
    plannedAction === "create" ? "absent" : "observed",
  physicalId = "spark-existing",
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
        _definition: LoadedManifest["sparkJobDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkJobDefinitions"][string],
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
          stagedDefinitionHash: hashSparkJobDefinition(
            sparkJobDefinition,
            false,
          ),
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkJobDefinitions"][string],
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Hello",
      description: "Desired",
    })),
  };
}

describe("guarded Spark Job Definition apply", () => {
  it("materializes a same-run Lakehouse ID before creating the Spark Job", async () => {
    const plan = makeReferencedPlan("create", "create");
    const output = files();
    const pendingProofs: unknown[] = [];
    const sparkAdapter = sparkJobAdapter();
    sparkAdapter.create = vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        definition: LoadedManifest["sparkJobDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        pendingProofs.push(
          JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          ).pendingCreates.sparkJob,
        );
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
          definition,
        };
      },
    );
    const lakehouse = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      })),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: (operation: {
            operationId?: string;
            location?: string;
          }) => void,
          onCreateSubmitting?: () => void,
        ) => {
          onCreateSubmitting?.();
          onMutationAccepted?.("lakehouse-created");
          return {
            id: "lakehouse-created",
            displayName: "Bronze",
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: referencedLoaded,
      lakehouseAdapter: lakehouse,
      sparkJobAdapter: sparkAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    const materializedDefinition =
      sparkAdapter.create.mock.calls[0]?.[2];
    const config = JSON.parse(
      Buffer.from(
        materializedDefinition?.parts.find(
          (part) =>
            part.path === "SparkJobDefinitionV1.json",
        )?.payload ?? "",
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(config.defaultLakehouseArtifactId).toBe(
      "lakehouse-created",
    );
    expect(pendingProofs[0]).toMatchObject({
      materializedDefinitionHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
      resolvedBindingsHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
    });
    expect(result.items.map((item) => item.status)).toEqual([
      "created",
      "created",
    ]);
  });

  it("refuses to resume a pending Spark write with different dependency IDs", async () => {
    const approvedPlan = makeReferencedPlan("create", "create");
    const currentPlan = makeReferencedPlan(
      "no-op",
      "create",
      "lakehouse-new",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: "lakehouse-new",
      completedAt: new Date().toISOString(),
    };
    const sparkItem = referencedLoaded.manifest.items[1]!;
    const bindings = validateLogicalReferenceDeclarations({
      item: sparkItem,
      definition: referencedLoaded.itemDefinitions.sparkJob!,
      itemGraph: referencedLoaded.manifest.items,
    });
    const oldProof = materializeSparkJobDefinitionWithProof(
      sparkJobDefinition,
      bindings,
      { bronze: "lakehouse-old" },
    );
    checkpoint.pendingCreates.sparkJob = {
      logicalId: "sparkJob",
      action: "create",
      submittedAt: new Date().toISOString(),
      materializedDefinitionHash:
        oldProof.materializedDefinitionHash,
      resolvedBindingsHash: oldProof.resolvedBindingsHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: referencedLoaded,
        lakehouseAdapter: lakehouseAdapter(),
        sparkJobAdapter: sparkJobAdapter(),
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow(
      "materialized with different dependency IDs",
    );
  });

  it("creates and checkpoints a Spark Job Definition", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = sparkJobAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.sparkJob,
      sparkJobDefinition,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems.sparkJob.physicalId,
    ).toBe("spark-created");
  });

  it("updates through the Spark Job Definition adapter", async () => {
    const plan = makePlan(
      "update",
      "before",
      "spark-existing",
    );
    const output = files();
    const adapter = sparkJobAdapter(
      "update",
      "before",
      "spark-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("verifies a no-op Spark Job Definition", async () => {
    const plan = makePlan(
      "no-op",
      "observed",
      "spark-existing",
    );
    const output = files();
    const adapter = sparkJobAdapter(
      "no-op",
      "observed",
      "spark-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
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
      "spark-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "spark-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.sparkJob = {
      logicalId: "sparkJob",
      action: "update",
      physicalId: "spark-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = sparkJobAdapter(
      "update",
      "metadata-updated",
      "spark-existing",
      stagedDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});
