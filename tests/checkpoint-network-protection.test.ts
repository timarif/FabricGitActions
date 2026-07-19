import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import {
  managedPrivateEndpointCheckpointKey,
  normalizeManagedPrivateEndpoints,
  planManagedPrivateEndpoints,
} from "../src/fabric/managed-private-endpoints";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";
const STORAGE_CHECKPOINT_KEY =
  managedPrivateEndpointCheckpointKey("storage-blob");

function planWithNetworkProtection() {
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
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "network-protection-only" },
      workspace: { id: WORKSPACE_ID },
      networkProtection: {
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
      },
      items: [],
    },
  };
  const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
  plan.networkProtection = {
    ...plan.networkProtection!,
    workspaceId: WORKSPACE_ID,
    communicationPolicy: {
      ...plan.networkProtection!.communicationPolicy,
      action: "update",
      reason: "differs",
      observedStateHash: "observed",
    },
  };
  return rehashPlan(plan);
}

describe("network protection checkpoint", () => {
  it("round-trips a submitting communication policy surface", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");

    writeCheckpoint(checkpointFile, checkpoint);

    expect(loadCheckpoint(checkpointFile, plan)?.networkProtection).toEqual(
      checkpoint.networkProtection,
    );
  });

  it("round-trips a fully completed checkpoint", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      completedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");

    writeCheckpoint(checkpointFile, checkpoint);

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection?.completedAt,
    ).toBe("2026-07-17T00:00:00.000Z");
  });

  it("rejects a completed marker when a configured surface is not verified", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      completedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "invalid structure",
    );
  });

  it("rejects a completed marker when a configured surface is missing", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      completedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "marked complete",
    );
  });

  it("rejects checkpoint state for a surface whose desired hash does not match the approved plan", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: "0".repeat(64),
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "Checkpoint network protection 'communicationPolicy' does not match",
    );
  });

  it("rejects a checkpoint workspace ID that does not match the approved plan", () => {
    const plan = planWithNetworkProtection();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: "22222222-2222-4222-8222-222222222222",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "Checkpoint network protection workspace ID does not match",
    );
  });

  it("rejects network protection checkpoint state when the approved plan does not configure it", () => {
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
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "no-network-protection" },
        workspace: { id: WORKSPACE_ID },
        items: [],
      },
    };
    const plan = rehashPlan(
      buildPlan(loaded, { mode: "plan", environment: "dev" }),
    );
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-protection-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);

    expect(() => loadCheckpoint(checkpointFile, plan)).toThrow(
      "Checkpoint network protection does not match",
    );
  });

  it("round-trips managed private endpoint create intent without persisting requestMessage", () => {
    const plan = planWithNetworkProtection();
    plan.networkProtection!.managedPrivateEndpoints =
      planManagedPrivateEndpoints(
        normalizeManagedPrivateEndpoints([
          {
            name: "storage-blob",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve this private endpoint",
          },
        ]),
        [],
      );
    const approved = rehashPlan(plan);
    const endpoint =
      approved.networkProtection!.managedPrivateEndpoints![0]!;
    const checkpoint = createCheckpoint(approved);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      managedPrivateEndpoints: {
        [STORAGE_CHECKPOINT_KEY]: {
          name: endpoint.name,
          desiredState: "present",
          action: "create",
          operationHash: endpoint.operationHash,
          desiredIdentityHash: endpoint.desiredIdentityHash,
          phase: "create-submitting",
          submittedAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      },
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-mpe-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");

    writeCheckpoint(checkpointFile, checkpoint);
    const loaded = loadCheckpoint(checkpointFile, approved);

    expect(
      loaded?.networkProtection?.managedPrivateEndpoints?.[
        STORAGE_CHECKPOINT_KEY
      ]?.phase,
    ).toBe("create-submitting");
    expect(JSON.stringify(loaded)).not.toContain(
      "Approve this private endpoint",
    );
  });

  it("validates managed private endpoint operation hashes and delete cooldown timestamps", () => {
    const plan = planWithNetworkProtection();
    const desired = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
      },
    ]);
    plan.networkProtection!.managedPrivateEndpoints =
      planManagedPrivateEndpoints(desired, [
        {
          id: "22222222-2222-4222-8222-222222222222",
          name: "storage-blob",
          targetPrivateLinkResourceId: TARGET_ID.toLowerCase(),
          provisioningState: "Succeeded",
          connectionStatus: "Approved",
        },
      ]);
    const approved = rehashPlan(plan);
    const endpoint =
      approved.networkProtection!.managedPrivateEndpoints![0]!;
    const checkpoint = createCheckpoint(approved);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      managedPrivateEndpoints: {
        [STORAGE_CHECKPOINT_KEY]: {
          name: endpoint.name,
          desiredState: "absent",
          action: "delete",
          operationHash: endpoint.operationHash,
          desiredIdentityHash: endpoint.desiredIdentityHash,
          phase: "absent-verified",
          physicalId: endpoint.physicalId,
          observedIdentityHash: endpoint.observedIdentityHash,
          verifiedAt: "2026-07-18T00:00:00.000Z",
          deletedAt: "2026-07-18T00:00:00.000Z",
          recreateNotBefore: "2026-07-18T00:15:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      },
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-mpe-checkpoint-"),
    );
    const checkpointFile = path.join(root, "checkpoint.json");
    writeCheckpoint(checkpointFile, checkpoint);
    expect(
      loadCheckpoint(checkpointFile, approved)?.networkProtection
        ?.managedPrivateEndpoints?.[STORAGE_CHECKPOINT_KEY]
        ?.recreateNotBefore,
    ).toBe("2026-07-18T00:15:00.000Z");

    checkpoint.networkProtection.managedPrivateEndpoints![
      STORAGE_CHECKPOINT_KEY
    ]!.operationHash = "0".repeat(64);
    writeCheckpoint(checkpointFile, checkpoint);
    expect(() => loadCheckpoint(checkpointFile, approved)).toThrow(
      "does not match the approved deployment plan",
    );
  });
});
