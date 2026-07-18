import type { FabricDefinition } from "./fabric/definition";
import type { LoadedLakehouseTablesDefinition } from "./fabric/lakehouse-tables-definition";
import type { SparkCustomPoolDefinition } from "./fabric/spark-custom-pool-definition";

export const FABRIC_ITEM_TYPES = [
  "Lakehouse",
  "LakehouseTables",
  "Environment",
  "SparkCustomPool",
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

export interface WorkspaceDefinition {
  id?: string;
  displayName?: string;
  description?: string;
  capacityId?: string;
}

export interface DeploymentManifest {
  apiVersion: "fabric.deploy/v1alpha1";
  kind: "FabricDeployment";
  metadata: {
    deploymentId: string;
  };
  workspace?: WorkspaceDefinition;
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
  environmentDefinitions: Record<string, FabricDefinition>;
  notebookDefinitions: Record<string, FabricDefinition>;
  sparkJobDefinitions: Record<string, FabricDefinition>;
  pipelineDefinitions: Record<string, FabricDefinition>;
  sparkCustomPoolDefinitions: Record<
    string,
    SparkCustomPoolDefinition
  >;
  lakehouseTablesDefinitions?: Record<
    string,
    LoadedLakehouseTablesDefinition
  >;
}

export interface PlannedLakehouseTableOperation {
  action: "create" | "adopt" | "no-op" | "blocked";
  operationId: string;
  operationHash: string;
  order: number;
  logicalId: string;
  identifier: string;
  desiredHash: string;
  observedHash: string;
  reason: string;
}

export interface PlannedLakehouseTables {
  targetLakehouseLogicalId: string;
  targetLakehousePhysicalId?: string;
  targetBinding: "physical" | "symbolic";
  desiredHash: string;
  sourceHash: string;
  observedStateHash: string;
  operations: PlannedLakehouseTableOperation[];
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
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
  lakehouseTables?: PlannedLakehouseTables;
  action: PlannedAction;
  reason: string;
}

export interface PlannedWorkspace {
  displayName: string;
  contentHash: string;
  physicalId?: string;
  observedStateHash?: string;
  metadataUpdateRequired?: boolean;
  capacityAssignmentRequired?: boolean;
  action: PlannedAction;
  reason: string;
}

export interface DeploymentPlan {
  schemaVersion: "1";
  mode: ActionMode;
  deploymentId: string;
  environment: string;
  workspaceId: string;
  workspace?: PlannedWorkspace;
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
  lakehouseTables?: {
    desiredHash: string;
    observedStateHash: string;
    operationCount: number;
  };
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
  workspace?: ApplyWorkspaceResult;
  requiresItemReplan?: boolean;
  items: ApplyItemResult[];
}

export interface ApplyWorkspaceResult {
  action: PlannedAction;
  status: ApplyItemStatus;
  physicalId: string;
  durationMs: number;
  error?: string;
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
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
  acceptedAt: string;
}

export interface ApplyCheckpointCreateIntent {
  logicalId: string;
  action: "create";
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
  submittedAt: string;
}

export interface ApplyCheckpointUpdateIntent {
  logicalId: string;
  action: "update";
  physicalId: string;
  submittedAt: string;
  phase?:
    | "metadata-submitting"
    | "metadata-updated"
    | "definition-staged"
    | "published"
    | "marker-cleaned";
  stagedDefinitionHash?: string;
  stagedDeploymentMarker?: string;
  publishState?: string;
  targetVersion?: string;
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
}

export interface DefinitionItemUpdateRecoveryState {
  phase: NonNullable<ApplyCheckpointUpdateIntent["phase"]>;
  stagedDefinitionHash: string;
  stagedDeploymentMarker?: string;
  publishState?: string;
  targetVersion?: string;
}

export interface ApplyCheckpoint {
  schemaVersion: "1";
  deploymentId: string;
  workspaceId: string;
  environment: string;
  planHash: string;
  sourceCommit?: string;
  workspace?: ApplyCheckpointWorkspace;
  completedItems: Record<string, ApplyCheckpointItem>;
  pendingOperations: Record<string, ApplyCheckpointOperation>;
  pendingCreates: Record<string, ApplyCheckpointCreateIntent>;
  pendingUpdates: Record<string, ApplyCheckpointUpdateIntent>;
  lakehouseTables?: Record<string, ApplyCheckpointLakehouseTables>;
}

export interface ApplyCheckpointLakehouseTables {
  logicalId: string;
  targetLakehouseLogicalId: string;
  targetLakehouseId: string;
  desiredHash: string;
  sourceHash: string;
  attemptId: string;
  sessionName: string;
  sessionRequestHash: string;
  sessionId?: string;
  sessionPhase:
    | "submitting"
    | "accepted"
    | "active"
    | "cleanup-submitting"
    | "cleanup-complete";
  sessionSubmittedAt: string;
  sessionAcceptedAt?: string;
  cleanupCompletedAt?: string;
  statement?: {
    statementAttemptName: string;
    purpose: "inspect" | "create";
    tableLogicalId: string;
    operationHash?: string;
    codeHash: string;
    phase: "submitting" | "accepted" | "verified";
    statementId?: number;
    submittedAt: string;
    acceptedAt?: string;
    verifiedAt?: string;
  };
  completedOperationHashes: string[];
  operationReceipts: Array<{
    operationHash: string;
    tableLogicalId: string;
    statementAttemptName: string;
    codeHash: string;
    statementId: number;
    submittedAt: string;
    acceptedAt: string;
    verifiedAt: string;
  }>;
  updatedAt: string;
}

export interface ApplyCheckpointWorkspace {
  action: Extract<PlannedAction, "create" | "update" | "no-op">;
  state:
    | "create-submitting"
    | "create-accepted"
    | "metadata-update-submitting"
    | "metadata-update-accepted"
    | "capacity-assignment-submitting"
    | "capacity-assignment-accepted"
    | "completed";
  physicalId?: string;
  updatedAt: string;
}
