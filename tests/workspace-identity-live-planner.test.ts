import { describe, expect, it, vi } from "vitest";

import {
  enrichPlanWithFabric,
  type FabricPlanAdapters,
} from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

function loaded(managedWorkspace = false): LoadedManifest {
  return {
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
      workspace: managedWorkspace
        ? { displayName: "Managed workspace" }
        : { id: "workspace-1" },
      workspaceIdentity: {
        provision: true,
        roleAssignments: [{ role: "Contributor" }],
      },
      items: [],
    },
  };
}

function requiredAdapters(): FabricPlanAdapters {
  const unused = { plan: vi.fn() };
  return {
    lakehouse: unused as never,
    environment: unused as never,
    notebook: unused as never,
    sparkJob: unused as never,
    pipeline: unused as never,
    semanticModel: unused as never,
    sparkCustomPool: unused as never,
  };
}

describe("workspace identity live planning", () => {
  it("maps identity and role discovery into the deployment plan", async () => {
    const manifest = loaded();
    const offline = buildPlan(manifest, {
      mode: "plan",
      environment: "dev",
    });
    const role = offline.workspaceIdentity!.roleAssignments[0]!;
    const identityPlan = vi.fn(async () => ({
      action: "update" as const,
      reason: "role assignment is required",
      observedStateHash: "a".repeat(64),
      applicationId: "application-1",
      servicePrincipalId: "principal-1",
      roleAssignments: [
        {
          ...role,
          observedStateHash: "b".repeat(64),
          action: "create" as const,
          reason: "missing",
        },
      ],
    }));

    const online = await enrichPlanWithFabric(offline, manifest, {
      ...requiredAdapters(),
      workspaceIdentity: { plan: identityPlan },
    });

    expect(identityPlan).toHaveBeenCalledWith(
      "workspace-1",
      manifest.manifest.workspaceIdentity,
    );
    expect(online.workspaceIdentity).toMatchObject({
      action: "update",
      applicationId: "application-1",
      servicePrincipalId: "principal-1",
      roleAssignments: [
        {
          targetWorkspaceId: "workspace-1",
          role: "Contributor",
          action: "create",
        },
      ],
    });
  });

  it("defers identity management until a managed workspace exists", async () => {
    const manifest = loaded(true);
    const offline = buildPlan(manifest, {
      mode: "plan",
      environment: "dev",
    });
    const identityPlan = vi.fn();

    const online = await enrichPlanWithFabric(offline, manifest, {
      ...requiredAdapters(),
      workspace: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "a".repeat(64),
          managedMetadataMatches: false,
          capacityAssignmentRequired: false,
        })),
      },
      workspaceIdentity: { plan: identityPlan },
    });

    expect(identityPlan).not.toHaveBeenCalled();
    expect(online.workspaceIdentity).toMatchObject({
      action: "blocked",
      roleAssignments: [{ action: "blocked" }],
    });
  });
});
