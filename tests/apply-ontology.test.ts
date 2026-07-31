import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { hashOntologyDefinition } from "../src/fabric/ontology-definition";
import { sha256, stableJson } from "../src/hash";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const ontologyDefinition = {
  format: "Default",
  parts: [
    {
      path: ".platform",
      payload: Buffer.from(
        JSON.stringify({
          metadata: {
            type: "Ontology",
            displayName: "AssetOntology",
            description: "Managed",
          },
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
    {
      path: "definition.json",
      payload: Buffer.from("{}").toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { ontology: "content" },
  itemDirectories: { ontology: "items/ontology" },
  itemDefinitions: {
    ontology: {
      displayName: "AssetOntology",
      description: "Managed",
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  ontologyDefinitions: { ontology: ontologyDefinition },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "ontology-apply" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "ontology",
        type: "Ontology",
        path: "items/ontology",
      },
    ],
  },
};

const deletionLoaded: LoadedManifest = {
  ...loaded,
  itemDefinitions: {
    ontology: {
      displayName: "AssetOntology",
      desiredState: "absent",
    },
  },
  ontologyDefinitions: {},
  manifest: {
    ...loaded.manifest,
    metadata: { deploymentId: "ontology-delete" },
    items: [
      {
        logicalId: "ontology",
        type: "Ontology",
        path: "items/ontology",
        desiredState: "absent",
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

function makeDeletionPlan(): DeploymentPlan {
  const plan = buildPlan(deletionLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: "delete",
    reason: "delete",
    observedStateHash: "d".repeat(64),
    physicalId: "ontology-existing",
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-ontology-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
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

function ontologyAdapter(
  plannedAction: "create" | "update" | "no-op",
  observedStateHash: string,
  physicalId = "ontology-existing",
  stagedDefinitionHash = hashOntologyDefinition(ontologyDefinition),
  managedMetadataMatches = true,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      stagedDefinitionHash:
        plannedAction === "create"
          ? undefined
          : stagedDefinitionHash,
      managedMetadataMatches,
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: typeof ontologyDefinition,
        onMutationAccepted?: (id: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("ontology-created");
        return {
          id: "ontology-created",
          displayName: "AssetOntology",
          description: "Managed",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: typeof ontologyDefinition,
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
          stagedDefinitionHash:
            hashOntologyDefinition(ontologyDefinition),
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "AssetOntology",
          description: "Managed",
        };
      },
    ),
    resumeCreate: vi.fn(),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "AssetOntology",
      description: "Managed",
    })),
  };
}

describe("guarded Ontology apply", () => {
  it("creates and checkpoints an Ontology definition", async () => {
    const plan = makePlan("create", "absent");
    const adapter = ontologyAdapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      ontologyAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...files(),
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.ontology,
      ontologyDefinition,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("updates an Ontology through its specialized adapter", async () => {
    const plan = makePlan(
      "update",
      "before",
      "ontology-existing",
    );
    const adapter = ontologyAdapter(
      "update",
      "before",
      "ontology-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      ontologyAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...files(),
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted metadata update from checkpointed definition state", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "ontology-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "ontology-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.ontology = {
      logicalId: "ontology",
      action: "update",
      physicalId: "ontology-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = ontologyAdapter(
      "update",
      "metadata-updated",
      "ontology-existing",
      stagedDefinitionHash,
      true,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      ontologyAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("fails closed when interrupted Ontology staging drift is unproven", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "ontology-existing",
    );
    const currentPlan = makePlan(
      "update",
      "drifted",
      "ontology-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.ontology = {
      logicalId: "ontology",
      action: "update",
      physicalId: "ontology-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash: "c".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = ontologyAdapter(
      "update",
      "drifted",
      "ontology-existing",
      "d".repeat(64),
      true,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        ontologyAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");

    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("soft-deletes an approved Ontology through guarded generic deletion", async () => {
    const plan = makeDeletionPlan();
    const deletion = {
      plan: vi
        .fn()
        .mockResolvedValueOnce({
          action: "delete" as const,
          reason: "delete",
          physicalId: "ontology-existing",
          observedStateHash: "d".repeat(64),
        })
        .mockResolvedValue({
          action: "no-op" as const,
          reason: "absent",
          observedStateHash: sha256(stableJson(null)),
        }),
      delete: vi.fn(
        async (
          _workspaceId: string,
          _itemId: string,
          onDispatch?: () => void,
        ) => {
          onDispatch?.();
        },
      ),
      verifyApprovedIdentity: vi
        .fn()
        .mockResolvedValueOnce("unchanged" as const)
        .mockResolvedValueOnce("absent" as const),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: deletionLoaded,
      lakehouseAdapter: lakehouseAdapter(),
      itemDeletionAdapter: deletion,
      allowCreate: false,
      allowUpdate: false,
      allowDelete: true,
      ...files(),
    });

    expect(result.items[0]).toMatchObject({
      action: "delete",
      status: "deleted",
      physicalId: "ontology-existing",
    });
    expect(deletion.delete).toHaveBeenCalledWith(
      "workspace",
      "ontology-existing",
      expect.any(Function),
    );
  });
});
