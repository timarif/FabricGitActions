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

function identityPlan() {
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
      metadata: { deploymentId: "workspace-identity" },
      workspace: { id: "workspace-1" },
      workspaceIdentity: {
        provision: true,
        roleAssignments: [{ role: "Contributor" }],
      },
      items: [],
    },
  };
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  plan.workspaceIdentity = {
    ...plan.workspaceIdentity!,
    action: "create",
    reason: "identity missing",
    observedStateHash: "a".repeat(64),
  };
  return rehashPlan(plan);
}

function checkpointFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "fabric-identity-checkpoint-")),
    "checkpoint.json",
  );
}

describe("workspace identity checkpoint", () => {
  it("round-trips an accepted provisioning operation", () => {
    const plan = identityPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.workspaceIdentity = {
      workspaceId: "workspace-1",
      desiredHash: plan.workspaceIdentity!.desiredHash,
      provision: {
        phase: "accepted",
        operationId: "operation-1",
        operationLocation:
          "https://api.fabric.microsoft.com/v1/operations/operation-1",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
      roleAssignments: {},
    };
    const file = checkpointFile();

    writeCheckpoint(file, checkpoint);

    expect(
      loadCheckpoint(file, plan)?.workspaceIdentity,
    ).toEqual(checkpoint.workspaceIdentity);
  });

  it("rejects role state that is not bound to the approved assignment", () => {
    const plan = identityPlan();
    plan.workspaceIdentity = {
      ...plan.workspaceIdentity!,
      action: "update",
      applicationId: "application-1",
      servicePrincipalId: "principal-1",
      roleAssignments: [
        {
          ...plan.workspaceIdentity!.roleAssignments[0]!,
          action: "create",
          reason: "missing",
        },
      ],
    };
    const approved = rehashPlan(plan);
    const checkpoint = createCheckpoint(approved);
    checkpoint.workspaceIdentity = {
      workspaceId: "workspace-1",
      desiredHash: approved.workspaceIdentity!.desiredHash,
      roleAssignments: {
        "workspace-1": {
          targetWorkspaceId: "workspace-1",
          role: "Viewer",
          desiredHash:
            approved.workspaceIdentity!.roleAssignments[0]!
              .desiredHash,
          phase: "accepted",
          assignmentId: "assignment-1",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      },
    };
    const file = checkpointFile();
    writeCheckpoint(file, checkpoint);

    expect(() => loadCheckpoint(file, approved)).toThrow(
      "role assignment does not match",
    );
  });
});
