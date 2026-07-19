import { writeCheckpoint } from "./checkpoint";
import { FabricApiError } from "./fabric/client";
import { stableJson } from "./hash";
import {
  hashCommunicationPolicy,
  hashInboundAzureResourceRules,
  hashInboundFirewallRules,
  hashOutboundCloudConnectionRules,
  hashOutboundGatewayRules,
  normalizeNetworkProtection,
  OAP_NOT_ENABLED_SENTINEL_HASH,
  type NetworkProtectionAdapter,
} from "./fabric/network-protection";
import {
  managedPrivateEndpointCheckpointKey,
  type ManagedPrivateEndpointAdapter,
} from "./fabric/managed-private-endpoints";
import {
  assertManagedPrivateEndpointDesiredConfigurationMatchesPlan,
  managedPrivateEndpointsRequireRecovery,
  preflightManagedPrivateEndpoints,
  recoverInterruptedManagedPrivateEndpoints,
} from "./managed-private-endpoint-apply";
import type {
  ApplyCheckpoint,
  ApplyCheckpointManagedPrivateEndpoint,
  ApplyCheckpointNetworkProtection,
  ApplyCheckpointNetworkSurface,
  ApplyNetworkProtectionResult,
  ApplyNetworkSurfaceResult,
  DeploymentPlan,
  NetworkProtectionManifest,
  PlannedNetworkCommunicationPolicy,
  PlannedInboundAzureResourceRules,
  PlannedInboundFirewallRules,
  PlannedManagedPrivateEndpoint,
  PlannedNetworkProtection,
  PlannedNetworkSurface,
} from "./types";

export interface ApplyNetworkProtectionOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  desired: NetworkProtectionManifest | undefined;
  adapter?: Pick<
    NetworkProtectionAdapter,
    | "plan"
    | "getCommunicationPolicy"
    | "putCommunicationPolicy"
    | "getOutboundCloudConnectionRules"
    | "putOutboundCloudConnectionRules"
    | "getOutboundGatewayRules"
    | "putOutboundGatewayRules"
  > &
    Partial<
      Pick<
        NetworkProtectionAdapter,
        | "getInboundFirewallRules"
        | "putInboundFirewallRules"
        | "getInboundAzureResourceRules"
        | "putInboundAzureResourceRules"
      >
    >;
  managedPrivateEndpointAdapter?: Pick<
    ManagedPrivateEndpointAdapter,
    | "listManagedPrivateEndpoints"
    | "getManagedPrivateEndpoint"
    | "createManagedPrivateEndpoint"
    | "deleteManagedPrivateEndpoint"
    | "waitForProvisioningSucceeded"
  >;
  checkpoint: ApplyCheckpoint;
  checkpointFile: string;
  allowNetworkPolicyUpdate: boolean;
  allowNetworkPolicyRelaxation: boolean;
  allowInboundFirewallUpdate?: boolean;
  allowInboundAzureResourceRuleUpdate?: boolean;
  acknowledgeFirewallLockoutRisk?: boolean;
  allowOutboundCloudConnectionRuleUpdate: boolean;
  allowOutboundGatewayRuleUpdate: boolean;
  allowManagedPrivateEndpointCreate?: boolean;
  allowManagedPrivateEndpointDelete?: boolean;
  now?: () => number;
}

type CheckpointSurfaceKey =
  | "communicationPolicy"
  | "inboundFirewallRules"
  | "inboundAzureResourceRules"
  | "outboundCloudConnectionRules"
  | "outboundGatewayRules";

/**
 * Preflights every configured network protection surface: authorization is
 * required for any surface not yet fully verified, and any surface without
 * in-flight checkpoint state must match the freshly discovered current plan
 * exactly. Called before any Fabric item is mutated.
 */
export function preflightNetworkProtection(options: {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  checkpoint: ApplyCheckpoint;
  allowNetworkPolicyUpdate: boolean;
  allowNetworkPolicyRelaxation: boolean;
  allowInboundFirewallUpdate?: boolean;
  allowInboundAzureResourceRuleUpdate?: boolean;
  acknowledgeFirewallLockoutRisk?: boolean;
  allowOutboundCloudConnectionRuleUpdate: boolean;
  allowOutboundGatewayRuleUpdate: boolean;
  allowManagedPrivateEndpointCreate?: boolean;
  allowManagedPrivateEndpointDelete?: boolean;
}): void {
  const planned = options.approvedPlan.networkProtection;
  const checkpointState = options.checkpoint.networkProtection;
  if (!planned) {
    if (checkpointState) {
      throw new Error(
        "Checkpoint contains network protection state, but the approved plan does not configure networkProtection.",
      );
    }
    return;
  }
  assertPlanIsApplicable(planned);
  const current = options.currentPlan.networkProtection;
  if (!current) {
    throw new Error(
      "Current network protection plan is missing. Generate a new plan.",
    );
  }
  assertPlanIsApplicable(current);
  assertNoUnexpectedDrift(planned, current, checkpointState);
  assertInboundFirewallLockoutAuthorization({
    planned,
    checkpoint: checkpointState,
    allowNetworkPolicyUpdate: options.allowNetworkPolicyUpdate,
    allowInboundFirewallUpdate:
      options.allowInboundFirewallUpdate ?? false,
    acknowledgeFirewallLockoutRisk:
      options.acknowledgeFirewallLockoutRisk ?? false,
  });
  preflightManagedPrivateEndpoints({
    approvedPlan: options.approvedPlan,
    currentPlan: options.currentPlan,
    checkpoint: options.checkpoint,
    allowManagedPrivateEndpointCreate:
      options.allowManagedPrivateEndpointCreate ?? false,
    allowManagedPrivateEndpointDelete:
      options.allowManagedPrivateEndpointDelete ?? false,
  });

  assertPreflightSurfaceAuthorized(
    planned.communicationPolicy,
    checkpointState?.communicationPolicy,
    () => {
      if (!options.allowNetworkPolicyUpdate) {
        throw new Error(
          "The approved plan requires a network communication policy update, but allow-network-policy-update is false.",
        );
      }
      if (
        isCommunicationPolicyRelaxation(planned.communicationPolicy) &&
        !options.allowNetworkPolicyRelaxation
      ) {
        throw new Error(
          "The approved plan relaxes the network communication policy (an inbound or outbound Deny -> Allow transition), but allow-network-policy-relaxation is false.",
        );
      }
    },
  );
  if (planned.inboundFirewallRules) {
    assertPreflightSurfaceAuthorized(
      planned.inboundFirewallRules,
      checkpointState?.inboundFirewallRules,
      () => {
        if (!options.allowInboundFirewallUpdate) {
          throw new Error(
            "The approved plan requires an inbound firewall update, but allow-inbound-firewall-update is false.",
          );
        }
      },
    );
  }
  if (planned.inboundAzureResourceRules) {
    assertPreflightSurfaceAuthorized(
      planned.inboundAzureResourceRules,
      checkpointState?.inboundAzureResourceRules,
      () => {
        if (!options.allowInboundAzureResourceRuleUpdate) {
          throw new Error(
            "The approved plan requires an inbound Azure resource rule update, but allow-inbound-azure-resource-rule-update is false.",
          );
        }
      },
    );
  }
  if (planned.outboundCloudConnectionRules) {
    assertPreflightSurfaceAuthorized(
      planned.outboundCloudConnectionRules,
      checkpointState?.outboundCloudConnectionRules,
      () => {
        if (!options.allowOutboundCloudConnectionRuleUpdate) {
          throw new Error(
            "The approved plan requires an outbound cloud connection rule update, but allow-outbound-cloud-connection-rule-update is false.",
          );
        }
      },
    );
  }
  if (planned.outboundGatewayRules) {
    assertPreflightSurfaceAuthorized(
      planned.outboundGatewayRules,
      checkpointState?.outboundGatewayRules,
      () => {
        if (!options.allowOutboundGatewayRuleUpdate) {
          throw new Error(
            "The approved plan requires an outbound gateway rule update, but allow-outbound-gateway-rule-update is false.",
          );
        }
      },
    );
  }
}

/**
 * Completes a previously started network protection mutation unit immediately
 * after workspace resolution, before any item checkpoint is reconciled.
 * Does nothing when no surface has been approached.
 */
export async function recoverInterruptedNetworkProtection(
  options: ApplyNetworkProtectionOptions,
): Promise<void> {
  const managedPrivateEndpointRecovery =
    managedPrivateEndpointsRequireRecovery(
      options.checkpoint.networkProtection,
    );
  const oapRecovery = networkProtectionRequiresRecovery(
    options.approvedPlan.networkProtection,
    options.checkpoint.networkProtection,
  );
  if (!managedPrivateEndpointRecovery && !oapRecovery) {
    return;
  }
  if (!options.desired) {
    throw new Error("The networkProtection manifest definition is missing.");
  }
  if (!options.adapter) {
    throw new Error(
      "Network protection recovery requires a network protection adapter.",
    );
  }
  const currentNetworkProtection = await options.adapter.plan(
    options.approvedPlan.workspaceId,
    options.desired,
  );
  const currentPlan = {
    ...options.currentPlan,
    networkProtection: currentNetworkProtection,
  };
  preflightNetworkProtection({
    approvedPlan: options.approvedPlan,
    currentPlan,
    checkpoint: options.checkpoint,
    allowNetworkPolicyUpdate: options.allowNetworkPolicyUpdate,
    allowNetworkPolicyRelaxation:
      options.allowNetworkPolicyRelaxation,
    allowInboundFirewallUpdate:
      options.allowInboundFirewallUpdate ?? false,
    allowInboundAzureResourceRuleUpdate:
      options.allowInboundAzureResourceRuleUpdate ?? false,
    acknowledgeFirewallLockoutRisk:
      options.acknowledgeFirewallLockoutRisk ?? false,
    allowOutboundCloudConnectionRuleUpdate:
      options.allowOutboundCloudConnectionRuleUpdate,
    allowOutboundGatewayRuleUpdate:
      options.allowOutboundGatewayRuleUpdate,
    allowManagedPrivateEndpointCreate:
      options.allowManagedPrivateEndpointCreate ?? false,
    allowManagedPrivateEndpointDelete:
      options.allowManagedPrivateEndpointDelete ?? false,
  });
  if (managedPrivateEndpointRecovery) {
    await recoverInterruptedManagedPrivateEndpoints({
      approvedPlan: options.approvedPlan,
      currentPlan,
      desired: options.desired,
      adapter: options.managedPrivateEndpointAdapter,
      checkpoint: options.checkpoint,
      checkpointFile: options.checkpointFile,
      allowManagedPrivateEndpointCreate:
        options.allowManagedPrivateEndpointCreate ?? false,
      allowManagedPrivateEndpointDelete:
        options.allowManagedPrivateEndpointDelete ?? false,
      now: options.now,
    });
  }
  if (!oapRecovery) {
    return;
  }
  await applyNetworkProtection({
    ...options,
    currentPlan,
  });
}

/**
 * Applies (or verifies) every configured network protection surface. Safe to
 * call more than once in the same run: surfaces already checkpointed as
 * verified are only re-verified, never re-mutated.
 */
export async function applyNetworkProtection(
  options: ApplyNetworkProtectionOptions,
): Promise<ApplyNetworkProtectionResult | undefined> {
  const planned = options.approvedPlan.networkProtection;
  if (!planned) {
    if (options.checkpoint.networkProtection) {
      throw new Error(
        "Checkpoint contains network protection state, but the approved plan does not configure networkProtection.",
      );
    }
    return undefined;
  }
  if (!options.desired) {
    throw new Error("The networkProtection manifest definition is missing.");
  }
  if (!options.adapter) {
    throw new Error(
      "Network protection apply requires a network protection adapter.",
    );
  }
  assertPlanIsApplicable(planned);

  const now = options.now ?? Date.now;
  const workspaceId = requirePlannedWorkspaceId(planned);
  const canonical = normalizeNetworkProtection(options.desired);
  const desiredWorkspaceId =
    canonical.workspaceId ?? options.approvedPlan.workspaceId;
  assertWorkspaceIdMatches(
    workspaceId,
    desiredWorkspaceId,
    "manifest",
  );
  assertDesiredConfigurationMatchesPlan(planned, canonical);
  assertInboundFirewallLockoutAuthorization({
    planned,
    checkpoint: options.checkpoint.networkProtection,
    allowNetworkPolicyUpdate: options.allowNetworkPolicyUpdate,
    allowInboundFirewallUpdate:
      options.allowInboundFirewallUpdate ?? false,
    acknowledgeFirewallLockoutRisk:
      options.acknowledgeFirewallLockoutRisk ?? false,
  });
  if (
    isManagedPrivateEndpointPolicyBlock(
      planned.communicationPolicy,
    )
  ) {
    if (
      options.checkpoint.networkProtection?.communicationPolicy ||
      options.checkpoint.networkProtection?.inboundFirewallRules ||
      options.checkpoint.networkProtection?.inboundAzureResourceRules ||
      options.checkpoint.networkProtection
        ?.outboundCloudConnectionRules ||
      options.checkpoint.networkProtection?.outboundGatewayRules
    ) {
      throw new Error(
        "The approved plan defers outbound access protection for managed private endpoint approval, but the checkpoint already contains an OAP mutation.",
      );
    }
    return {
      workspaceId,
      communicationPolicy: {
        action: planned.communicationPolicy.action,
        status: "deferred",
        durationMs: 0,
      },
      ...(planned.inboundFirewallRules
        ? {
            inboundFirewallRules: {
              action: planned.inboundFirewallRules.action,
              status: "deferred" as const,
              durationMs: 0,
            },
          }
        : {}),
      ...(planned.inboundAzureResourceRules
        ? {
            inboundAzureResourceRules: {
              action: planned.inboundAzureResourceRules.action,
              status: "deferred" as const,
              durationMs: 0,
            },
          }
        : {}),
      ...(planned.outboundCloudConnectionRules
        ? {
            outboundCloudConnectionRules: {
              action:
                planned.outboundCloudConnectionRules.action,
              status: "deferred" as const,
              durationMs: 0,
            },
          }
        : {}),
      ...(planned.outboundGatewayRules
        ? {
            outboundGatewayRules: {
              action: planned.outboundGatewayRules.action,
              status: "deferred" as const,
              durationMs: 0,
            },
          }
        : {}),
    };
  }
  const fresh = await options.adapter.plan(
    options.approvedPlan.workspaceId,
    options.desired,
  );
  assertPlanIsApplicable(fresh);
  assertNoUnexpectedDrift(
    planned,
    fresh,
    options.checkpoint.networkProtection,
  );
  assertInboundFirewallLockoutAuthorization({
    planned,
    checkpoint: options.checkpoint.networkProtection,
    allowNetworkPolicyUpdate: options.allowNetworkPolicyUpdate,
    allowInboundFirewallUpdate:
      options.allowInboundFirewallUpdate ?? false,
    acknowledgeFirewallLockoutRisk:
      options.acknowledgeFirewallLockoutRisk ?? false,
  });

  ensureCheckpointInitialized(options, workspaceId, now);

  const inboundRelaxing =
    planned.communicationPolicy.observedInboundDefaultAction === "Deny" &&
    planned.communicationPolicy.desiredInboundDefaultAction === "Allow";
  const outboundTightening =
    planned.communicationPolicy.observedOutboundDefaultAction === "Allow" &&
    planned.communicationPolicy.desiredOutboundDefaultAction === "Deny";

  let communicationPolicyResult: ApplyNetworkSurfaceResult | undefined;
  let inboundFirewallRulesResult: ApplyNetworkSurfaceResult | undefined;
  let inboundAzureResourceRulesResult: ApplyNetworkSurfaceResult | undefined;
  let outboundCloudConnectionRulesResult: ApplyNetworkSurfaceResult | undefined;
  let outboundGatewayRulesResult: ApplyNetworkSurfaceResult | undefined;

  // Pre-policy phase:
  // - Inbound Allow -> Deny stages and verifies every inbound exception
  //   surface first (firewall rules, then Azure resource instance rules).
  // - Outbound rule bodies run first unless OAP itself is being enabled,
  //   because those APIs are unavailable before outbound Deny is active.
  if (!inboundRelaxing) {
    inboundFirewallRulesResult = await applyInboundFirewallRulesSurface(
      options,
      workspaceId,
      planned,
      fresh,
      canonical,
      now,
    );
    inboundAzureResourceRulesResult =
      await applyInboundAzureResourceRulesSurface(
        options,
        workspaceId,
        planned,
        fresh,
        canonical,
        now,
      );
  }
  if (!outboundTightening) {
    outboundCloudConnectionRulesResult = await applyOutboundCloudConnectionRulesSurface(
      options,
      workspaceId,
      planned,
      canonical,
      now,
    );
    outboundGatewayRulesResult = await applyOutboundGatewayRulesSurface(
      options,
      workspaceId,
      planned,
      canonical,
      now,
    );
  }

  communicationPolicyResult = await applyCommunicationPolicySurface(
    options,
    workspaceId,
    planned,
    fresh,
    canonical,
    now,
  );

  // Post-policy phase:
  // - Inbound Deny -> Allow opens the master policy before any inbound
  //   exception surface relaxation/removal (firewall rules, then Azure
  //   resource instance rules).
  // - Outbound Allow -> Deny enables OAP before its configured rule bodies.
  if (inboundRelaxing) {
    inboundFirewallRulesResult = await applyInboundFirewallRulesSurface(
      options,
      workspaceId,
      planned,
      fresh,
      canonical,
      now,
    );
    inboundAzureResourceRulesResult =
      await applyInboundAzureResourceRulesSurface(
        options,
        workspaceId,
        planned,
        fresh,
        canonical,
        now,
      );
  }
  if (outboundTightening) {
    outboundCloudConnectionRulesResult = await applyOutboundCloudConnectionRulesSurface(
      options,
      workspaceId,
      planned,
      canonical,
      now,
    );
    outboundGatewayRulesResult = await applyOutboundGatewayRulesSurface(
      options,
      workspaceId,
      planned,
      canonical,
      now,
    );
  }

  markNetworkProtectionCompleted(options, now);
  return {
    workspaceId,
    communicationPolicy: communicationPolicyResult!,
    ...(inboundFirewallRulesResult
      ? { inboundFirewallRules: inboundFirewallRulesResult }
      : {}),
    ...(inboundAzureResourceRulesResult
      ? { inboundAzureResourceRules: inboundAzureResourceRulesResult }
      : {}),
    ...(outboundCloudConnectionRulesResult
      ? { outboundCloudConnectionRules: outboundCloudConnectionRulesResult }
      : {}),
    ...(outboundGatewayRulesResult
      ? { outboundGatewayRules: outboundGatewayRulesResult }
      : {}),
  };
}

export function finalizeNetworkProtectionCheckpoint(
  options: ApplyNetworkProtectionOptions,
): void {
  markNetworkProtectionCompleted(options, options.now ?? Date.now);
}

async function applyCommunicationPolicySurface(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  planned: PlannedNetworkProtection,
  fresh: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
  now: () => number,
): Promise<ApplyNetworkSurfaceResult | undefined> {
  const surface = planned.communicationPolicy;
  return applySurface({
    label: "communication policy",
    planned: surface,
    checkpointKey: "communicationPolicy",
    options,
    now,
    authorize: () => {
      if (!options.allowNetworkPolicyUpdate) {
        throw new Error(
          "The approved plan requires a network communication policy update, but allow-network-policy-update is false.",
        );
      }
      if (
        isCommunicationPolicyRelaxation(surface) &&
        !options.allowNetworkPolicyRelaxation
      ) {
        throw new Error(
          "The approved plan relaxes the network communication policy (an inbound or outbound Deny -> Allow transition), but allow-network-policy-relaxation is false.",
        );
      }
    },
    dispatch: async (onDispatch) => {
      await options.adapter!.putCommunicationPolicy(
        workspaceId,
        canonical.communicationPolicy,
        {
          ...(fresh?.communicationPolicy.etag
            ? { ifMatchEtag: fresh.communicationPolicy.etag }
            : {}),
          onDispatch,
        },
      );
    },
    verify: async () => {
      const observed = await options.adapter!.getCommunicationPolicy(workspaceId);
      return hashCommunicationPolicy(observed.policy) === surface.desiredHash;
    },
  });
}

async function applyInboundFirewallRulesSurface(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  planned: PlannedNetworkProtection,
  fresh: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
  now: () => number,
): Promise<ApplyNetworkSurfaceResult | undefined> {
  const surface = planned.inboundFirewallRules;
  if (!surface) {
    return undefined;
  }
  const desired = canonical.inboundFirewallRules;
  if (!desired) {
    throw new Error(
      "Approved plan configures inboundFirewallRules, but the manifest no longer declares them.",
    );
  }
  const adapter = options.adapter;
  if (
    !adapter?.getInboundFirewallRules ||
    !adapter.putInboundFirewallRules
  ) {
    throw new Error(
      "Inbound firewall apply requires inbound firewall adapter methods.",
    );
  }
  const getInboundFirewallRules =
    adapter.getInboundFirewallRules.bind(adapter);
  const putInboundFirewallRules =
    adapter.putInboundFirewallRules.bind(adapter);
  const freshSurface = fresh.inboundFirewallRules;
  const freshEtag = freshSurface?.etag;
  return applySurface({
    label: "inbound firewall rules",
    planned: surface,
    checkpointKey: "inboundFirewallRules",
    options,
    now,
    authorize: () => {
      if (!options.allowInboundFirewallUpdate) {
        throw new Error(
          "The approved plan requires an inbound firewall update, but allow-inbound-firewall-update is false.",
        );
      }
    },
    dispatch: async (onDispatch) => {
      await putInboundFirewallRules(
        workspaceId,
        desired,
        {
          ...(freshEtag ? { ifMatchEtag: freshEtag } : {}),
          onDispatch,
        },
      );
    },
    verify: async () => {
      const observed = await getInboundFirewallRules(workspaceId);
      return (
        hashInboundFirewallRules(observed.configuration) ===
        surface.desiredHash
      );
    },
  });
}

async function applyInboundAzureResourceRulesSurface(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  planned: PlannedNetworkProtection,
  fresh: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
  now: () => number,
): Promise<ApplyNetworkSurfaceResult | undefined> {
  const surface = planned.inboundAzureResourceRules;
  if (!surface) {
    return undefined;
  }
  const desired = canonical.inboundAzureResourceRules;
  if (!desired) {
    throw new Error(
      "Approved plan configures inboundAzureResourceRules, but the manifest no longer declares them.",
    );
  }
  const adapter = options.adapter;
  if (
    !adapter?.getInboundAzureResourceRules ||
    !adapter.putInboundAzureResourceRules
  ) {
    throw new Error(
      "Inbound Azure resource rule apply requires inbound Azure resource rule adapter methods.",
    );
  }
  const getInboundAzureResourceRules =
    adapter.getInboundAzureResourceRules.bind(adapter);
  const putInboundAzureResourceRules =
    adapter.putInboundAzureResourceRules.bind(adapter);
  const freshSurface = fresh.inboundAzureResourceRules;
  const freshEtag = freshSurface?.etag;
  return applySurface({
    label: "inbound Azure resource rules",
    planned: surface,
    checkpointKey: "inboundAzureResourceRules",
    options,
    now,
    authorize: () => {
      if (!options.allowInboundAzureResourceRuleUpdate) {
        throw new Error(
          "The approved plan requires an inbound Azure resource rule update, but allow-inbound-azure-resource-rule-update is false.",
        );
      }
    },
    dispatch: async (onDispatch) => {
      await putInboundAzureResourceRules(
        workspaceId,
        desired,
        {
          ...(freshEtag ? { ifMatchEtag: freshEtag } : {}),
          onDispatch,
        },
      );
    },
    verify: async () => {
      const observed = await getInboundAzureResourceRules(workspaceId);
      return (
        hashInboundAzureResourceRules(observed.configuration) ===
        surface.desiredHash
      );
    },
  });
}

async function applyOutboundCloudConnectionRulesSurface(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  planned: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
  now: () => number,
): Promise<ApplyNetworkSurfaceResult | undefined> {
  const surface = planned.outboundCloudConnectionRules;
  if (!surface) {
    return undefined;
  }
  const desired = canonical.outboundCloudConnectionRules;
  if (!desired) {
    throw new Error(
      "Approved plan configures outboundCloudConnectionRules, but the manifest no longer declares them.",
    );
  }
  return applySurface({
    label: "outbound cloud connection rules",
    planned: surface,
    checkpointKey: "outboundCloudConnectionRules",
    options,
    now,
    authorize: () => {
      if (!options.allowOutboundCloudConnectionRuleUpdate) {
        throw new Error(
          "The approved plan requires an outbound cloud connection rule update, but allow-outbound-cloud-connection-rule-update is false.",
        );
      }
    },
    dispatch: async (onDispatch) => {
      await options.adapter!.putOutboundCloudConnectionRules(workspaceId, desired, {
        onDispatch,
      });
    },
    verify: async () => {
      const observed =
        await options.adapter!.getOutboundCloudConnectionRules(workspaceId);
      return hashOutboundCloudConnectionRules(observed) === surface.desiredHash;
    },
  });
}

async function applyOutboundGatewayRulesSurface(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  planned: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
  now: () => number,
): Promise<ApplyNetworkSurfaceResult | undefined> {
  const surface = planned.outboundGatewayRules;
  if (!surface) {
    return undefined;
  }
  const desired = canonical.outboundGatewayRules;
  if (!desired) {
    throw new Error(
      "Approved plan configures outboundGatewayRules, but the manifest no longer declares them.",
    );
  }
  return applySurface({
    label: "outbound gateway rules",
    planned: surface,
    checkpointKey: "outboundGatewayRules",
    options,
    now,
    authorize: () => {
      if (!options.allowOutboundGatewayRuleUpdate) {
        throw new Error(
          "The approved plan requires an outbound gateway rule update, but allow-outbound-gateway-rule-update is false.",
        );
      }
    },
    dispatch: async (onDispatch) => {
      await options.adapter!.putOutboundGatewayRules(workspaceId, desired, {
        onDispatch,
      });
    },
    verify: async () => {
      const observed = await options.adapter!.getOutboundGatewayRules(workspaceId);
      return hashOutboundGatewayRules(observed) === surface.desiredHash;
    },
  });
}

/**
 * Shared per-surface dispatch/recovery state machine.
 *
 * Fail-closed recovery: the checkpoint is written with phase `submitting`
 * strictly before the mutating HTTP call is dispatched (via `onDispatch`).
 * On a later run, a `submitting` checkpoint is accepted as a no-op resume
 * only when a fresh read-back proves the desired configuration is already
 * live; any other observed state is treated as ambiguous drift and throws
 * rather than silently retrying the mutation.
 */
async function applySurface(params: {
  label: string;
  planned: Pick<PlannedNetworkSurface, "action" | "desiredHash">;
  checkpointKey: CheckpointSurfaceKey;
  options: ApplyNetworkProtectionOptions;
  now: () => number;
  authorize: () => void;
  dispatch: (onDispatch: () => void) => Promise<void>;
  verify: () => Promise<boolean>;
}): Promise<ApplyNetworkSurfaceResult | undefined> {
  const {
    label,
    planned,
    checkpointKey,
    options,
    now,
    authorize,
    dispatch,
    verify,
  } = params;
  const startedAt = now();
  const existing = options.checkpoint.networkProtection?.[checkpointKey];

  if (!existing) {
    if (planned.action === "no-op") {
      const matches = await verify();
      if (!matches) {
        throw new Error(
          `Fabric network protection state drifted after approval for ${label}. Generate a new plan.`,
        );
      }
      recordSurfaceState(options, checkpointKey, "verified", planned.desiredHash, now);
      return {
        action: planned.action,
        status: "verified",
        durationMs: now() - startedAt,
      };
    }
    authorize();
    try {
      await dispatch(() =>
        recordSurfaceState(
          options,
          checkpointKey,
          "submitting",
          planned.desiredHash,
          now,
        ),
      );
    } catch (error) {
      if (isDefinitiveRequestRejection(error)) {
        let matches: boolean;
        try {
          matches = await verify();
        } catch (verificationError) {
          throw new AggregateError(
            [error, verificationError],
            `Network protection ${label} request was rejected, but read-back verification also failed.`,
          );
        }
        if (matches) {
          recordSurfaceState(
            options,
            checkpointKey,
            "verified",
            planned.desiredHash,
            now,
          );
          return {
            action: planned.action,
            status: "updated",
            durationMs: now() - startedAt,
          };
        }
        clearSurfaceState(options, checkpointKey, now);
      }
      throw error;
    }
    const matches = await verify();
    if (!matches) {
      throw new Error(
        `Network protection ${label} update was accepted but the observed state does not match the desired configuration.`,
      );
    }
    recordSurfaceState(options, checkpointKey, "verified", planned.desiredHash, now);
    return {
      action: planned.action,
      status: "updated",
      durationMs: now() - startedAt,
    };
  }

  function isDefinitiveRequestRejection(error: unknown): boolean {
    return (
      error instanceof FabricApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      !error.priorAttemptAmbiguous
    );
  }

  if (existing.desiredHash !== planned.desiredHash) {
    throw new Error(
      `Network protection ${label} checkpoint does not match the approved plan. Generate a new plan.`,
    );
  }

  if (existing.phase === "verified") {
    const matches = await verify();
    if (!matches) {
      throw new Error(
        `Network protection ${label} no longer matches its desired configuration after a prior successful apply. Generate a new plan.`,
      );
    }
    return {
      action: planned.action,
      status: "resumed",
      durationMs: now() - startedAt,
    };
  }

  // existing.phase === "submitting": a prior attempt dispatched this
  // mutation, but the outcome was never confirmed. Re-affirm authorization
  // (the safeguard may have been revoked since the earlier attempt) before
  // resolving the ambiguity.
  authorize();
  const matches = await verify();
  if (!matches) {
    throw new Error(
      `Network protection ${label} mutation was previously dispatched but the observed state does not match the desired configuration. This is ambiguous and will not be retried automatically; investigate the workspace's current network configuration and generate a fresh plan.`,
    );
  }
  recordSurfaceState(options, checkpointKey, "verified", planned.desiredHash, now);
  return {
    action: planned.action,
    status: "resumed",
    durationMs: now() - startedAt,
  };
}

function assertPlanIsApplicable(planned: PlannedNetworkProtection): void {
  const actions = [
    planned.inboundFirewallRules?.action,
    planned.inboundAzureResourceRules?.action,
    planned.outboundCloudConnectionRules?.action,
    planned.outboundGatewayRules?.action,
  ];
  if (
    planned.communicationPolicy.action === "blocked" &&
    !isManagedPrivateEndpointPolicyBlock(
      planned.communicationPolicy,
    )
  ) {
    actions.push(planned.communicationPolicy.action);
  } else if (planned.communicationPolicy.action === "unknown") {
    actions.push(planned.communicationPolicy.action);
  }
  if (actions.some((action) => action === "blocked" || action === "unknown")) {
    throw new Error(
      "Network protection cannot be applied while a configured surface action is 'blocked' or 'unknown'.",
    );
  }
  if (
    planned.managedPrivateEndpoints?.some(
      (endpoint) =>
        endpoint.action === "blocked" ||
        endpoint.action === "unknown",
    )
  ) {
    throw new Error(
      "Managed private endpoints cannot be applied while an endpoint action is 'blocked' or 'unknown'.",
    );
  }
  requirePlannedWorkspaceId(planned);
  assertCommunicationPolicyMetadata(planned.communicationPolicy);
  if (
    planned.communicationPolicy.desiredInboundDefaultAction === "Deny" &&
    (!planned.inboundFirewallRules ||
      planned.inboundFirewallRules.ruleCount < 1)
  ) {
    throw new Error(
      "Inbound Deny requires an approved non-empty inbound firewall configuration.",
    );
  }
}

function isManagedPrivateEndpointPolicyBlock(
  policy: PlannedNetworkCommunicationPolicy,
): boolean {
  return (
    policy.action === "blocked" &&
    (policy.blockedByManagedPrivateEndpoints?.length ?? 0) > 0 &&
    policy.observedOutboundDefaultAction === "Allow" &&
    policy.desiredOutboundDefaultAction === "Deny"
  );
}

function assertManagedPrivateEndpointPlansNotDriftedForNetwork(
  planned: PlannedManagedPrivateEndpoint[] | undefined,
  fresh: PlannedManagedPrivateEndpoint[] | undefined,
  checkpoint:
    | Record<string, ApplyCheckpointManagedPrivateEndpoint>
    | undefined,
): void {
  if (!planned && !fresh) {
    return;
  }
  if (!planned || !fresh || planned.length !== fresh.length) {
    throw new Error(
      "Managed private endpoint plan shape drifted after approval. Generate a new plan.",
    );
  }
  const freshByName = new Map(
    fresh.map((endpoint) => [
      endpoint.name.toLowerCase(),
      endpoint,
    ]),
  );
  for (const endpoint of planned) {
    const nameKey = endpoint.name.toLowerCase();
    const current = freshByName.get(nameKey);
    if (
      !current ||
      current.operationHash !== endpoint.operationHash ||
      current.desiredIdentityHash !== endpoint.desiredIdentityHash
    ) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' desired configuration drifted after approval. Generate a new plan.`,
      );
    }
    if (
      !getManagedPrivateEndpointCheckpointState(
        checkpoint,
        endpoint.name,
      ) &&
      stableJson(current) !== stableJson(endpoint)
    ) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' observed state drifted after approval. Generate a new plan.`,
      );
    }
  }
}

function assertPreflightSurfaceAuthorized(
  surface: PlannedNetworkSurface,
  checkpointState: ApplyCheckpointNetworkSurface | undefined,
  authorize: () => void,
): void {
  if (surface.action !== "update") {
    return;
  }
  if (checkpointState?.phase === "verified") {
    // Already applied and confirmed; a rerun only re-verifies it.
    return;
  }
  authorize();
}

function assertNoUnexpectedDrift(
  planned: PlannedNetworkProtection,
  fresh: PlannedNetworkProtection,
  checkpoint: ApplyCheckpointNetworkProtection | undefined,
): void {
  assertWorkspaceIdMatches(
    requirePlannedWorkspaceId(planned),
    requirePlannedWorkspaceId(fresh),
    "current plan",
  );
  assertCommunicationPolicyMetadata(fresh.communicationPolicy);
  assertCommunicationPolicyNotDrifted(
    planned.communicationPolicy,
    fresh.communicationPolicy,
    checkpoint?.communicationPolicy,
  );
  if (planned.inboundFirewallRules) {
    assertInboundFirewallRulesNotDrifted(
      planned.inboundFirewallRules,
      fresh.inboundFirewallRules,
      checkpoint?.inboundFirewallRules,
    );
  }
  if (planned.inboundAzureResourceRules) {
    assertInboundAzureResourceRulesNotDrifted(
      planned.inboundAzureResourceRules,
      fresh.inboundAzureResourceRules,
      checkpoint?.inboundAzureResourceRules,
    );
  }
  if (planned.outboundCloudConnectionRules) {
    assertSurfaceNotDrifted(
      "outbound cloud connection rules",
      planned.outboundCloudConnectionRules,
      fresh.outboundCloudConnectionRules,
      checkpoint?.outboundCloudConnectionRules,
      true,
    );
  }
  if (planned.outboundGatewayRules) {
    assertSurfaceNotDrifted(
      "outbound gateway rules",
      planned.outboundGatewayRules,
      fresh.outboundGatewayRules,
      checkpoint?.outboundGatewayRules,
      true,
    );
  }
  assertManagedPrivateEndpointPlansNotDriftedForNetwork(
    planned.managedPrivateEndpoints,
    fresh.managedPrivateEndpoints,
    checkpoint?.managedPrivateEndpoints,
  );
}

function assertInboundFirewallRulesNotDrifted(
  planned: PlannedInboundFirewallRules,
  fresh: PlannedInboundFirewallRules | undefined,
  checkpointState: ApplyCheckpointNetworkSurface | undefined,
): void {
  assertSurfaceNotDrifted(
    "inbound firewall rules",
    planned,
    fresh,
    checkpointState,
    false,
  );
  if (!fresh) {
    return;
  }
  if (
    planned.ruleCount !== fresh.ruleCount ||
    (checkpointState === undefined &&
      planned.etag !== undefined &&
      fresh.etag === undefined)
  ) {
    throw new Error(
      "Fabric inbound firewall rule metadata drifted after approval. Generate a new plan.",
    );
  }
}

function assertInboundAzureResourceRulesNotDrifted(
  planned: PlannedInboundAzureResourceRules,
  fresh: PlannedInboundAzureResourceRules | undefined,
  checkpointState: ApplyCheckpointNetworkSurface | undefined,
): void {
  assertSurfaceNotDrifted(
    "inbound Azure resource rules",
    planned,
    fresh,
    checkpointState,
    false,
  );
  if (!fresh) {
    return;
  }
  if (
    planned.ruleCount !== fresh.ruleCount ||
    (checkpointState === undefined &&
      planned.etag !== undefined &&
      fresh.etag === undefined)
  ) {
    throw new Error(
      "Fabric inbound Azure resource rule metadata drifted after approval. Generate a new plan.",
    );
  }
}

function assertCommunicationPolicyNotDrifted(
  planned: PlannedNetworkCommunicationPolicy,
  fresh: PlannedNetworkCommunicationPolicy,
  checkpointState: ApplyCheckpointNetworkSurface | undefined,
): void {
  if (
    planned.desiredInboundDefaultAction !==
      fresh.desiredInboundDefaultAction ||
    planned.desiredOutboundDefaultAction !==
      fresh.desiredOutboundDefaultAction
  ) {
    throw new Error(
      "Network protection communication policy desired transition changed since the plan was approved. Generate a new plan.",
    );
  }
  if (
    !checkpointState &&
    !isManagedPrivateEndpointPolicyBlock(planned) &&
    (planned.action !== fresh.action ||
      stableJson(planned.blockedByManagedPrivateEndpoints) !==
        stableJson(fresh.blockedByManagedPrivateEndpoints))
  ) {
    throw new Error(
      "Network protection communication policy applicability drifted after approval. Generate a new plan.",
    );
  }
  assertSurfaceNotDrifted(
    "communication policy",
    planned,
    fresh,
    checkpointState,
    false,
  );
  if (checkpointState) {
    return;
  }
  if (
    planned.observedInboundDefaultAction !==
      fresh.observedInboundDefaultAction ||
    planned.observedOutboundDefaultAction !==
      fresh.observedOutboundDefaultAction ||
    isCommunicationPolicyRelaxation(planned) !==
      isCommunicationPolicyRelaxation(fresh)
  ) {
    throw new Error(
      "Fabric network protection communication policy transition metadata drifted after approval. Generate a new plan.",
    );
  }
}

function assertSurfaceNotDrifted(
  label: string,
  planned: PlannedNetworkSurface | undefined,
  fresh: PlannedNetworkSurface | undefined,
  checkpointState: ApplyCheckpointNetworkSurface | undefined,
  allowSentinelTransition: boolean,
): void {
  if (!planned) {
    return;
  }
  if (!fresh) {
    throw new Error(
      `Current network protection plan is missing the ${label} surface.`,
    );
  }
  if (planned.desiredHash !== fresh.desiredHash) {
    throw new Error(
      `Network protection ${label} desired configuration changed since the plan was approved. Generate a new plan.`,
    );
  }
  if (checkpointState) {
    // Already in flight (or done); applySurface's own recovery logic is
    // authoritative for the observed state, but the desired body above must
    // still remain bound to the approval.
    return;
  }
  if (
    allowSentinelTransition &&
    planned.observedStateHash === OAP_NOT_ENABLED_SENTINEL_HASH
  ) {
    // The approved plan could not read this surface because outbound access
    // protection was not yet enabled. Enabling it (in this apply, or an
    // earlier interrupted recovery) legitimately changes the observable
    // state; the desired-hash match above is sufficient here.
    return;
  }
  if (planned.observedStateHash !== fresh.observedStateHash) {
    throw new Error(
      `Fabric network protection state drifted after approval for ${label}. Generate a new plan.`,
    );
  }
}

function networkProtectionRequiresRecovery(
  planned: PlannedNetworkProtection | undefined,
  checkpoint: ApplyCheckpointNetworkProtection | undefined,
): boolean {
  if (!checkpoint) {
    return false;
  }
  const hasStartedSurface =
    checkpoint.communicationPolicy !== undefined ||
    checkpoint.inboundFirewallRules !== undefined ||
    checkpoint.inboundAzureResourceRules !== undefined ||
    checkpoint.outboundCloudConnectionRules !== undefined ||
    checkpoint.outboundGatewayRules !== undefined;
  if (!planned) {
    return hasStartedSurface || checkpoint.completedAt !== undefined;
  }
  const fullyVerified =
    checkpoint.communicationPolicy?.phase === "verified" &&
    (planned.inboundFirewallRules === undefined
      ? checkpoint.inboundFirewallRules === undefined
      : checkpoint.inboundFirewallRules?.phase === "verified") &&
    (planned.inboundAzureResourceRules === undefined
      ? checkpoint.inboundAzureResourceRules === undefined
      : checkpoint.inboundAzureResourceRules?.phase === "verified") &&
    (planned.outboundCloudConnectionRules === undefined
      ? checkpoint.outboundCloudConnectionRules === undefined
      : checkpoint.outboundCloudConnectionRules?.phase === "verified") &&
    (planned.outboundGatewayRules === undefined
      ? checkpoint.outboundGatewayRules === undefined
      : checkpoint.outboundGatewayRules?.phase === "verified");
  return (
    (!checkpoint.completedAt && hasStartedSurface) ||
    (checkpoint.completedAt !== undefined && !fullyVerified)
  );
}

function assertDesiredConfigurationMatchesPlan(
  planned: PlannedNetworkProtection,
  canonical: ReturnType<typeof normalizeNetworkProtection>,
): void {
  const policyHash = hashCommunicationPolicy(canonical.communicationPolicy);
  if (planned.communicationPolicy.desiredHash !== policyHash) {
    throw new Error(
      "The networkProtection communication policy manifest no longer matches the approved plan.",
    );
  }
  assertDesiredInboundFirewallRulesMatchesPlan(
    planned.inboundFirewallRules,
    canonical.inboundFirewallRules,
  );
  assertDesiredInboundAzureResourceRulesMatchesPlan(
    planned.inboundAzureResourceRules,
    canonical.inboundAzureResourceRules,
  );
  assertDesiredSurfaceMatchesPlan(
    "outbound cloud connection rules",
    planned.outboundCloudConnectionRules,
    canonical.outboundCloudConnectionRules
      ? hashOutboundCloudConnectionRules(
          canonical.outboundCloudConnectionRules,
        )
      : undefined,
  );
  assertDesiredSurfaceMatchesPlan(
    "outbound gateway rules",
    planned.outboundGatewayRules,
    canonical.outboundGatewayRules
      ? hashOutboundGatewayRules(canonical.outboundGatewayRules)
      : undefined,
  );
  assertManagedPrivateEndpointDesiredConfigurationMatchesPlan(
    planned.managedPrivateEndpoints,
    canonical.managedPrivateEndpoints,
  );
}

function assertDesiredInboundFirewallRulesMatchesPlan(
  planned: PlannedInboundFirewallRules | undefined,
  desired: ReturnType<
    typeof normalizeNetworkProtection
  >["inboundFirewallRules"],
): void {
  if (!planned && desired === undefined) {
    return;
  }
  if (
    !planned ||
    desired === undefined ||
    planned.desiredHash !== hashInboundFirewallRules(desired) ||
    planned.ruleCount !== desired.rules.length
  ) {
    throw new Error(
      "The networkProtection inbound firewall rules manifest no longer matches the approved plan.",
    );
  }
}

function assertDesiredInboundAzureResourceRulesMatchesPlan(
  planned: PlannedInboundAzureResourceRules | undefined,
  desired: ReturnType<
    typeof normalizeNetworkProtection
  >["inboundAzureResourceRules"],
): void {
  if (!planned && desired === undefined) {
    return;
  }
  if (
    !planned ||
    desired === undefined ||
    planned.desiredHash !== hashInboundAzureResourceRules(desired) ||
    planned.ruleCount !== desired.rules.length
  ) {
    throw new Error(
      "The networkProtection inbound Azure resource rules manifest no longer matches the approved plan.",
    );
  }
}

function assertDesiredSurfaceMatchesPlan(
  label: string,
  planned: PlannedNetworkSurface | undefined,
  desiredHash: string | undefined,
): void {
  if (!planned && desiredHash === undefined) {
    return;
  }
  if (!planned || desiredHash === undefined || planned.desiredHash !== desiredHash) {
    throw new Error(
      `The networkProtection ${label} manifest no longer matches the approved plan.`,
    );
  }
}

function assertCommunicationPolicyMetadata(
  policy: PlannedNetworkCommunicationPolicy,
): void {
  const desiredHash = hashCommunicationPolicy({
    inbound: {
      publicAccessRules: {
        defaultAction: policy.desiredInboundDefaultAction,
      },
    },
    outbound: {
      publicAccessRules: {
        defaultAction: policy.desiredOutboundDefaultAction,
      },
    },
  });
  if (policy.desiredHash !== desiredHash) {
    throw new Error(
      "Network protection communication policy desired metadata is inconsistent with its approved hash.",
    );
  }
  if (
    policy.observedInboundDefaultAction === undefined ||
    policy.observedOutboundDefaultAction === undefined ||
    policy.observedStateHash === undefined ||
    policy.isRelaxation === undefined
  ) {
    throw new Error(
      "Applicable network protection communication policy plans must include complete observed transition metadata.",
    );
  }
  const observedHash = hashCommunicationPolicy({
    inbound: {
      publicAccessRules: {
        defaultAction: policy.observedInboundDefaultAction,
      },
    },
    outbound: {
      publicAccessRules: {
        defaultAction: policy.observedOutboundDefaultAction,
      },
    },
  });
  const relaxation =
    (policy.observedInboundDefaultAction === "Deny" &&
      policy.desiredInboundDefaultAction === "Allow") ||
    (policy.observedOutboundDefaultAction === "Deny" &&
      policy.desiredOutboundDefaultAction === "Allow");
  if (
    policy.observedStateHash !== observedHash ||
    policy.isRelaxation !== relaxation ||
    (policy.action === "no-op") !== (desiredHash === observedHash)
  ) {
    throw new Error(
      "Network protection communication policy transition metadata is inconsistent.",
    );
  }
}

function isCommunicationPolicyRelaxation(
  policy: PlannedNetworkCommunicationPolicy,
): boolean {
  if (
    policy.observedInboundDefaultAction === undefined ||
    policy.observedOutboundDefaultAction === undefined
  ) {
    throw new Error(
      "Network protection communication policy is missing observed transition metadata.",
    );
  }
  return (
    (policy.observedInboundDefaultAction === "Deny" &&
      policy.desiredInboundDefaultAction === "Allow") ||
    (policy.observedOutboundDefaultAction === "Deny" &&
      policy.desiredOutboundDefaultAction === "Allow")
  );
}

function assertInboundFirewallLockoutAuthorization(options: {
  planned: PlannedNetworkProtection;
  checkpoint: ApplyCheckpointNetworkProtection | undefined;
  allowNetworkPolicyUpdate: boolean;
  allowInboundFirewallUpdate: boolean;
  acknowledgeFirewallLockoutRisk: boolean;
}): void {
  const policy = options.planned.communicationPolicy;
  const enablesInboundDeny =
    policy.observedInboundDefaultAction === "Allow" &&
    policy.desiredInboundDefaultAction === "Deny";
  if (!enablesInboundDeny || options.checkpoint?.completedAt) {
    return;
  }
  if (!options.allowNetworkPolicyUpdate) {
    throw new Error(
      "Enabling inbound Deny requires allow-network-policy-update in addition to the inbound firewall safeguards.",
    );
  }
  if (!options.allowInboundFirewallUpdate) {
    throw new Error(
      "Enabling inbound Deny requires allow-inbound-firewall-update even when the approved firewall body is already present.",
    );
  }
  if (!options.acknowledgeFirewallLockoutRisk) {
    throw new Error(
      "Enabling inbound Deny requires the independent acknowledge-firewall-lockout-risk safeguard.",
    );
  }
}

function requirePlannedWorkspaceId(planned: PlannedNetworkProtection): string {
  if (!planned.workspaceId) {
    throw new Error(
      "Network protection plan is missing its resolved workspace ID.",
    );
  }
  return planned.workspaceId;
}

function assertWorkspaceIdMatches(
  approvedWorkspaceId: string,
  actualWorkspaceId: string,
  source: string,
): void {
  if (approvedWorkspaceId.toLowerCase() !== actualWorkspaceId.toLowerCase()) {
    throw new Error(
      `Network protection ${source} workspace ID '${actualWorkspaceId}' does not match the approved target '${approvedWorkspaceId}'.`,
    );
  }
}

function ensureCheckpointInitialized(
  options: ApplyNetworkProtectionOptions,
  workspaceId: string,
  now: () => number,
): void {
  if (!options.checkpoint.networkProtection) {
    options.checkpoint.networkProtection = {
      workspaceId,
      updatedAt: new Date(now()).toISOString(),
    };
    writeCheckpoint(options.checkpointFile, options.checkpoint);
    return;
  }
  if (options.checkpoint.networkProtection.workspaceId !== workspaceId) {
    throw new Error(
      "Network protection checkpoint workspace ID does not match the approved plan.",
    );
  }
}

function recordSurfaceState(
  options: ApplyNetworkProtectionOptions,
  key: CheckpointSurfaceKey,
  phase: "submitting" | "verified",
  desiredHash: string,
  now: () => number,
): void {
  const checkpoint = options.checkpoint.networkProtection;
  if (!checkpoint) {
    throw new Error("Network protection checkpoint is not initialized.");
  }
  const timestamp = new Date(now()).toISOString();
  checkpoint[key] = { desiredHash, phase, updatedAt: timestamp };
  checkpoint.updatedAt = timestamp;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearSurfaceState(
  options: ApplyNetworkProtectionOptions,
  key: CheckpointSurfaceKey,
  now: () => number,
): void {
  const checkpoint = options.checkpoint.networkProtection;
  if (!checkpoint) {
    throw new Error("Network protection checkpoint is not initialized.");
  }
  delete checkpoint[key];
  delete checkpoint.completedAt;
  checkpoint.updatedAt = new Date(now()).toISOString();
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function markNetworkProtectionCompleted(
  options: ApplyNetworkProtectionOptions,
  now: () => number,
): void {
  const checkpoint = options.checkpoint.networkProtection;
  if (!checkpoint) {
    throw new Error("Network protection checkpoint is not initialized.");
  }
  const timestamp = new Date(now()).toISOString();
  const managedPrivateEndpoints =
    options.approvedPlan.networkProtection?.managedPrivateEndpoints ?? [];
  const managedStates = checkpoint.managedPrivateEndpoints ?? {};
  const managedPrivateEndpointsComplete =
    managedPrivateEndpoints.every((endpoint) => {
      const phase =
        getManagedPrivateEndpointCheckpointState(
          managedStates,
          endpoint.name,
        )?.phase;
      return (
        (endpoint.desiredState === "present" &&
          phase === "present-verified") ||
        (endpoint.desiredState === "absent" &&
          phase === "absent-verified")
      );
    });
  const planned = options.approvedPlan.networkProtection;
  const configuredSurfacesComplete =
    planned !== undefined &&
    checkpoint.communicationPolicy?.phase === "verified" &&
    (planned.inboundFirewallRules === undefined
      ? checkpoint.inboundFirewallRules === undefined
      : checkpoint.inboundFirewallRules?.phase === "verified") &&
    (planned.inboundAzureResourceRules === undefined
      ? checkpoint.inboundAzureResourceRules === undefined
      : checkpoint.inboundAzureResourceRules?.phase === "verified") &&
    (planned.outboundCloudConnectionRules === undefined
      ? checkpoint.outboundCloudConnectionRules === undefined
      : checkpoint.outboundCloudConnectionRules?.phase === "verified") &&
    (planned.outboundGatewayRules === undefined
      ? checkpoint.outboundGatewayRules === undefined
      : checkpoint.outboundGatewayRules?.phase === "verified");
  if (managedPrivateEndpointsComplete && configuredSurfacesComplete) {
    checkpoint.completedAt = timestamp;
  } else {
    delete checkpoint.completedAt;
  }
  checkpoint.updatedAt = timestamp;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function getManagedPrivateEndpointCheckpointState(
  states:
    | Record<string, ApplyCheckpointManagedPrivateEndpoint>
    | undefined,
  name: string,
): ApplyCheckpointManagedPrivateEndpoint | undefined {
  const key = managedPrivateEndpointCheckpointKey(name);
  return states &&
    Object.prototype.hasOwnProperty.call(states, key)
    ? states[key]
    : undefined;
}
