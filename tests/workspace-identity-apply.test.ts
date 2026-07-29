import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  LoadedManifest,
} from "../src/types";
import { applyWorkspaceIdentity } from "../src/workspace-identity-apply";

const identity = {
  applicationId: "application-1",
  servicePrincipalId: "principal-1",
};

function loaded(): LoadedManifest {
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
      workspace: { id: "workspace-1" },
      workspaceIdentity: {
        provision: true,
        roleAssignments: [{ role: "Contributor" }],
      },
      items: [],
    },
  };
}

function loadedWithLakehouse(): LoadedManifest {
  const deployment = loaded();
  deployment.itemContentHashes = { lakehouse: "content" };
  deployment.itemDirectories = {
    lakehouse: "items/lakehouse",
  };
  deployment.itemDefinitions = {
    lakehouse: {
      displayName: "Bronze",
      description: "Desired",
    },
  };
  deployment.manifest.items = [
    {
      logicalId: "lakehouse",
      type: "Lakehouse",
      path: "items/lakehouse",
    },
  ];
  return deployment;
}

function plan(
  action: "create" | "update" | "no-op",
  roleAction: "blocked" | "create" | "no-op",
  deployment = loaded(),
): DeploymentPlan {
  const plannedDeployment = buildPlan(deployment, {
    mode: "plan",
    environment: "dev",
  });
  plannedDeployment.workspaceIdentity = {
    ...plannedDeployment.workspaceIdentity!,
    action,
    reason: action,
    observedStateHash: "a".repeat(64),
    ...(action === "create"
      ? {}
      : {
          applicationId: identity.applicationId,
          servicePrincipalId: identity.servicePrincipalId,
        }),
    roleAssignments: [
      {
        ...plannedDeployment.workspaceIdentity!.roleAssignments[0]!,
        action: roleAction,
        reason: roleAction,
        observedStateHash: "b".repeat(64),
        ...(roleAction === "no-op"
          ? { assignmentId: "assignment-1" }
          : {}),
      },
    ],
  };
  return rehashPlan(plannedDeployment);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-workspace-identity-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function adapter() {
  return {
    provision: vi.fn(
      async (
        _workspaceId: string,
        callbacks: {
          onProvisionSubmitting?: () => void;
          onProvisionAccepted?: (
            operation:
              | {
                  operationId?: string;
                  location?: string;
                }
              | undefined,
          ) => void;
        } = {},
      ) => {
        callbacks.onProvisionSubmitting?.();
        callbacks.onProvisionAccepted?.(undefined);
        return identity;
      },
    ),
    resumeProvision: vi.fn(async () => identity),
    verifyIdentity: vi.fn(async () => identity),
    createRoleAssignment: vi.fn(
      async (
        _workspaceId: string,
        _identity: typeof identity,
        _desired: { workspaceId?: string; role: string },
        callbacks: {
          onRoleAssignmentSubmitting?: () => void;
          onRoleAssignmentAccepted?: (
            assignmentId: string,
          ) => void;
        } = {},
      ) => {
        callbacks.onRoleAssignmentSubmitting?.();
        callbacks.onRoleAssignmentAccepted?.("assignment-1");
        return {
          id: "assignment-1",
          principal: {
            id: identity.servicePrincipalId,
            type: "ServicePrincipal",
          },
          role: "Contributor" as const,
        };
      },
    ),
    resumeRoleAssignment: vi.fn(async () => ({
      id: "assignment-1",
      principal: {
        id: identity.servicePrincipalId,
        type: "ServicePrincipal",
      },
      role: "Contributor" as const,
    })),
    verifyRoleAssignment: vi.fn(async () => ({
      id: "assignment-1",
      principal: {
        id: identity.servicePrincipalId,
        type: "ServicePrincipal",
      },
      role: "Contributor" as const,
    })),
  };
}

function planWithTwoRoleAssignments(): {
  deployment: LoadedManifest;
  approved: DeploymentPlan;
} {
  const deployment = loaded();
  deployment.manifest.workspaceIdentity!.roleAssignments = [
    { role: "Contributor" },
    {
      workspaceId: "workspace-2",
      role: "Contributor",
    },
  ];
  const approved = buildPlan(deployment, {
    mode: "plan",
    environment: "dev",
  });
  approved.workspaceIdentity = {
    ...approved.workspaceIdentity!,
    action: "update",
    reason: "assign roles",
    observedStateHash: "a".repeat(64),
    applicationId: identity.applicationId,
    servicePrincipalId: identity.servicePrincipalId,
    roleAssignments:
      approved.workspaceIdentity!.roleAssignments.map(
        (assignment) => ({
          ...assignment,
          action: "create",
          reason: "create",
          observedStateHash: "b".repeat(64),
        }),
      ),
  };
  return {
    deployment,
    approved: rehashPlan(approved),
  };
}

function lakehouseAdapter() {
  return {
    plan: vi.fn(async () => ({
      action: "create" as const,
      reason: "create",
      observedStateHash: "absent",
    })),
    create: vi.fn(async () => ({
      id: "lakehouse-created",
      displayName: "Bronze",
      description: "Desired",
    })),
    update: vi.fn(async () => ({
      id: "lakehouse-existing",
      displayName: "Bronze",
      description: "Desired",
    })),
    resumeCreate: vi.fn(async () => ({
      id: "lakehouse-created",
      displayName: "Bronze",
      description: "Desired",
    })),
    verify: vi.fn(async (_workspaceId: string, physicalId: string) => ({
      id: physicalId,
      displayName: "Bronze",
      description: "Desired",
    })),
  };
}

describe("guarded workspace identity apply", () => {
  it("preflights identity safeguards before updating a managed workspace", async () => {
    const deployment = loaded();
    deployment.manifest.workspace = {
      id: "workspace-1",
      displayName: "Managed Workspace",
    };
    const approved = plan(
      "create",
      "blocked",
      deployment,
    );
    approved.workspace = {
      ...approved.workspace!,
      action: "update",
      reason: "update",
      observedStateHash: "workspace-observed",
      physicalId: "workspace-1",
      metadataUpdateRequired: true,
      capacityAssignmentRequired: false,
    };
    const approvedWithWorkspace = rehashPlan(approved);
    const workspaceUpdate = vi.fn(async () => {
      throw new Error("Workspace update should not be called.");
    });
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: approvedWithWorkspace,
        currentPlan: approvedWithWorkspace,
        loadedManifest: deployment,
        workspaceAdapter: {
          create: workspaceUpdate,
          resumeCreate: workspaceUpdate,
          update: workspaceUpdate,
          resumeUpdate: workspaceUpdate,
          verify: workspaceUpdate,
        },
        lakehouseAdapter: lakehouseAdapter(),
        workspaceIdentityAdapter: adapter(),
        allowCreate: false,
        allowUpdate: false,
        allowWorkspaceUpdate: true,
        allowWorkspaceIdentityProvision: false,
        allowWorkspaceIdentityRoleAssign: false,
        ...output,
      }),
    ).rejects.toThrow(
      "allow-workspace-identity-provision is false",
    );

    expect(workspaceUpdate).not.toHaveBeenCalled();
  });

  it("preflights identity drift before updating a managed workspace", async () => {
    const deployment = loaded();
    deployment.manifest.workspace = {
      id: "workspace-1",
      displayName: "Managed Workspace",
    };
    const approved = plan(
      "create",
      "blocked",
      deployment,
    );
    approved.workspace = {
      ...approved.workspace!,
      action: "update",
      reason: "update",
      observedStateHash: "workspace-observed",
      physicalId: "workspace-1",
      metadataUpdateRequired: true,
      capacityAssignmentRequired: false,
    };
    const approvedWithWorkspace = rehashPlan(approved);
    const currentPlan: DeploymentPlan = {
      ...approvedWithWorkspace,
      workspaceIdentity: {
        ...approvedWithWorkspace.workspaceIdentity!,
        observedStateHash: "drifted",
      },
    };
    const workspaceUpdate = vi.fn(async () => {
      throw new Error("Workspace update should not be called.");
    });
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan: approvedWithWorkspace,
        currentPlan,
        loadedManifest: deployment,
        workspaceAdapter: {
          create: workspaceUpdate,
          resumeCreate: workspaceUpdate,
          update: workspaceUpdate,
          resumeUpdate: workspaceUpdate,
          verify: workspaceUpdate,
        },
        lakehouseAdapter: lakehouseAdapter(),
        workspaceIdentityAdapter: adapter(),
        allowCreate: false,
        allowUpdate: false,
        allowWorkspaceUpdate: true,
        allowWorkspaceIdentityProvision: true,
        allowWorkspaceIdentityRoleAssign: false,
        ...output,
      }),
    ).rejects.toThrow(
      "workspace identity state drifted after approval",
    );

    expect(workspaceUpdate).not.toHaveBeenCalled();
  });

  it("requires the independent provision safeguard", async () => {
    const approved = plan("create", "blocked");
    const output = files();
    const checkpoint = createCheckpoint(approved);
    const identityAdapter = adapter();

    await expect(
      applyWorkspaceIdentity({
        approvedPlan: approved,
        currentPlan: approved,
        desired: loaded().manifest.workspaceIdentity,
        adapter: identityAdapter,
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowProvision: false,
        allowRoleAssign: false,
      }),
    ).rejects.toThrow(
      "allow-workspace-identity-provision is false",
    );
    expect(identityAdapter.provision).not.toHaveBeenCalled();
  });

  it("preflights item safeguards before provisioning an identity with no role assignments", async () => {
    const deployment = loadedWithLakehouse();
    deployment.manifest.workspaceIdentity!.roleAssignments = [];
    const approved = buildPlan(deployment, {
      mode: "plan",
      environment: "dev",
    });
    approved.workspaceIdentity = {
      ...approved.workspaceIdentity!,
      action: "create",
      reason: "create",
      observedStateHash: "a".repeat(64),
      roleAssignments: [],
    };
    approved.items[0] = {
      ...approved.items[0]!,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    };
    const approvedPlan = rehashPlan(approved);
    const identityAdapter = adapter();
    const output = files();

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan: approvedPlan,
        loadedManifest: deployment,
        lakehouseAdapter: lakehouseAdapter(),
        workspaceIdentityAdapter: identityAdapter,
        allowCreate: false,
        allowUpdate: false,
        allowWorkspaceIdentityProvision: true,
        allowWorkspaceIdentityRoleAssign: false,
        ...output,
      }),
    ).rejects.toThrow("allow-create is false");

    expect(identityAdapter.provision).not.toHaveBeenCalled();
  });

  it("provisions, checkpoints IDs, and requires a role replan", async () => {
    const approved = plan("create", "blocked");
    const output = files();
    const checkpoint = createCheckpoint(approved);

    const outcome = await applyWorkspaceIdentity({
      approvedPlan: approved,
      currentPlan: approved,
      desired: loaded().manifest.workspaceIdentity,
      adapter: adapter(),
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowProvision: true,
      allowRoleAssign: false,
    });

    expect(outcome).toMatchObject({
      requiresItemReplan: true,
      result: {
        status: "created",
        applicationId: "application-1",
        servicePrincipalId: "principal-1",
      },
    });
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .workspaceIdentity.provision,
    ).toMatchObject({
      phase: "verified",
      applicationId: "application-1",
      servicePrincipalId: "principal-1",
    });
  });

  it("resumes accepted provisioning without redispatch", async () => {
    const approved = plan("create", "blocked");
    const output = files();
    const checkpoint = createCheckpoint(approved);
    checkpoint.workspaceIdentity = {
      workspaceId: "workspace-1",
      desiredHash: approved.workspaceIdentity!.desiredHash,
      provision: {
        phase: "accepted",
        operationId: "operation-1",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
      roleAssignments: {},
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const identityAdapter = adapter();

    const outcome = await applyWorkspaceIdentity({
      approvedPlan: approved,
      currentPlan: approved,
      desired: loaded().manifest.workspaceIdentity,
      adapter: identityAdapter,
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowProvision: true,
      allowRoleAssign: false,
    });

    expect(outcome.result?.status).toBe("resumed");
    expect(identityAdapter.resumeProvision).toHaveBeenCalledOnce();
    expect(identityAdapter.provision).not.toHaveBeenCalled();
  });

  it("preflights every role safeguard before creating assignments", async () => {
    const approved = plan("update", "create");
    const output = files();
    const checkpoint = createCheckpoint(approved);
    const identityAdapter = adapter();

    await expect(
      applyWorkspaceIdentity({
        approvedPlan: approved,
        currentPlan: approved,
        desired: loaded().manifest.workspaceIdentity,
        adapter: identityAdapter,
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowProvision: false,
        allowRoleAssign: false,
      }),
    ).rejects.toThrow(
      "allow-workspace-identity-role-assign is false",
    );
    expect(
      identityAdapter.createRoleAssignment,
    ).not.toHaveBeenCalled();
  });

  it("adds and checkpoints an approved role assignment", async () => {
    const approved = plan("update", "create");
    const output = files();
    const checkpoint = createCheckpoint(approved);

    const outcome = await applyWorkspaceIdentity({
      approvedPlan: approved,
      currentPlan: approved,
      desired: loaded().manifest.workspaceIdentity,
      adapter: adapter(),
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowProvision: false,
      allowRoleAssign: true,
    });

    expect(outcome).toMatchObject({
      requiresItemReplan: false,
      result: {
        status: "updated",
        roleAssignments: [
          {
            targetWorkspaceId: "workspace-1",
            role: "Contributor",
            assignmentId: "assignment-1",
            status: "created",
          },
        ],
      },
    });
    expect(
      JSON.parse(readFileSync(output.checkpointFile, "utf8"))
        .workspaceIdentity.roleAssignments["workspace-1"],
    ).toMatchObject({
      phase: "verified",
      assignmentId: "assignment-1",
    });
  });

  it("rechecks item safeguards after prioritized identity recovery", async () => {
    const deployment = loadedWithLakehouse();
    const identityPlan = plan("update", "create", deployment);
    identityPlan.items[0] = {
      ...identityPlan.items[0]!,
      action: "create",
      reason: "create",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(identityPlan);
    const output = files();
    const checkpoint = createCheckpoint(approved);
    const assignment =
      approved.workspaceIdentity!.roleAssignments[0]!;
    checkpoint.workspaceIdentity = {
      workspaceId: approved.workspaceId,
      desiredHash: approved.workspaceIdentity!.desiredHash,
      roleAssignments: {
        [assignment.targetWorkspaceId]: {
          targetWorkspaceId: assignment.targetWorkspaceId,
          role: assignment.role,
          desiredHash: assignment.desiredHash,
          phase: "accepted",
          assignmentId: "assignment-1",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      },
    };
    checkpoint.pendingOperations.lakehouse = {
      logicalId: "lakehouse",
      action: "create",
      operationId: "operation-1",
      acceptedAt: "2026-07-22T00:00:00.000Z",
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const identityAdapter = adapter();
    const itemAdapter = lakehouseAdapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: deployment,
        lakehouseAdapter: itemAdapter,
        workspaceIdentityAdapter: identityAdapter,
        allowCreate: false,
        allowUpdate: false,
        allowWorkspaceIdentityProvision: false,
        allowWorkspaceIdentityRoleAssign: true,
        ...output,
      }),
    ).rejects.toThrow("allow-create is false");

    expect(
      identityAdapter.resumeRoleAssignment,
    ).toHaveBeenCalledOnce();
    expect(itemAdapter.resumeCreate).not.toHaveBeenCalled();
  });

  it("allows checkpointed role drift while requiring untouched roles to match", async () => {
    const { deployment, approved } =
      planWithTwoRoleAssignments();
    const firstAssignment =
      approved.workspaceIdentity!.roleAssignments[0]!;
    const current: DeploymentPlan = {
      ...approved,
      workspaceIdentity: {
        ...approved.workspaceIdentity!,
        roleAssignments:
          approved.workspaceIdentity!.roleAssignments.map(
            (assignment, index) =>
              index === 0
                ? {
                    ...assignment,
                    action: "no-op",
                    assignmentId: "assignment-1",
                    observedStateHash: "c".repeat(64),
                  }
                : assignment,
          ),
      },
    };
    const checkpoint = createCheckpoint(approved);
    checkpoint.workspaceIdentity = {
      workspaceId: approved.workspaceId,
      desiredHash: approved.workspaceIdentity!.desiredHash,
      roleAssignments: {
        [firstAssignment.targetWorkspaceId]: {
          targetWorkspaceId:
            firstAssignment.targetWorkspaceId,
          role: firstAssignment.role,
          desiredHash: firstAssignment.desiredHash,
          phase: "accepted",
          assignmentId: "assignment-1",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      },
    };
    const identityAdapter = adapter();
    const output = files();

    const outcome = await applyWorkspaceIdentity({
      approvedPlan: approved,
      currentPlan: current,
      desired: deployment.manifest.workspaceIdentity,
      adapter: identityAdapter,
      checkpoint,
      checkpointFile: output.checkpointFile,
      allowProvision: false,
      allowRoleAssign: true,
    });

    expect(outcome.result?.roleAssignments).toHaveLength(2);
    expect(
      identityAdapter.resumeRoleAssignment,
    ).toHaveBeenCalledOnce();
    expect(
      identityAdapter.createRoleAssignment,
    ).toHaveBeenCalledOnce();
  });

  it("rejects drift in an untouched role while another role has a checkpoint", async () => {
    const { deployment, approved } =
      planWithTwoRoleAssignments();
    const firstAssignment =
      approved.workspaceIdentity!.roleAssignments[0]!;
    const current: DeploymentPlan = {
      ...approved,
      workspaceIdentity: {
        ...approved.workspaceIdentity!,
        roleAssignments:
          approved.workspaceIdentity!.roleAssignments.map(
            (assignment, index) =>
              index === 0
                ? {
                    ...assignment,
                    action: "no-op",
                    assignmentId: "assignment-1",
                    observedStateHash: "c".repeat(64),
                  }
                : {
                    ...assignment,
                    action: "blocked",
                    reason: "drifted",
                    observedStateHash: "d".repeat(64),
                  },
          ),
      },
    };
    const checkpoint = createCheckpoint(approved);
    checkpoint.workspaceIdentity = {
      workspaceId: approved.workspaceId,
      desiredHash: approved.workspaceIdentity!.desiredHash,
      roleAssignments: {
        [firstAssignment.targetWorkspaceId]: {
          targetWorkspaceId:
            firstAssignment.targetWorkspaceId,
          role: firstAssignment.role,
          desiredHash: firstAssignment.desiredHash,
          phase: "accepted",
          assignmentId: "assignment-1",
          updatedAt: "2026-07-22T00:00:00.000Z",
        },
      },
    };
    const identityAdapter = adapter();
    const output = files();

    await expect(
      applyWorkspaceIdentity({
        approvedPlan: approved,
        currentPlan: current,
        desired: deployment.manifest.workspaceIdentity,
        adapter: identityAdapter,
        checkpoint,
        checkpointFile: output.checkpointFile,
        allowProvision: false,
        allowRoleAssign: true,
      }),
    ).rejects.toThrow(
      "workspace identity state drifted after approval",
    );

    expect(
      identityAdapter.resumeRoleAssignment,
    ).not.toHaveBeenCalled();
    expect(
      identityAdapter.createRoleAssignment,
    ).not.toHaveBeenCalled();
  });

  it("returns identity bootstrap results through applyApprovedPlan", async () => {
    const deployment = loaded();
    const approved = plan("create", "blocked");
    const output = files();
    const unusedItemAdapter = vi.fn(async () => {
      throw new Error("Item adapter should not be called.");
    });

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: deployment,
      lakehouseAdapter: {
        plan: unusedItemAdapter,
        create: unusedItemAdapter,
        update: unusedItemAdapter,
        resumeCreate: unusedItemAdapter,
        verify: unusedItemAdapter,
      },
      workspaceIdentityAdapter: adapter(),
      allowCreate: false,
      allowUpdate: false,
      allowWorkspaceIdentityProvision: true,
      allowWorkspaceIdentityRoleAssign: false,
      ...output,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      workspaceId: "workspace-1",
      requiresItemReplan: true,
      workspaceIdentity: {
        status: "created",
        servicePrincipalId: "principal-1",
      },
      items: [],
    });
  });
});
