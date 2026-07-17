import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import { createCheckpoint, writeCheckpoint } from "../src/checkpoint";
import { hashNotebookDefinition } from "../src/fabric/notebook-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const notebookDefinition = {
  format: "fabricGitSource",
  parts: [
    {
      path: "notebook-content.py",
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
  itemContentHashes: { notebook: "content" },
  itemDirectories: { notebook: "items/notebook" },
  itemDefinitions: {
    notebook: { displayName: "Hello", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: { notebook: notebookDefinition },
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "sample" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "notebook",
        type: "Notebook",
        path: "items/notebook",
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
  const root = mkdtempSync(path.join(tmpdir(), "fabric-notebook-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  return {
    plan: vi.fn(async () => {
      throw new Error("Lakehouse adapter should not be called.");
    }),
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

function notebookAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash = plannedAction === "create" ? "absent" : "observed",
  physicalId = "notebook-existing",
  stagedDefinitionHash?: string,
  managedMetadataMatches = true,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches,
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["notebookDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("notebook-created");
        return {
          id: "notebook-created",
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
        _definition: LoadedManifest["notebookDefinitions"][string],
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
          stagedDefinitionHash: hashNotebookDefinition(
            notebookDefinition,
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
        _definition: LoadedManifest["notebookDefinitions"][string],
        _operation: { operationId?: string; location?: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("notebook-created");
        return {
          id: "notebook-created",
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

describe("guarded Notebook apply", () => {
  it("creates and checkpoints a Notebook definition", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = notebookAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      notebookAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.notebook,
      notebookDefinition,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8")).completedItems
        .notebook.physicalId,
    ).toBe("notebook-created");
  });

  it("updates a Notebook through the Notebook adapter", async () => {
    const plan = makePlan("update", "before", "notebook-existing");
    const output = files();
    const adapter = notebookAdapter(
      "update",
      "before",
      "notebook-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      notebookAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("recovers a metadata-only interrupted update from checkpointed definition state", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "notebook-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "notebook-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.notebook = {
      logicalId: "notebook",
      action: "update",
      physicalId: "notebook-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = notebookAdapter(
      "update",
      "metadata-updated",
      "notebook-existing",
      stagedDefinitionHash,
      true,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      notebookAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("fails closed when interrupted Notebook staging drift is unproven", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "notebook-existing",
    );
    const currentPlan = makePlan(
      "update",
      "drifted",
      "notebook-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.notebook = {
      logicalId: "notebook",
      action: "update",
      physicalId: "notebook-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash: "c".repeat(64),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = notebookAdapter(
      "update",
      "drifted",
      "notebook-existing",
      "d".repeat(64),
      true,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        notebookAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");

    expect(adapter.update).not.toHaveBeenCalled();
  });
});
