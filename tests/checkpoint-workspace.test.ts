import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

function managedPlan() {
  const loaded: LoadedManifest = {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: {},
    itemDirectories: {},
    itemDefinitions: {},
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: {},
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "workspace-only" },
      workspace: {
        displayName: "Fabric Deploy Analytics",
      },
      items: [],
    },
  };
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  plan.workspace = {
    ...plan.workspace!,
    action: "create",
    reason: "missing",
    observedStateHash: "absent",
  };
  return rehashPlan(plan);
}

describe("managed workspace checkpoint", () => {
  it("round-trips a pending workspace create", () => {
    const plan = managedPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.workspace = {
      action: "create",
      state: "create-submitting",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-workspace-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");

    writeCheckpoint(checkpointFile, checkpoint);

    expect(loadCheckpoint(checkpointFile, plan)?.workspace).toEqual(
      checkpoint.workspace,
    );
  });

  it("rejects workspace state for a different approved action", () => {
    const plan = managedPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.workspace = {
      action: "update",
      state: "metadata-update-submitting",
      physicalId: "workspace-1",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-workspace-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "Checkpoint workspace does not match",
    );
  });

  it("rejects an existing workspace checkpoint with another physical ID", () => {
    const plan = managedPlan();
    plan.workspaceId = "workspace-1";
    plan.workspace = {
      ...plan.workspace!,
      action: "update",
      reason: "metadata differs",
      physicalId: "workspace-1",
      observedStateHash: "state",
      metadataUpdateRequired: true,
    };
    const approved = rehashPlan(plan);
    const checkpoint = createCheckpoint(approved);
    checkpoint.workspace = {
      action: "update",
      state: "metadata-update-submitting",
      physicalId: "workspace-2",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-workspace-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() =>
      loadCheckpoint(checkpointFile, approved),
    ).toThrow("physical ID does not match");
  });
});
