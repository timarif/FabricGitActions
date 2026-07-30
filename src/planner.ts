import { sha256, stableJson } from "./hash";
import { buildOfflineTagAssignment } from "./fabric/tag-assignment";
import { buildUnknownNetworkProtectionPlan } from "./fabric/network-protection";
import {
  hashDesiredVirtualNetworkGateway,
  hashObservedVirtualNetworkGateway,
  normalizeVirtualNetworkGatewayDefinitions,
} from "./fabric/virtual-network-gateway";
import { buildDeploymentStages } from "./graph";
import type {
  ActionMode,
  DeploymentPlan,
  LoadedManifest,
  PlannedItem,
  PlannedVirtualNetworkGateway,
  PlannedWorkspace,
  PlannedWorkspaceIdentity,
  WorkspaceDefinition,
  WorkspaceIdentityDefinition,
} from "./types";

export interface BuildPlanOptions {
  mode: ActionMode;
  environment: string;
  workspaceId?: string;
  sourceCommit?: string;
  now?: Date;
}

export function buildPlan(
  loadedManifest: LoadedManifest,
  options: BuildPlanOptions,
): DeploymentPlan {
  const workspaceDefinition = loadedManifest.manifest.workspace;
  const workspaceId =
    options.workspaceId ||
    workspaceDefinition?.id ||
    pendingWorkspaceId(workspaceDefinition);
  if (!workspaceId) {
    throw new Error(
      "A target workspace ID is required through the workspace-id input or workspace.id.",
    );
  }

  const stages = buildDeploymentStages(loadedManifest.manifest.items);
  const items: PlannedItem[] = loadedManifest.manifest.items.map((item) => ({
    logicalId: item.logicalId,
    type: item.type,
    path: item.path,
    dependsOn: [...(item.dependsOn ?? [])].sort(),
    desiredState: item.desiredState ?? "present",
    contentHash: loadedManifest.itemContentHashes[item.logicalId] ?? "",
    displayName:
      loadedManifest.itemDefinitions[item.logicalId]?.displayName ?? item.logicalId,
    tagAssignment: buildOfflineTagAssignment(
      loadedManifest,
      item.logicalId,
    ),
    action: "unknown",
    reason:
      options.mode === "validate"
        ? "Manifest and dependency validation completed."
        : "Online Fabric discovery is disabled because authentication is not configured.",
  }));

  const plan = {
    schemaVersion: "1",
    mode: options.mode,
    deploymentId: loadedManifest.manifest.metadata.deploymentId,
    environment: options.environment,
    workspaceId,
    ...(workspaceDefinition?.displayName
      ? {
          workspace: buildOfflineWorkspacePlan(
            workspaceDefinition,
          ),
        }
      : {}),
    ...(loadedManifest.manifest.workspaceIdentity
      ? {
          workspaceIdentity: buildOfflineWorkspaceIdentityPlan(
            loadedManifest.manifest.workspaceIdentity,
            workspaceId,
          ),
        }
      : {}),
    ...(loadedManifest.manifest.virtualNetworkGateways
      ? {
          virtualNetworkGateways:
            buildOfflineVirtualNetworkGatewayPlans(
              loadedManifest.manifest.virtualNetworkGateways,
              options.mode,
            ),
        }
      : {}),
    ...(loadedManifest.manifest.networkProtection
      ? {
          networkProtection: buildUnknownNetworkProtectionPlan(
            loadedManifest.manifest.networkProtection,
          ),
        }
      : {}),
    ...(options.sourceCommit ? { sourceCommit: options.sourceCommit } : {}),
    sourceHash: loadedManifest.sourceHash,
    resolvedHash: loadedManifest.resolvedHash,
    stages,
    items,
    planHash: "",
    generatedAt: (options.now ?? new Date()).toISOString(),
  } satisfies DeploymentPlan;

  return rehashPlan(plan);
}

export function rehashPlan(plan: DeploymentPlan): DeploymentPlan {
  const hashInput = {
    schemaVersion: plan.schemaVersion,
    mode: plan.mode,
    deploymentId: plan.deploymentId,
    environment: plan.environment,
    workspaceId: plan.workspaceId,
    workspace: plan.workspace,
    workspaceIdentity: plan.workspaceIdentity,
    virtualNetworkGateways: plan.virtualNetworkGateways,
    networkProtection: plan.networkProtection,
    sourceCommit: plan.sourceCommit,
    sourceHash: plan.sourceHash,
    resolvedHash: plan.resolvedHash,
    stages: plan.stages,
    items: plan.items,
  };

  return {
    ...plan,
    schemaVersion: "1",
    planHash: sha256(stableJson(hashInput)),
  };
}

function buildOfflineVirtualNetworkGatewayPlans(
  definitions: NonNullable<
    LoadedManifest["manifest"]["virtualNetworkGateways"]
  >,
  mode: ActionMode,
): PlannedVirtualNetworkGateway[] {
  return normalizeVirtualNetworkGatewayDefinitions(definitions).map(
    (definition) => ({
      logicalId: definition.logicalId,
      desiredState: definition.desiredState,
      displayName: definition.displayName,
      virtualNetworkAzureResource:
        definition.virtualNetworkAzureResource,
      ...(definition.desiredState === "present"
        ? {
            capacityId: definition.capacityId,
            inactivityMinutesBeforeSleep:
              definition.inactivityMinutesBeforeSleep,
            ...(definition.numberOfMemberGateways === undefined
              ? {
                  minMemberGatewayCount:
                    definition.minMemberGatewayCount,
                  maxMemberGatewayCount:
                    definition.maxMemberGatewayCount,
                }
              : {
                  numberOfMemberGateways:
                    definition.numberOfMemberGateways,
                }),
          }
        : {}),
      desiredHash: hashDesiredVirtualNetworkGateway(definition),
      observedStateHash:
        hashObservedVirtualNetworkGateway(undefined),
      ...(definition.id ? { physicalId: definition.id } : {}),
      action: "unknown",
      reason:
        mode === "validate"
          ? "Virtual network gateway manifest validation completed."
          : "Online Fabric virtual network gateway discovery is disabled because authentication is not configured.",
    }),
  );
}

function buildOfflineWorkspacePlan(
  workspace: WorkspaceDefinition,
): PlannedWorkspace {
  return {
    displayName: workspace.displayName!,
    contentHash: sha256(stableJson(workspace)),
    ...(workspace.id ? { physicalId: workspace.id } : {}),
    action: "unknown",
    reason:
      "Online Fabric workspace discovery is disabled because authentication is not configured.",
  };
}

function buildOfflineWorkspaceIdentityPlan(
  identity: WorkspaceIdentityDefinition,
  workspaceId: string,
): PlannedWorkspaceIdentity {
  const roleAssignments = (identity.roleAssignments ?? [])
    .map((assignment) => {
      const targetWorkspaceId = assignment.workspaceId ?? workspaceId;
      const desiredHash = sha256(
        stableJson({
          targetWorkspaceId,
          role: assignment.role,
        }),
      );
      return {
        targetWorkspaceId,
        role: assignment.role,
        desiredHash,
        observedStateHash: sha256(stableJson(null)),
        action: "unknown" as const,
        reason:
          "Online workspace identity role discovery is disabled because authentication is not configured.",
      };
    })
    .sort((left, right) =>
      `${left.targetWorkspaceId}\0${left.role}`.localeCompare(
        `${right.targetWorkspaceId}\0${right.role}`,
      ),
    );
  return {
    desiredHash: sha256(
      stableJson({
        provision: identity.provision,
        roleAssignments: roleAssignments.map(
          ({ targetWorkspaceId, role }) => ({
            targetWorkspaceId,
            role,
          }),
        ),
      }),
    ),
    observedStateHash: sha256(stableJson(null)),
    action: "unknown",
    reason:
      "Online workspace identity discovery is disabled because authentication is not configured.",
    roleAssignments,
  };
}

function pendingWorkspaceId(
  workspace: WorkspaceDefinition | undefined,
): string | undefined {
  if (!workspace?.displayName) {
    return undefined;
  }
  return `pending:${sha256(stableJson(workspace))}`;
}
