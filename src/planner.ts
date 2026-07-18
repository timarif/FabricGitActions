import { sha256, stableJson } from "./hash";
import { buildOfflineTagAssignment } from "./fabric/tag-assignment";
import { buildDeploymentStages } from "./graph";
import type {
  ActionMode,
  DeploymentPlan,
  LoadedManifest,
  PlannedItem,
  PlannedWorkspace,
  WorkspaceDefinition,
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

function pendingWorkspaceId(
  workspace: WorkspaceDefinition | undefined,
): string | undefined {
  if (!workspace?.displayName) {
    return undefined;
  }
  return `pending:${sha256(stableJson(workspace))}`;
}
