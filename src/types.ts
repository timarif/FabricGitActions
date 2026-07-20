import type { FabricDefinition } from "./fabric/definition";
import type { LoadedLakehouseTablesDefinition } from "./fabric/lakehouse-tables-definition";
import type { SparkJobArtifactSource } from "./fabric/spark-job-definition";
import type { SparkCustomPoolDefinition } from "./fabric/spark-custom-pool-definition";
import type { FabricTagScope } from "./fabric/tags";

export const FABRIC_ITEM_TYPES = [
  "Lakehouse",
  "LakehouseTables",
  "FabricTag",
  "Environment",
  "SparkCustomPool",
  "Notebook",
  "SparkJobDefinition",
  "DataPipeline",
  "SemanticModel",
] as const;

export type FabricItemType = (typeof FABRIC_ITEM_TYPES)[number];
export type ActionMode = "validate" | "plan" | "apply";
export type DesiredState = "present" | "absent";
export type PlannedAction =
  | "create"
  | "update"
  | "delete"
  | "no-op"
  | "blocked"
  | "unknown";

export interface ItemBinding {
  target: string;
  valueFrom: string;
}

export interface ItemDefinition {
  displayName: string;
  description?: string;
  desiredState?: DesiredState;
  folderId?: string;
  enableSchemas?: true;
  scope?: FabricTagScope;
  tags?: string[];
  references?: Record<string, string>;
  bindings?: ItemBinding[];
}

export interface DeploymentItem {
  logicalId: string;
  type: FabricItemType;
  path: string;
  dependsOn?: string[];
  desiredState?: DesiredState;
}

export interface WorkspaceDefinition {
  id?: string;
  displayName?: string;
  description?: string;
  capacityId?: string;
}

export type NetworkDefaultAction = "Allow" | "Deny";

export interface NetworkCommunicationPolicyManifest {
  inboundDefaultAction: NetworkDefaultAction;
  outboundDefaultAction: NetworkDefaultAction;
}

export interface InboundFirewallRuleManifest {
  displayName: string;
  value: string;
}

export interface InboundFirewallRulesManifest {
  rules: InboundFirewallRuleManifest[];
}

export interface InboundAzureResourceRuleManifest {
  displayName: string;
  resourceId: string;
}

export interface InboundAzureResourceRulesManifest {
  rules: InboundAzureResourceRuleManifest[];
}

export interface InboundExternalDataSharesPolicyManifest {
  defaultAction: NetworkDefaultAction;
}

export interface OutboundConnectionEndpointRuleManifest {
  hostnamePattern: string;
}

export interface OutboundConnectionWorkspaceRuleManifest {
  workspaceId: string;
}

export interface OutboundCloudConnectionRuleManifest {
  connectionType: string;
  defaultAction: NetworkDefaultAction;
  allowedEndpoints?: OutboundConnectionEndpointRuleManifest[];
  allowedWorkspaces?: OutboundConnectionWorkspaceRuleManifest[];
}

export interface OutboundCloudConnectionRulesManifest {
  defaultAction: NetworkDefaultAction;
  rules: OutboundCloudConnectionRuleManifest[];
}

export interface OutboundGatewayRuleManifest {
  id: string;
}

export interface OutboundGatewayRulesManifest {
  defaultAction: NetworkDefaultAction;
  allowedGateways: OutboundGatewayRuleManifest[];
}

export interface ManagedPrivateEndpointManifest {
  name: string;
  desiredState?: DesiredState;
  targetPrivateLinkResourceId: string;
  targetSubresourceType?: string;
  requestMessage?: string;
}

export interface NetworkProtectionManifest {
  workspaceId?: string;
  communicationPolicy: NetworkCommunicationPolicyManifest;
  inboundFirewallRules?: InboundFirewallRulesManifest;
  inboundAzureResourceRules?: InboundAzureResourceRulesManifest;
  inboundExternalDataSharesPolicy?: InboundExternalDataSharesPolicyManifest;
  outboundCloudConnectionRules?: OutboundCloudConnectionRulesManifest;
  outboundGatewayRules?: OutboundGatewayRulesManifest;
  managedPrivateEndpoints?: ManagedPrivateEndpointManifest[];
}

export interface DeploymentManifest {
  apiVersion: "fabric.deploy/v1alpha1";
  kind: "FabricDeployment";
  metadata: {
    deploymentId: string;
  };
  workspace?: WorkspaceDefinition;
  networkProtection?: NetworkProtectionManifest;
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
  sparkJobArtifactSources?: Record<string, SparkJobArtifactSource[]>;
  pipelineDefinitions: Record<string, FabricDefinition>;
  semanticModelDefinitions: Record<string, FabricDefinition>;
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
  resourceKind?: "schema" | "table";
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

export type PlannedOneLakeArtifactAction =
  | "create"
  | "no-op"
  | "blocked";

export interface PlannedOneLakeArtifact {
  action: PlannedOneLakeArtifactAction;
  kind: "executable" | "library";
  operationId: string;
  operationHash: string;
  fileName: string;
  relativeSourcePath: string;
  contentHash: string;
  sizeBytes: number;
  oneLakePath: string;
  abfssUri?: string;
  observedHash: string;
  reason: string;
}

export interface PlannedSparkJobArtifacts {
  targetLakehouseLogicalId: string;
  targetLakehousePhysicalId?: string;
  targetBinding: "physical" | "symbolic";
  oneLakeDfsEndpoint: string;
  oneLakeBlobEndpoint: string;
  stagingHash: string;
  artifacts: PlannedOneLakeArtifact[];
}

export interface PlannedItem {
  logicalId: string;
  type: FabricItemType;
  path: string;
  dependsOn: string[];
  desiredState: DesiredState;
  contentHash: string;
  displayName: string;
  physicalId?: string;
  observedStateHash?: string;
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
  lakehouseTables?: PlannedLakehouseTables;
  sparkJobArtifacts?: PlannedSparkJobArtifacts;
  tagAssignment?: PlannedItemTagAssignment;
  action: PlannedAction;
  reason: string;
}

export interface PlannedItemTagAssignment {
  assignmentHash: string;
  tagLogicalIds: string[];
  missingTagLogicalIds: string[];
  action: Extract<PlannedAction, "update" | "no-op" | "blocked" | "unknown">;
  observedStateHash: string;
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

export type NetworkSurfaceAction = Extract<
  PlannedAction,
  "update" | "no-op" | "blocked" | "unknown"
>;

export interface PlannedNetworkSurface {
  action: NetworkSurfaceAction;
  reason: string;
  desiredHash: string;
  observedStateHash?: string;
}

export interface PlannedNetworkCommunicationPolicy extends PlannedNetworkSurface {
  etag?: string;
  desiredInboundDefaultAction: NetworkDefaultAction;
  desiredOutboundDefaultAction: NetworkDefaultAction;
  observedInboundDefaultAction?: NetworkDefaultAction;
  observedOutboundDefaultAction?: NetworkDefaultAction;
  isRelaxation?: boolean;
  blockedByManagedPrivateEndpoints?: string[];
}

export interface PlannedInboundFirewallRules extends PlannedNetworkSurface {
  etag?: string;
  ruleCount: number;
}

export interface PlannedInboundAzureResourceRules extends PlannedNetworkSurface {
  etag?: string;
  ruleCount: number;
}

export interface PlannedInboundExternalDataSharesPolicy
  extends PlannedNetworkSurface {
  etag?: string;
  desiredDefaultAction: NetworkDefaultAction;
  observedDefaultAction?: NetworkDefaultAction;
  isRelaxation?: boolean;
}

export type ManagedPrivateEndpointAction = Extract<
  PlannedAction,
  "create" | "delete" | "no-op" | "blocked" | "unknown"
>;

export interface PlannedManagedPrivateEndpoint {
  name: string;
  desiredState: DesiredState;
  targetPrivateLinkResourceId: string;
  targetSubresourceType?: string;
  action: ManagedPrivateEndpointAction;
  reason: string;
  operationHash: string;
  desiredIdentityHash: string;
  requestMessageHash?: string;
  physicalId?: string;
  observedIdentityHash?: string;
  observedProvisioningState?: string;
  observedConnectionStatus?: string;
  approvalRequired?: boolean;
  bootstrapBlocked?: boolean;
}

export interface PlannedNetworkProtection {
  workspaceId?: string;
  communicationPolicy: PlannedNetworkCommunicationPolicy;
  inboundFirewallRules?: PlannedInboundFirewallRules;
  inboundAzureResourceRules?: PlannedInboundAzureResourceRules;
  inboundExternalDataSharesPolicy?: PlannedInboundExternalDataSharesPolicy;
  outboundCloudConnectionRules?: PlannedNetworkSurface;
  outboundGatewayRules?: PlannedNetworkSurface;
  managedPrivateEndpoints?: PlannedManagedPrivateEndpoint[];
}

export interface DeploymentPlan {
  schemaVersion: "1";
  mode: ActionMode;
  deploymentId: string;
  environment: string;
  workspaceId: string;
  workspace?: PlannedWorkspace;
  networkProtection?: PlannedNetworkProtection;
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
  | "deleted"
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
  tagAssignment?: {
    assignmentHash: string;
    tagCount: number;
    status: "updated" | "verified";
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
  networkProtection?: ApplyNetworkProtectionResult;
}

export interface ApplyWorkspaceResult {
  action: PlannedAction;
  status: ApplyItemStatus;
  physicalId: string;
  durationMs: number;
  error?: string;
}

export type ApplyNetworkSurfaceStatus =
  | "updated"
  | "verified"
  | "resumed"
  | "deferred";

export interface ApplyNetworkSurfaceResult {
  action: NetworkSurfaceAction;
  status: ApplyNetworkSurfaceStatus;
  durationMs: number;
}

export type ApplyManagedPrivateEndpointStatus =
  | "created"
  | "deleted"
  | "verified"
  | "resumed";

export interface ApplyManagedPrivateEndpointResult {
  name: string;
  action: ManagedPrivateEndpointAction;
  status: ApplyManagedPrivateEndpointStatus;
  physicalId?: string;
  provisioningState?: string;
  connectionStatus?: string;
  approvalRequired?: boolean;
  deletedAt?: string;
  recreateNotBefore?: string;
  durationMs: number;
}

export interface ApplyNetworkProtectionResult {
  workspaceId: string;
  communicationPolicy: ApplyNetworkSurfaceResult;
  inboundFirewallRules?: ApplyNetworkSurfaceResult;
  inboundAzureResourceRules?: ApplyNetworkSurfaceResult;
  inboundExternalDataSharesPolicy?: ApplyNetworkSurfaceResult;
  outboundCloudConnectionRules?: ApplyNetworkSurfaceResult;
  outboundGatewayRules?: ApplyNetworkSurfaceResult;
  managedPrivateEndpoints?: ApplyManagedPrivateEndpointResult[];
}

export interface ApplyCheckpointItem {
  logicalId: string;
  action: PlannedAction;
  physicalId?: string;
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
    | "definition-submitting"
    | "definition-staged"
    | "published"
    | "marker-cleaned";
  stagedDefinitionHash?: string;
  stagedDeploymentMarker?: string;
  publishState?: string;
  targetVersion?: string;
  materializedDefinitionHash?: string;
  resolvedBindingsHash?: string;
  /**
   * SHA-256 of every auxiliary part in the effective Semantic Model
   * full-replacement (`.platform`, `diagramLayout.json`, and `Copilot/**`).
   * Written before definition dispatch so recovery can prove that both managed
   * and preserved auxiliary parts survived an ambiguous replacement.
   */
  preservedAuxiliaryHash?: string;
}

export interface ApplyCheckpointDeleteIntent {
  logicalId: string;
  action: "delete";
  physicalId: string;
  observedStateHash: string;
  submittedAt: string;
}

export interface DefinitionItemUpdateRecoveryState {
  phase: NonNullable<ApplyCheckpointUpdateIntent["phase"]>;
  stagedDefinitionHash: string;
  stagedDeploymentMarker?: string;
  publishState?: string;
  targetVersion?: string;
  /**
   * SHA-256 of every auxiliary part in the effective Semantic Model
   * full-replacement. Used during recovery to confirm that an ambiguous
   * `updateDefinition` did not silently lose managed or preserved parts.
   */
  preservedAuxiliaryHash?: string;
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
  pendingDeletes: Record<string, ApplyCheckpointDeleteIntent>;
  lakehouseTables?: Record<string, ApplyCheckpointLakehouseTables>;
  oneLakeArtifacts?: Record<string, ApplyCheckpointOneLakeArtifacts>;
  tagAssignments?: Record<string, ApplyCheckpointTagAssignment>;
  networkProtection?: ApplyCheckpointNetworkProtection;
}

export interface ApplyCheckpointNetworkSurface {
  desiredHash: string;
  phase: "submitting" | "verified";
  updatedAt: string;
}

export interface ApplyCheckpointManagedPrivateEndpoint {
  name: string;
  desiredState: DesiredState;
  action: Extract<
    ManagedPrivateEndpointAction,
    "create" | "delete" | "no-op"
  >;
  operationHash: string;
  desiredIdentityHash: string;
  phase:
    | "create-submitting"
    | "provisioning"
    | "present-verified"
    | "delete-submitting"
    | "absent-verified";
  physicalId?: string;
  observedIdentityHash?: string;
  observedProvisioningState?: string;
  observedConnectionStatus?: string;
  approvalRequired?: boolean;
  submittedAt?: string;
  verifiedAt?: string;
  deletedAt?: string;
  recreateNotBefore?: string;
  updatedAt: string;
}

export interface ApplyCheckpointNetworkProtection {
  workspaceId: string;
  communicationPolicy?: ApplyCheckpointNetworkSurface;
  inboundFirewallRules?: ApplyCheckpointNetworkSurface;
  inboundAzureResourceRules?: ApplyCheckpointNetworkSurface;
  inboundExternalDataSharesPolicy?: ApplyCheckpointNetworkSurface;
  outboundCloudConnectionRules?: ApplyCheckpointNetworkSurface;
  outboundGatewayRules?: ApplyCheckpointNetworkSurface;
  managedPrivateEndpoints?: Record<
    string,
    ApplyCheckpointManagedPrivateEndpoint
  >;
  completedAt?: string;
  updatedAt: string;
}

export interface ApplyCheckpointTagAssignment {
  logicalId: string;
  assignmentHash: string;
  itemPhysicalId: string;
  tagIds: string[];
  phase: "submitting" | "verified";
  submittedAt: string;
  verifiedAt?: string;
  updatedAt: string;
}

export interface ApplyCheckpointOneLakeArtifact {
  operationId: string;
  operationHash: string;
  fileName: string;
  oneLakePath: string;
  contentHash: string;
  sizeBytes: number;
  phase: "upload-submitting" | "verified";
  submittedAt?: string;
  verifiedAt?: string;
  updatedAt: string;
}

export interface ApplyCheckpointOneLakeArtifacts {
  logicalId: string;
  targetLakehouseLogicalId: string;
  targetLakehouseId: string;
  stagingHash: string;
  artifacts: Record<string, ApplyCheckpointOneLakeArtifact>;
  completedAt?: string;
  updatedAt: string;
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
