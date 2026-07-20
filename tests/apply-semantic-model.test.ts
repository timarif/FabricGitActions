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
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { hashSemanticModelDefinition } from "../src/fabric/semantic-model-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const semanticModelDefinition = {
  format: "TMSL",
  parts: [
    {
      path: "model.bim",
      payload: Buffer.from(
        JSON.stringify({
          compatibilityLevel: 1702,
          model: { culture: "en-US", tables: [] },
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
    {
      path: "definition.pbism",
      payload: Buffer.from(
        JSON.stringify({ version: "5.0", settings: {} }),
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
  itemContentHashes: { semanticModel: "content" },
  itemDirectories: {
    semanticModel: "items/semantic-model",
  },
  itemDefinitions: {
    semanticModel: {
      displayName: "Sales",
      description: "Desired",
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {
    semanticModel: semanticModelDefinition,
  },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "semantic-model" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "semanticModel",
        type: "SemanticModel",
        path: "items/semantic-model",
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
    path.join(tmpdir(), "fabric-semantic-model-apply-"),
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

function semanticModelAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash =
    plannedAction === "create" ? "absent" : "observed",
  physicalId = "semantic-model-existing",
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
        _definition: LoadedManifest["semanticModelDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("semantic-model-created");
        return {
          id: "semantic-model-created",
          displayName: "Sales",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["semanticModelDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateCheckpoint?: (state?: {
          phase:
            | "metadata-submitting"
            | "metadata-updated"
            | "definition-submitting"
            | "definition-staged";
          stagedDefinitionHash: string;
          preservedAuxiliaryHash?: string;
        }) => void,
      ) => {
        onUpdateCheckpoint?.({
          phase: "metadata-submitting",
          stagedDefinitionHash: "a".repeat(64),
        });
        onUpdateCheckpoint?.({
          phase: "definition-submitting",
          stagedDefinitionHash: "a".repeat(64),
          preservedAuxiliaryHash: "c".repeat(64),
        });
        onUpdateCheckpoint?.({
          phase: "definition-staged",
          stagedDefinitionHash:
            hashSemanticModelDefinition(
              semanticModelDefinition,
              false,
              false,
            ),
          preservedAuxiliaryHash: "c".repeat(64),
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "Sales",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["semanticModelDefinitions"][string],
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("semantic-model-created");
        return {
          id: "semantic-model-created",
          displayName: "Sales",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Sales",
      description: "Desired",
    })),
  };
}

describe("guarded Semantic Model apply", () => {
  it("creates and checkpoints a Semantic Model", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = semanticModelAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems.semanticModel.physicalId,
    ).toBe("semantic-model-created");
  });

  it("updates through the Semantic Model adapter", async () => {
    const plan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const output = files();
    const adapter = semanticModelAdapter(
      "update",
      "before",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("verifies a no-op Semantic Model", async () => {
    const plan = makePlan(
      "no-op",
      "observed",
      "semantic-model-existing",
    );
    const output = files();
    const adapter = semanticModelAdapter(
      "no-op",
      "observed",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted full-definition update with approved checkpoint proof", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = semanticModelAdapter(
      "update",
      "metadata-updated",
      "semantic-model-existing",
      stagedDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("retries a definition-submitting update when the baseline definition remains", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const baselineDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-submitting",
      stagedDefinitionHash: baselineDefinitionHash,
      preservedAuxiliaryHash: "c".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = semanticModelAdapter(
      "update",
      "metadata-updated",
      "semantic-model-existing",
      baselineDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("reasserts allow-update before recovery dispatch", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash: "b".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = semanticModelAdapter(
      "update",
      "metadata-updated",
      "semantic-model-existing",
      "b".repeat(64),
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        semanticModelAdapter: adapter,
        allowCreate: false,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("allow-update is false");
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("blocks no-op recovery when the checkpointed auxiliary parts were lost", async () => {
    // Simulate: a "definition-staged" checkpoint was written with a
    // preservedAuxiliaryHash. On recovery, the live plan returns a DIFFERENT
    // currentAuxiliaryHash — meaning the preserved aux parts were silently lost.
    // hasSemanticModelRecoveryProof must return false, causing a
    // "cannot be reconciled" throw rather than a silent incorrect resume.
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);

    // Compute the exact hash that hasSemanticModelRecoveryProof will compare
    // against live.stagedDefinitionHash to trigger case 2.
    const expectedDefinitionHash = hashSemanticModelDefinition(
      semanticModelDefinition,
      false, // no managed .platform
      false, // no managed diagramLayout
    );

    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: expectedDefinitionHash,
      // Preserved aux hash recorded at checkpoint time.
      preservedAuxiliaryHash: "a".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    const currentPlan = makePlan(
      "no-op",
      "after-staged",   // different from approvedPlan "before" → case 1 skipped
      "semantic-model-existing",
    );

    // Adapter whose plan() reports:
    //  - definition-hash matches (case 2 triggers)
    //  - currentAuxiliaryHash DIFFERS from the checkpoint's preservedAuxiliaryHash
    const adapter = {
      ...semanticModelAdapter("no-op", "after-staged", "semantic-model-existing"),
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "no-op",
        observedStateHash: "after-staged", // ≠ approvedPlan "before" → case 1 skipped
        physicalId: "semantic-model-existing",
        stagedDefinitionHash: expectedDefinitionHash, // case 2 matches
        managedMetadataMatches: true,
        currentAuxiliaryHash: "b".repeat(64),
      })),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        semanticModelAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");
    // update() must NOT be called since the recovery proof failed.
    expect(adapter.update).not.toHaveBeenCalled();
    expect(adapter.verify).not.toHaveBeenCalled();
  });

  it("completes no-op recovery when the full auxiliary proof matches", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const currentPlan = makePlan(
      "no-op",
      "after-staged",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const expectedDefinitionHash =
      hashSemanticModelDefinition(
        semanticModelDefinition,
        false,
        false,
      );
    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: expectedDefinitionHash,
      preservedAuxiliaryHash: "a".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = {
      ...semanticModelAdapter(
        "no-op",
        "after-staged",
        "semantic-model-existing",
      ),
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "no-op",
        observedStateHash: "after-staged",
        physicalId: "semantic-model-existing",
        stagedDefinitionHash: expectedDefinitionHash,
        managedMetadataMatches: true,
        currentAuxiliaryHash: "a".repeat(64),
      })),
    };

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      semanticModelAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).not.toHaveBeenCalled();
    expect(adapter.verify).toHaveBeenCalled();
  });

  it("validates definition-submitting auxiliary checkpoint proofs", () => {
    const plan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingUpdates.semanticModel = {
      logicalId: "semanticModel",
      action: "update",
      physicalId: "semantic-model-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-submitting",
      stagedDefinitionHash: "d".repeat(64),
      preservedAuxiliaryHash: "e".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    expect(
      loadCheckpoint(output.checkpointFile, plan)
        ?.pendingUpdates.semanticModel,
    ).toMatchObject({
      phase: "definition-submitting",
      preservedAuxiliaryHash: "e".repeat(64),
    });

    delete checkpoint.pendingUpdates.semanticModel
      ?.preservedAuxiliaryHash;
    writeCheckpoint(output.checkpointFile, checkpoint);
    expect(() =>
      loadCheckpoint(output.checkpointFile, plan),
    ).toThrow("invalid structure");

    checkpoint.pendingUpdates.semanticModel!.preservedAuxiliaryHash =
      "not-a-hash";
    writeCheckpoint(output.checkpointFile, checkpoint);
    expect(() =>
      loadCheckpoint(output.checkpointFile, plan),
    ).toThrow("invalid structure");
  });

  it("persists the auxiliary proof written before definition dispatch", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "semantic-model-existing",
    );
    const output = files();
    const adapter = semanticModelAdapter(
      "update",
      "before",
      "semantic-model-existing",
    );
    adapter.update.mockImplementationOnce(
      async (
        _workspace,
        _id,
        _desired,
        _definition,
        _onMutationAccepted,
        onUpdateCheckpoint,
      ) => {
        onUpdateCheckpoint?.({
          phase: "definition-submitting",
          stagedDefinitionHash: "d".repeat(64),
          preservedAuxiliaryHash: "e".repeat(64),
        });
        throw new Error("ambiguous definition dispatch");
      },
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan: approvedPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        semanticModelAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("ambiguous definition dispatch");

    const checkpoint = JSON.parse(
      readFileSync(output.checkpointFile, "utf8"),
    ) as {
      pendingUpdates: Record<
        string,
        {
          phase?: string;
          preservedAuxiliaryHash?: string;
        }
      >;
    };
    expect(
      checkpoint.pendingUpdates.semanticModel,
    ).toMatchObject({
      phase: "definition-submitting",
      preservedAuxiliaryHash: "e".repeat(64),
    });
  });
});
