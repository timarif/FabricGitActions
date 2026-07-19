import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  canonicalizeArmResourceId,
  hashManagedPrivateEndpointDesiredIdentity,
  managedPrivateEndpointOapBlockers,
} from "./fabric/managed-private-endpoints";
import {
  hashCommunicationPolicy,
  hashInboundExternalDataSharesPolicy,
} from "./fabric/network-protection";
import { compareCanonicalStrings, sha256, stableJson } from "./hash";
import { rehashPlan } from "./planner";
import {
  FABRIC_ITEM_TYPES,
  type DeploymentPlan,
  type NetworkDefaultAction,
  type PlannedAction,
  type PlannedInboundAzureResourceRules,
  type PlannedInboundExternalDataSharesPolicy,
  type PlannedInboundFirewallRules,
  type PlannedItem,
  type PlannedNetworkProtection,
  type PlannedNetworkSurface,
  type PlannedWorkspace,
} from "./types";

const PLANNED_ACTIONS = new Set<PlannedAction>([
  "create",
  "update",
  "delete",
  "no-op",
  "blocked",
  "unknown",
]);

const NETWORK_SURFACE_ACTIONS = new Set(["update", "no-op", "blocked", "unknown"]);
const MANAGED_PRIVATE_ENDPOINT_ACTIONS = new Set([
  "create",
  "delete",
  "no-op",
  "blocked",
  "unknown",
]);
const NETWORK_DEFAULT_ACTIONS = new Set(["Allow", "Deny"]);
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadApprovedPlan(planFile: string): DeploymentPlan {
  const absolutePath = path.resolve(planFile);
  if (!existsSync(absolutePath)) {
    throw new Error(`Approved plan file not found: ${absolutePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch {
    throw new Error(`Approved plan file is not valid JSON: ${absolutePath}`);
  }

  if (!isDeploymentPlan(parsed)) {
    throw new Error(`Approved plan file has an invalid structure: ${absolutePath}`);
  }
  if (parsed.mode !== "plan") {
    throw new Error("Approved plan must have mode 'plan'.");
  }

  const calculatedHash = rehashPlan(parsed).planHash;
  if (calculatedHash !== parsed.planHash) {
    throw new Error(
      `Approved plan hash is invalid. Expected ${calculatedHash}, received ${parsed.planHash}.`,
    );
  }
  return parsed;
}

function isDeploymentPlan(value: unknown): value is DeploymentPlan {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const plan = value as Partial<DeploymentPlan>;
  if (
    plan.schemaVersion === "1" &&
    typeof plan.mode === "string" &&
    typeof plan.deploymentId === "string" &&
    typeof plan.environment === "string" &&
    typeof plan.workspaceId === "string" &&
    (plan.workspace === undefined ||
      isPlannedWorkspace(plan.workspace)) &&
    (plan.networkProtection === undefined ||
      isPlannedNetworkProtection(plan.networkProtection)) &&
    typeof plan.sourceHash === "string" &&
    typeof plan.resolvedHash === "string" &&
    typeof plan.planHash === "string" &&
    typeof plan.generatedAt === "string" &&
    Array.isArray(plan.stages) &&
    Array.isArray(plan.items)
  ) {
    const items = plan.items as unknown[];
    if (!items.every(isPlannedItem)) {
      return false;
    }

    const itemIds = items.map((item) => (item as PlannedItem).logicalId);
    const plannedItems = new Map(
      items.map((item) => {
        const planned = item as PlannedItem;
        return [planned.logicalId, planned] as const;
      }),
    );
    if (
      items.some((value) => {
        const item = value as PlannedItem;
        const assignment = item.tagAssignment;
        return (
          assignment !== undefined &&
          assignment.tagLogicalIds.some((logicalId) => {
            const target = plannedItems.get(logicalId);
            return (
              !target ||
              target.type !== "FabricTag" ||
              !item.dependsOn.includes(logicalId)
            );
          })
        );
      })
    ) {
      return false;
    }
    const stagedIds: string[] = [];
    for (const stage of plan.stages as unknown[]) {
      if (
        !Array.isArray(stage) ||
        !stage.every((logicalId) => typeof logicalId === "string")
      ) {
        return false;
      }
      stagedIds.push(...stage);
    }
    return (
      new Set(itemIds).size === itemIds.length &&
      new Set(stagedIds).size === stagedIds.length &&
      itemIds.length === stagedIds.length &&
      itemIds.every((logicalId) => stagedIds.includes(logicalId)) &&
      (plan.sourceCommit === undefined ||
        typeof plan.sourceCommit === "string")
    );
  }
  return false;
}

function isPlannedWorkspace(
  value: unknown,
): value is PlannedWorkspace {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const workspace = value as Partial<PlannedWorkspace>;
  return (
    typeof workspace.displayName === "string" &&
    typeof workspace.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(workspace.contentHash) &&
    PLANNED_ACTIONS.has(workspace.action as PlannedAction) &&
    typeof workspace.reason === "string" &&
    (workspace.physicalId === undefined ||
      typeof workspace.physicalId === "string") &&
    (workspace.observedStateHash === undefined ||
      typeof workspace.observedStateHash === "string") &&
    (workspace.metadataUpdateRequired === undefined ||
      typeof workspace.metadataUpdateRequired === "boolean") &&
    (workspace.capacityAssignmentRequired === undefined ||
      typeof workspace.capacityAssignmentRequired === "boolean")
  );
}

function isPlannedNetworkProtection(
  value: unknown,
): value is PlannedNetworkProtection {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const allowedKeys = new Set([
    "workspaceId",
    "communicationPolicy",
    "inboundFirewallRules",
    "inboundAzureResourceRules",
    "inboundExternalDataSharesPolicy",
    "outboundCloudConnectionRules",
    "outboundGatewayRules",
    "managedPrivateEndpoints",
  ]);
  if (
    Object.keys(value as Record<string, unknown>).some(
      (key) => !allowedKeys.has(key),
    )
  ) {
    return false;
  }
  const plan = value as Partial<PlannedNetworkProtection>;
  if (
    (plan.workspaceId !== undefined &&
      (typeof plan.workspaceId !== "string" ||
        !GUID_PATTERN.test(plan.workspaceId))) ||
    plan.communicationPolicy === null ||
    typeof plan.communicationPolicy !== "object"
  ) {
    return false;
  }
  const policy = plan.communicationPolicy as unknown as Record<string, unknown>;
  const policyAction = String(policy.action);
  const managedPrivateEndpoints = plan.managedPrivateEndpoints;
  const managedPrivateEndpointsValid =
    managedPrivateEndpoints === undefined ||
    isPlannedManagedPrivateEndpoints(managedPrivateEndpoints);
  const policyBlockers =
    Array.isArray(policy.blockedByManagedPrivateEndpoints)
      ? (policy.blockedByManagedPrivateEndpoints as string[])
      : undefined;
  const policyBlockersValid =
    policyBlockers === undefined ||
    (managedPrivateEndpointsValid &&
      managedPrivateEndpoints !== undefined &&
      stableJson(policyBlockers) ===
        stableJson(
          managedPrivateEndpointOapBlockers(
            managedPrivateEndpoints,
          ),
        ));
  const requiresWorkspaceId =
    policyAction === "update" ||
    policyAction === "no-op" ||
    isManagedPrivateEndpointPolicyBlock(policy) ||
    (managedPrivateEndpoints?.some(
      (endpoint) =>
        endpoint.action === "create" ||
        endpoint.action === "delete" ||
        endpoint.action === "no-op",
    ) ??
      false);
  return (
    isPlannedNetworkCommunicationPolicy(policy) &&
    (!requiresWorkspaceId || typeof plan.workspaceId === "string") &&
    (plan.inboundFirewallRules === undefined ||
      isPlannedInboundFirewallRules(plan.inboundFirewallRules)) &&
    (plan.inboundAzureResourceRules === undefined ||
      isPlannedInboundAzureResourceRules(plan.inboundAzureResourceRules)) &&
    (plan.inboundExternalDataSharesPolicy === undefined ||
      isPlannedInboundExternalDataSharesPolicy(
        plan.inboundExternalDataSharesPolicy,
      )) &&
    (plan.outboundCloudConnectionRules === undefined ||
      isPlannedNetworkSurface(plan.outboundCloudConnectionRules)) &&
    (plan.outboundGatewayRules === undefined ||
      isPlannedNetworkSurface(plan.outboundGatewayRules)) &&
    managedPrivateEndpointsValid &&
    policyBlockersValid &&
    (policy.desiredInboundDefaultAction !== "Deny" ||
      (plan.inboundFirewallRules !== undefined &&
        plan.inboundFirewallRules.ruleCount > 0))
  );
}

function isPlannedInboundFirewallRules(
  value: unknown,
): value is PlannedInboundFirewallRules {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const surface = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "action",
    "reason",
    "desiredHash",
    "observedStateHash",
    "etag",
    "ruleCount",
  ]);
  if (Object.keys(surface).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  const action = String(surface.action);
  const discovered = action === "update" || action === "no-op";
  return (
    isPlannedNetworkSurface(surface) &&
    typeof surface.ruleCount === "number" &&
    Number.isInteger(surface.ruleCount) &&
    surface.ruleCount >= 0 &&
    surface.ruleCount <= 256 &&
    (discovered
      ? isHash(surface.observedStateHash) &&
        (surface.etag === undefined ||
          (typeof surface.etag === "string" &&
            surface.etag.trim().length > 0))
      : surface.observedStateHash === undefined &&
        surface.etag === undefined)
  );
}

function isPlannedInboundAzureResourceRules(
  value: unknown,
): value is PlannedInboundAzureResourceRules {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const surface = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "action",
    "reason",
    "desiredHash",
    "observedStateHash",
    "etag",
    "ruleCount",
  ]);
  if (Object.keys(surface).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  const action = String(surface.action);
  const discovered = action === "update" || action === "no-op";
  return (
    isPlannedNetworkSurface(surface) &&
    typeof surface.ruleCount === "number" &&
    Number.isInteger(surface.ruleCount) &&
    surface.ruleCount >= 0 &&
    (discovered
      ? isHash(surface.observedStateHash) &&
        (surface.etag === undefined ||
          (typeof surface.etag === "string" &&
            surface.etag.trim().length > 0))
      : surface.observedStateHash === undefined &&
        surface.etag === undefined)
  );
}

function isPlannedInboundExternalDataSharesPolicy(
  value: unknown,
): value is PlannedInboundExternalDataSharesPolicy {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const surface = value as Record<string, unknown>;
  const allowedKeys = new Set([
    "action",
    "reason",
    "desiredHash",
    "observedStateHash",
    "etag",
    "desiredDefaultAction",
    "observedDefaultAction",
    "isRelaxation",
  ]);
  if (Object.keys(surface).some((key) => !allowedKeys.has(key))) {
    return false;
  }
  const action = String(surface.action);
  const desiredDefaultAction = surface.desiredDefaultAction;
  if (
    !NETWORK_SURFACE_ACTIONS.has(action) ||
    typeof surface.reason !== "string" ||
    !isHash(surface.desiredHash) ||
    !isNetworkDefaultAction(desiredDefaultAction) ||
    surface.desiredHash !==
      hashInboundExternalDataSharesPolicy({
        defaultAction: desiredDefaultAction,
      })
  ) {
    return false;
  }
  const discovered = action === "update" || action === "no-op";
  if (!discovered) {
    return (
      surface.observedStateHash === undefined &&
      surface.etag === undefined &&
      surface.observedDefaultAction === undefined &&
      surface.isRelaxation === undefined
    );
  }
  const observedDefaultAction = surface.observedDefaultAction;
  if (
    !isNetworkDefaultAction(observedDefaultAction) ||
    !isHash(surface.observedStateHash) ||
    typeof surface.isRelaxation !== "boolean" ||
    (surface.etag !== undefined &&
      (typeof surface.etag !== "string" ||
        surface.etag.trim().length === 0))
  ) {
    return false;
  }
  const observedHash = hashInboundExternalDataSharesPolicy({
    defaultAction: observedDefaultAction,
  });
  const isRelaxation =
    observedDefaultAction === "Deny" && desiredDefaultAction === "Allow";
  return (
    surface.observedStateHash === observedHash &&
    surface.isRelaxation === isRelaxation &&
    (action === "no-op") === (surface.desiredHash === observedHash)
  );
}

function isPlannedNetworkCommunicationPolicy(
  policy: Record<string, unknown>,
): boolean {
  const action = String(policy.action);
  const desiredInbound = policy.desiredInboundDefaultAction;
  const desiredOutbound = policy.desiredOutboundDefaultAction;
  if (
    !NETWORK_SURFACE_ACTIONS.has(action) ||
    typeof policy.reason !== "string" ||
    !isHash(policy.desiredHash) ||
    (policy.observedStateHash !== undefined &&
      !isHash(policy.observedStateHash)) ||
    (policy.etag !== undefined && typeof policy.etag !== "string") ||
    !isNetworkDefaultAction(desiredInbound) ||
    !isNetworkDefaultAction(desiredOutbound)
  ) {
    return false;
  }
  if (
    policy.desiredHash !==
    hashCommunicationPolicy({
      inbound: {
        publicAccessRules: { defaultAction: desiredInbound },
      },
      outbound: {
        publicAccessRules: { defaultAction: desiredOutbound },
      },
    })
  ) {
    return false;
  }

  if (action === "blocked" && isManagedPrivateEndpointPolicyBlock(policy)) {
    const observedInbound = policy.observedInboundDefaultAction;
    const observedOutbound = policy.observedOutboundDefaultAction;
    if (
      !isNetworkDefaultAction(observedInbound) ||
      !isNetworkDefaultAction(observedOutbound) ||
      !isHash(policy.observedStateHash) ||
      typeof policy.isRelaxation !== "boolean" ||
      observedOutbound !== "Allow" ||
      desiredOutbound !== "Deny"
    ) {
      return false;
    }
    const observedHash = hashCommunicationPolicy({
      inbound: {
        publicAccessRules: { defaultAction: observedInbound },
      },
      outbound: {
        publicAccessRules: { defaultAction: observedOutbound },
      },
    });
    const isRelaxation =
      observedInbound === "Deny" && desiredInbound === "Allow";
    return (
      policy.observedStateHash === observedHash &&
      policy.isRelaxation === isRelaxation &&
      policy.desiredHash !== observedHash
    );
  }

  if (action === "blocked" || action === "unknown") {
    return (
      policy.blockedByManagedPrivateEndpoints === undefined &&
      policy.observedStateHash === undefined &&
      policy.observedInboundDefaultAction === undefined &&
      policy.observedOutboundDefaultAction === undefined &&
      policy.isRelaxation === undefined
    );
  }

  const observedInbound = policy.observedInboundDefaultAction;
  const observedOutbound = policy.observedOutboundDefaultAction;
  if (
    !isNetworkDefaultAction(observedInbound) ||
    !isNetworkDefaultAction(observedOutbound) ||
    !isHash(policy.observedStateHash) ||
    typeof policy.isRelaxation !== "boolean" ||
    policy.blockedByManagedPrivateEndpoints !== undefined
  ) {
    return false;
  }
  const observedHash = hashCommunicationPolicy({
    inbound: {
      publicAccessRules: { defaultAction: observedInbound },
    },
    outbound: {
      publicAccessRules: { defaultAction: observedOutbound },
    },
  });
  const isRelaxation =
    (observedInbound === "Deny" && desiredInbound === "Allow") ||
    (observedOutbound === "Deny" && desiredOutbound === "Allow");
  return (
    policy.observedStateHash === observedHash &&
    policy.isRelaxation === isRelaxation &&
    (action === "no-op") === (policy.desiredHash === observedHash)
  );
}

function isManagedPrivateEndpointPolicyBlock(
  policy: Record<string, unknown>,
): boolean {
  const blockers = policy.blockedByManagedPrivateEndpoints;
  if (!Array.isArray(blockers) || blockers.length === 0) {
    return false;
  }
  if (
    !blockers.every(
      (name) =>
        typeof name === "string" &&
        name.length > 0 &&
        name.trim() === name,
    )
  ) {
    return false;
  }
  const canonical = blockers.map((name) => name.toLowerCase());
  return (
    new Set(canonical).size === canonical.length &&
    canonical.every(
      (name, index) =>
        index === 0 ||
        compareCanonicalStrings(canonical[index - 1]!, name) < 0,
    )
  );
}

function isPlannedManagedPrivateEndpoints(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  const canonicalNames: string[] = [];
  for (const entry of value) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      return false;
    }
    const endpoint = entry as Record<string, unknown>;
    const allowedKeys = new Set([
      "name",
      "desiredState",
      "targetPrivateLinkResourceId",
      "targetSubresourceType",
      "action",
      "reason",
      "operationHash",
      "desiredIdentityHash",
      "requestMessageHash",
      "physicalId",
      "observedIdentityHash",
      "observedProvisioningState",
      "observedConnectionStatus",
      "approvalRequired",
      "bootstrapBlocked",
    ]);
    if (Object.keys(endpoint).some((key) => !allowedKeys.has(key))) {
      return false;
    }
    const name = endpoint.name;
    const desiredState = endpoint.desiredState;
    const targetPrivateLinkResourceId =
      endpoint.targetPrivateLinkResourceId;
    const targetSubresourceType = endpoint.targetSubresourceType;
    const action = String(endpoint.action);
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 64 ||
      name.trim() !== name ||
      (desiredState !== "present" && desiredState !== "absent") ||
      typeof targetPrivateLinkResourceId !== "string" ||
      !MANAGED_PRIVATE_ENDPOINT_ACTIONS.has(action) ||
      typeof endpoint.reason !== "string" ||
      !isHash(endpoint.operationHash) ||
      !isHash(endpoint.desiredIdentityHash) ||
      (targetSubresourceType !== undefined &&
        (typeof targetSubresourceType !== "string" ||
          targetSubresourceType.length === 0 ||
          targetSubresourceType.trim() !== targetSubresourceType)) ||
      (endpoint.requestMessageHash !== undefined &&
        !isHash(endpoint.requestMessageHash)) ||
      (endpoint.physicalId !== undefined &&
        (typeof endpoint.physicalId !== "string" ||
          !GUID_PATTERN.test(endpoint.physicalId) ||
          endpoint.physicalId !== endpoint.physicalId.toLowerCase())) ||
      (endpoint.observedIdentityHash !== undefined &&
        !isHash(endpoint.observedIdentityHash)) ||
      (endpoint.observedProvisioningState !== undefined &&
        (typeof endpoint.observedProvisioningState !== "string" ||
          endpoint.observedProvisioningState.length === 0 ||
          endpoint.observedProvisioningState.trim() !==
            endpoint.observedProvisioningState)) ||
      (endpoint.observedConnectionStatus !== undefined &&
        (typeof endpoint.observedConnectionStatus !== "string" ||
          endpoint.observedConnectionStatus.length === 0 ||
          endpoint.observedConnectionStatus.trim() !==
            endpoint.observedConnectionStatus)) ||
      (endpoint.approvalRequired !== undefined &&
        endpoint.approvalRequired !== true) ||
      (endpoint.bootstrapBlocked !== undefined &&
        endpoint.bootstrapBlocked !== true)
    ) {
      return false;
    }
    let canonicalResourceId: string;
    try {
      canonicalResourceId = canonicalizeArmResourceId(
        targetPrivateLinkResourceId,
        "plan targetPrivateLinkResourceId",
      );
    } catch {
      return false;
    }
    if (canonicalResourceId !== targetPrivateLinkResourceId) {
      return false;
    }
    const desiredIdentityHash =
      hashManagedPrivateEndpointDesiredIdentity({
        name,
        targetPrivateLinkResourceId,
        ...(typeof targetSubresourceType === "string"
          ? { targetSubresourceType }
          : {}),
      });
    const operationHash = sha256(
      stableJson({
        name,
        desiredState,
        targetPrivateLinkResourceId,
        targetSubresourceType:
          typeof targetSubresourceType === "string"
            ? targetSubresourceType.toLowerCase()
            : undefined,
        requestMessageHash: endpoint.requestMessageHash,
      }),
    );
    if (
      endpoint.desiredIdentityHash !== desiredIdentityHash ||
      endpoint.operationHash !== operationHash ||
      (desiredState === "present") !==
        (endpoint.requestMessageHash !== undefined)
    ) {
      return false;
    }
    if (
      typeof targetSubresourceType === "string" &&
      (action === "delete" ||
        (action === "no-op" && desiredState === "present")) &&
      endpoint.observedIdentityHash !== desiredIdentityHash
    ) {
      return false;
    }
    if (
      action === "create" &&
      (desiredState !== "present" ||
        endpoint.physicalId !== undefined ||
        endpoint.observedIdentityHash !== undefined ||
        endpoint.observedProvisioningState !== undefined ||
        endpoint.observedConnectionStatus !== undefined ||
        endpoint.approvalRequired !== undefined ||
        endpoint.bootstrapBlocked !== undefined)
    ) {
      return false;
    }
    if (
      action === "delete" &&
      (desiredState !== "absent" ||
        endpoint.physicalId === undefined ||
        endpoint.observedIdentityHash === undefined ||
        endpoint.bootstrapBlocked !== undefined ||
        !isSafeObservedManagedPrivateEndpointState(endpoint))
    ) {
      return false;
    }
    if (action === "no-op") {
      const absentNoOp =
        desiredState === "absent" &&
        endpoint.physicalId === undefined &&
        endpoint.observedIdentityHash === undefined &&
        endpoint.observedProvisioningState === undefined &&
        endpoint.observedConnectionStatus === undefined;
      const presentNoOp =
        desiredState === "present" &&
        endpoint.physicalId !== undefined &&
        endpoint.observedIdentityHash !== undefined &&
        isSafeObservedManagedPrivateEndpointState(endpoint);
      const approvalRequired =
        presentNoOp &&
        managedPrivateEndpointApprovalRequired(endpoint);
      if (
        (!absentNoOp && !presentNoOp) ||
        endpoint.bootstrapBlocked !== undefined ||
        (presentNoOp &&
          (endpoint.approvalRequired === true) !== approvalRequired) ||
        (absentNoOp && endpoint.approvalRequired !== undefined)
      ) {
        return false;
      }
    }
    if (
      action !== "no-op" &&
      endpoint.approvalRequired !== undefined
    ) {
      return false;
    }
    if (
      endpoint.bootstrapBlocked === true &&
      (action !== "blocked" ||
        endpoint.physicalId !== undefined ||
        endpoint.observedIdentityHash !== undefined ||
        endpoint.observedProvisioningState !== undefined ||
        endpoint.observedConnectionStatus !== undefined)
    ) {
      return false;
    }
    canonicalNames.push(name.toLowerCase());
  }
  return (
    new Set(canonicalNames).size === canonicalNames.length &&
    canonicalNames.every(
      (name, index) =>
        index === 0 ||
        compareCanonicalStrings(canonicalNames[index - 1]!, name) < 0,
    )
  );
}

function isSafeObservedManagedPrivateEndpointState(
  endpoint: Record<string, unknown>,
): boolean {
  const provisioningState =
    typeof endpoint.observedProvisioningState === "string"
      ? endpoint.observedProvisioningState.toLowerCase()
      : undefined;
  const connectionStatus =
    typeof endpoint.observedConnectionStatus === "string"
      ? endpoint.observedConnectionStatus.toLowerCase()
      : undefined;
  if (
    provisioningState !== "provisioning" &&
    provisioningState !== "updating" &&
    provisioningState !== "succeeded"
  ) {
    return false;
  }
  if (
    connectionStatus !== undefined &&
    connectionStatus !== "pending" &&
    connectionStatus !== "approved"
  ) {
    return false;
  }
  return (
    provisioningState !== "succeeded" ||
    connectionStatus === "pending" ||
    connectionStatus === "approved"
  );
}

function managedPrivateEndpointApprovalRequired(
  endpoint: Record<string, unknown>,
): boolean {
  return (
    String(endpoint.observedProvisioningState).toLowerCase() !==
      "succeeded" ||
    String(endpoint.observedConnectionStatus).toLowerCase() ===
      "pending"
  );
}

function isPlannedNetworkSurface(
  value: unknown,
): value is PlannedNetworkSurface {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const surface = value as Record<string, unknown>;
  return (
    NETWORK_SURFACE_ACTIONS.has(String(surface.action)) &&
    typeof surface.reason === "string" &&
    isHash(surface.desiredHash) &&
    (surface.observedStateHash === undefined ||
      isHash(surface.observedStateHash))
  );
}

function isNetworkDefaultAction(
  value: unknown,
): value is NetworkDefaultAction {
  return NETWORK_DEFAULT_ACTIONS.has(String(value)) && typeof value === "string";
}

function isPlannedItem(value: unknown): value is PlannedItem {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<PlannedItem>;
  return (
    typeof item.logicalId === "string" &&
    FABRIC_ITEM_TYPES.some((type) => type === item.type) &&
    typeof item.path === "string" &&
    Array.isArray(item.dependsOn) &&
    item.dependsOn.every((dependency) => typeof dependency === "string") &&
    (item.desiredState === "present" ||
      item.desiredState === "absent") &&
    typeof item.contentHash === "string" &&
    typeof item.displayName === "string" &&
    PLANNED_ACTIONS.has(item.action as PlannedAction) &&
    typeof item.reason === "string" &&
    (item.physicalId === undefined || typeof item.physicalId === "string") &&
    (item.observedStateHash === undefined ||
      typeof item.observedStateHash === "string") &&
    (item.desiredState === "absent"
      ? item.action !== "create" &&
        item.action !== "update" &&
        item.tagAssignment === undefined &&
        item.lakehouseTables === undefined &&
        item.sparkJobArtifacts === undefined
      : item.action !== "delete") &&
    (item.action !== "delete" ||
      (typeof item.physicalId === "string" &&
        isHash(item.observedStateHash))) &&
    (item.materializedDefinitionHash === undefined ||
      /^[a-f0-9]{64}$/.test(item.materializedDefinitionHash)) &&
    (item.resolvedBindingsHash === undefined ||
      /^[a-f0-9]{64}$/.test(item.resolvedBindingsHash)) &&
    (item.materializedDefinitionHash === undefined) ===
      (item.resolvedBindingsHash === undefined) &&
    (item.type === "LakehouseTables"
      ? item.lakehouseTables === undefined
        ? item.action === "blocked" || item.action === "unknown"
        : isPlannedLakehouseTables(item.lakehouseTables)
      : item.lakehouseTables === undefined) &&
    (item.type === "SparkJobDefinition"
      ? item.sparkJobArtifacts === undefined ||
        isPlannedSparkJobArtifacts(item.sparkJobArtifacts)
      : item.sparkJobArtifacts === undefined) &&
    (item.tagAssignment === undefined ||
      (item.type !== "FabricTag" &&
        item.type !== "LakehouseTables" &&
        item.type !== "SparkCustomPool" &&
        isPlannedItemTagAssignment(item.tagAssignment)))
  );
}

function isPlannedItemTagAssignment(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const assignment = value as Record<string, unknown>;
  const tagLogicalIds = assignment.tagLogicalIds;
  const missingTagLogicalIds = assignment.missingTagLogicalIds;
  if (
    !isHash(assignment.assignmentHash) ||
    !Array.isArray(tagLogicalIds) ||
    tagLogicalIds.length === 0 ||
    new Set(tagLogicalIds).size !== tagLogicalIds.length ||
    !tagLogicalIds.every(
      (logicalId) => typeof logicalId === "string",
    ) ||
    !Array.isArray(missingTagLogicalIds) ||
    new Set(missingTagLogicalIds).size !==
      missingTagLogicalIds.length ||
    !missingTagLogicalIds.every(
      (logicalId) =>
        typeof logicalId === "string" &&
        tagLogicalIds.includes(logicalId),
    ) ||
    !["update", "no-op", "blocked", "unknown"].includes(
      String(assignment.action),
    ) ||
    typeof assignment.observedStateHash !== "string" ||
    typeof assignment.reason !== "string"
  ) {
    return false;
  }
  return (
    (assignment.action !== "no-op" ||
      missingTagLogicalIds.length === 0) &&
    (assignment.action !== "update" ||
      missingTagLogicalIds.length > 0)
  );
}

function isPlannedSparkJobArtifacts(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const staging = value as Record<string, unknown>;
  if (
    typeof staging.targetLakehouseLogicalId !== "string" ||
    (staging.targetLakehousePhysicalId !== undefined &&
      typeof staging.targetLakehousePhysicalId !== "string") ||
    (staging.targetBinding !== "physical" &&
      staging.targetBinding !== "symbolic") ||
    !isOneLakeRootEndpoint(staging.oneLakeDfsEndpoint) ||
    !isOneLakeRootEndpoint(staging.oneLakeBlobEndpoint) ||
    !isHash(staging.stagingHash) ||
    !Array.isArray(staging.artifacts) ||
    staging.artifacts.length === 0 ||
    (staging.targetBinding === "physical") !==
      (typeof staging.targetLakehousePhysicalId === "string")
  ) {
    return false;
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  let executableCount = 0;
  const artifactsValid = staging.artifacts.every((value) => {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value)
    ) {
      return false;
    }
    const artifact = value as Record<string, unknown>;
    if (
      !["create", "no-op", "blocked"].includes(
        String(artifact.action),
      ) ||
      (artifact.kind !== "executable" &&
        artifact.kind !== "library") ||
      typeof artifact.operationId !== "string" ||
      !isHash(artifact.operationHash) ||
      typeof artifact.fileName !== "string" ||
      typeof artifact.relativeSourcePath !== "string" ||
      (artifact.kind === "executable"
        ? artifact.fileName !== "main.jar" ||
          artifact.relativeSourcePath !== "definition/main.jar"
        : !artifact.relativeSourcePath.startsWith(
            "definition/libs/",
          )) ||
      !isHash(artifact.contentHash) ||
      typeof artifact.sizeBytes !== "number" ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes < 0 ||
      typeof artifact.oneLakePath !== "string" ||
      !artifact.oneLakePath.startsWith("Files/.fabric-deploy/") ||
      (artifact.abfssUri !== undefined &&
        (typeof artifact.abfssUri !== "string" ||
          !isOneLakeAbfssUri(
            artifact.abfssUri,
            staging.oneLakeDfsEndpoint as string,
          ))) ||
      typeof artifact.observedHash !== "string" ||
      typeof artifact.reason !== "string" ||
      names.has(artifact.fileName) ||
      paths.has(artifact.oneLakePath) ||
      (staging.targetBinding === "physical") !==
        (typeof artifact.abfssUri === "string")
    ) {
      return false;
    }
    if (artifact.kind === "executable") {
      executableCount += 1;
    }
    names.add(artifact.fileName);
    paths.add(artifact.oneLakePath);
    return true;
  });
  return artifactsValid && executableCount === 1;
}

function isOneLakeRootEndpoint(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function isOneLakeAbfssUri(
  value: string,
  dfsEndpoint: string,
): boolean {
  try {
    const uri = new URL(value);
    const dfs = new URL(dfsEndpoint);
    return (
      uri.protocol === "abfss:" &&
      uri.username.length > 0 &&
      !uri.password &&
      uri.hostname === dfs.hostname
    );
  } catch {
    return false;
  }
}

function isPlannedLakehouseTables(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const plan = value as Record<string, unknown>;
  if (
    typeof plan.targetLakehouseLogicalId !== "string" ||
    (plan.targetLakehousePhysicalId !== undefined &&
      typeof plan.targetLakehousePhysicalId !== "string") ||
    (plan.targetBinding !== "physical" &&
      plan.targetBinding !== "symbolic") ||
    !isHash(plan.desiredHash) ||
    !isHash(plan.sourceHash) ||
    typeof plan.observedStateHash !== "string" ||
    !Array.isArray(plan.operations)
  ) {
    return false;
  }
  if (
    (plan.targetBinding === "physical") !==
    (typeof plan.targetLakehousePhysicalId === "string")
  ) {
    return false;
  }
  return plan.operations.every((operation, index) => {
    if (
      operation === null ||
      typeof operation !== "object" ||
      Array.isArray(operation)
    ) {
      return false;
    }
    const entry = operation as Record<string, unknown>;
    return (
      ["create", "adopt", "no-op", "blocked"].includes(
        String(entry.action),
      ) &&
      (entry.resourceKind === undefined ||
        entry.resourceKind === "schema" ||
        entry.resourceKind === "table") &&
      (entry.resourceKind !== "schema" ||
        entry.action === "create" ||
        entry.action === "no-op") &&
      typeof entry.operationId === "string" &&
      isHash(entry.operationHash) &&
      entry.order === index &&
      typeof entry.logicalId === "string" &&
      typeof entry.identifier === "string" &&
      isHash(entry.desiredHash) &&
      typeof entry.observedHash === "string" &&
      typeof entry.reason === "string"
    );
  });
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
