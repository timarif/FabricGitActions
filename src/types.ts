export const FABRIC_ITEM_TYPES = [
  "Lakehouse",
  "Environment",
  "Notebook",
  "SparkJobDefinition",
  "DataPipeline",
] as const;

export type FabricItemType = (typeof FABRIC_ITEM_TYPES)[number];
export type ActionMode = "validate" | "plan" | "apply";
export type PlannedAction = "create" | "update" | "no-op" | "blocked" | "unknown";

export interface ItemBinding {
  target: string;
  valueFrom: string;
}

export interface ItemDefinition {
  displayName: string;
  description?: string;
  desiredState?: "present";
  folderId?: string;
  enableSchemas?: true;
  references?: Record<string, string>;
  bindings?: ItemBinding[];
}

export interface DeploymentItem {
  logicalId: string;
  type: FabricItemType;
  path: string;
  dependsOn?: string[];
  desiredState?: "present";
}

export interface DeploymentManifest {
  apiVersion: "fabric.deploy/v1alpha1";
  kind: "FabricDeployment";
  metadata: {
    deploymentId: string;
  };
  workspace?: {
    id?: string;
  };
  items: DeploymentItem[];
}

export interface LoadedManifest {
  manifest: DeploymentManifest;
  manifestPath: string;
  manifestDirectory: string;
  sourceHash: string;
  resolvedHash: string;
  itemContentHashes: Record<string, string>;
  itemDirectories: Record<string, string>;
  itemDefinitions: Record<string, ItemDefinition>;
}

export interface PlannedItem {
  logicalId: string;
  type: FabricItemType;
  path: string;
  dependsOn: string[];
  desiredState: "present";
  contentHash: string;
  displayName: string;
  physicalId?: string;
  observedStateHash?: string;
  action: PlannedAction;
  reason: string;
}

export interface DeploymentPlan {
  schemaVersion: "1";
  mode: ActionMode;
  deploymentId: string;
  environment: string;
  workspaceId: string;
  sourceCommit?: string;
  sourceHash: string;
  resolvedHash: string;
  planHash: string;
  generatedAt: string;
  stages: string[][];
  items: PlannedItem[];
}

export type ApplyItemStatus =
  | "created"
  | "updated"
  | "verified"
  | "resumed"
  | "failed";

export interface ApplyItemResult {
  logicalId: string;
  type: FabricItemType;
  action: PlannedAction;
  status: ApplyItemStatus;
  physicalId?: string;
  durationMs: number;
  error?: string;
}

export interface ApplyResult {
  schemaVersion: "1";
  status: "in_progress" | "succeeded" | "failed";
  deploymentId: string;
  workspaceId: string;
  environment: string;
  planHash: string;
  sourceCommit?: string;
  startedAt: string;
  completedAt: string;
  items: ApplyItemResult[];
}

export interface ApplyCheckpointItem {
  logicalId: string;
  action: PlannedAction;
  physicalId: string;
  completedAt: string;
}

export interface ApplyCheckpointOperation {
  logicalId: string;
  action: "create";
  operationId?: string;
  location?: string;
  acceptedAt: string;
}

export interface ApplyCheckpointCreateIntent {
  logicalId: string;
  action: "create";
  submittedAt: string;
}

export interface ApplyCheckpointUpdateIntent {
  logicalId: string;
  action: "update";
  physicalId: string;
  submittedAt: string;
}

export interface ApplyCheckpoint {
  schemaVersion: "1";
  deploymentId: string;
  workspaceId: string;
  environment: string;
  planHash: string;
  sourceCommit?: string;
  completedItems: Record<string, ApplyCheckpointItem>;
  pendingOperations: Record<string, ApplyCheckpointOperation>;
  pendingCreates: Record<string, ApplyCheckpointCreateIntent>;
  pendingUpdates: Record<string, ApplyCheckpointUpdateIntent>;
}
