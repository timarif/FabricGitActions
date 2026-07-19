import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCheckpoint, loadCheckpoint, writeCheckpoint } from "../src/checkpoint";
import { FabricApiError } from "../src/fabric/client";
import {
  hashCommunicationPolicy,
  hashInboundAzureResourceRules,
  hashInboundExternalDataSharesPolicy,
  hashInboundFirewallRules,
  hashOutboundCloudConnectionRules,
  hashOutboundGatewayRules,
  normalizeNetworkProtection,
  OAP_NOT_ENABLED_SENTINEL_HASH,
} from "../src/fabric/network-protection";
import {
  applyNetworkProtection,
  preflightNetworkProtection,
  recoverInterruptedNetworkProtection,
  type ApplyNetworkProtectionOptions,
} from "../src/network-apply";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  ApplyCheckpoint,
  DeploymentPlan,
  LoadedManifest,
  NetworkProtectionManifest,
  PlannedNetworkProtection,
} from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

const TIGHTENING_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Deny",
  },
  outboundCloudConnectionRules: {
    defaultAction: "Deny",
    rules: [{ connectionType: "Web", defaultAction: "Allow" }],
  },
  outboundGatewayRules: {
    defaultAction: "Deny",
    allowedGateways: [{ id: GATEWAY_ID }],
  },
};

const ALLOW_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
};

const INBOUND_TIGHTENING_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Deny",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [
      {
        displayName: "corporate",
        value: "12.34.56.78",
      },
    ],
  },
};

const AZURE_RESOURCE_ID =
  "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/sqlserver";

const INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Deny",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [
      {
        displayName: "corporate",
        value: "12.34.56.78",
      },
    ],
  },
  inboundAzureResourceRules: {
    rules: [{ displayName: "sql-server", resourceId: AZURE_RESOURCE_ID }],
  },
};

const INBOUND_RELAXING_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [],
  },
};

const INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [],
  },
  inboundAzureResourceRules: { rules: [] },
};

const INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Deny",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [
      {
        displayName: "corporate",
        value: "12.34.56.78",
      },
    ],
  },
  inboundExternalDataSharesPolicy: { defaultAction: "Allow" },
};

const INBOUND_RELAXING_WITH_EXTERNAL_DATA_SHARES_DISABLE_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
  inboundFirewallRules: {
    rules: [],
  },
  inboundExternalDataSharesPolicy: { defaultAction: "Deny" },
};

const NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
  inboundExternalDataSharesPolicy: { defaultAction: "Allow" },
};

function canonicalOf(desired: NetworkProtectionManifest) {
  return normalizeNetworkProtection(desired);
}

/** Builds an approved DeploymentPlan carrying a fully authenticated networkProtection block. */
function buildApprovedPlan(options: {
  desired: NetworkProtectionManifest;
  observedInbound: "Allow" | "Deny";
  observedOutbound: "Allow" | "Deny";
  policyAction: "update" | "no-op";
  firewallAction?: "update" | "no-op";
  firewallObservedHash?: string;
  firewallEtag?: string;
  azureResourceAction?: "update" | "no-op";
  azureResourceObservedHash?: string;
  azureResourceEtag?: string;
  externalDataSharesAction?: "update" | "no-op";
  externalDataSharesObservedDefaultAction?: "Allow" | "Deny";
  externalDataSharesEtag?: string;
  ruleAction?: "update" | "no-op";
  ruleObservedIsSentinel?: boolean;
}): DeploymentPlan {
  const canonical = canonicalOf(options.desired);
  const desiredPolicyHash = hashCommunicationPolicy(canonical.communicationPolicy);
  const observedPolicyHash = hashCommunicationPolicy({
    inbound: { publicAccessRules: { defaultAction: options.observedInbound } },
    outbound: { publicAccessRules: { defaultAction: options.observedOutbound } },
  });

  const networkProtection: PlannedNetworkProtection = {
    workspaceId: WORKSPACE_ID,
    communicationPolicy: {
      action: options.policyAction,
      reason: options.policyAction === "no-op" ? "matches" : "differs",
      desiredHash: desiredPolicyHash,
      observedStateHash: options.policyAction === "no-op" ? desiredPolicyHash : observedPolicyHash,
      desiredInboundDefaultAction:
        canonical.communicationPolicy.inbound.publicAccessRules.defaultAction,
      desiredOutboundDefaultAction:
        canonical.communicationPolicy.outbound.publicAccessRules.defaultAction,
      observedInboundDefaultAction: options.observedInbound,
      observedOutboundDefaultAction: options.observedOutbound,
      isRelaxation:
        (options.observedInbound === "Deny" &&
          canonical.communicationPolicy.inbound.publicAccessRules.defaultAction === "Allow") ||
        (options.observedOutbound === "Deny" &&
          canonical.communicationPolicy.outbound.publicAccessRules.defaultAction === "Allow"),
    },
  };

  if (canonical.inboundFirewallRules) {
    const desiredHash = hashInboundFirewallRules(
      canonical.inboundFirewallRules,
    );
    networkProtection.inboundFirewallRules = {
      action: options.firewallAction ?? "update",
      reason: "firewall",
      desiredHash,
      observedStateHash:
        options.firewallAction === "no-op"
          ? desiredHash
          : (options.firewallObservedHash ??
            hashInboundFirewallRules({ rules: [] })),
      etag: options.firewallEtag ?? "firewall-etag",
      ruleCount: canonical.inboundFirewallRules.rules.length,
    };
  }
  if (canonical.inboundAzureResourceRules) {
    const desiredHash = hashInboundAzureResourceRules(
      canonical.inboundAzureResourceRules,
    );
    networkProtection.inboundAzureResourceRules = {
      action: options.azureResourceAction ?? "update",
      reason: "azure-resource",
      desiredHash,
      observedStateHash:
        options.azureResourceAction === "no-op"
          ? desiredHash
          : (options.azureResourceObservedHash ??
            hashInboundAzureResourceRules({ rules: [] })),
      etag: options.azureResourceEtag ?? "azure-resource-etag",
      ruleCount: canonical.inboundAzureResourceRules.rules.length,
    };
  }
  if (canonical.inboundExternalDataSharesPolicy) {
    const desiredDefaultAction =
      canonical.inboundExternalDataSharesPolicy.defaultAction;
    const desiredHash = hashInboundExternalDataSharesPolicy(
      canonical.inboundExternalDataSharesPolicy,
    );
    const observedDefaultAction =
      options.externalDataSharesAction === "no-op"
        ? desiredDefaultAction
        : (options.externalDataSharesObservedDefaultAction ??
          (desiredDefaultAction === "Allow" ? "Deny" : "Allow"));
    networkProtection.inboundExternalDataSharesPolicy = {
      action: options.externalDataSharesAction ?? "update",
      reason: "external-data-shares",
      desiredHash,
      observedStateHash: hashInboundExternalDataSharesPolicy({
        defaultAction: observedDefaultAction,
      }),
      etag: options.externalDataSharesEtag ?? "external-data-shares-etag",
      desiredDefaultAction,
      observedDefaultAction,
      isRelaxation:
        observedDefaultAction === "Deny" && desiredDefaultAction === "Allow",
    };
  }
  if (canonical.outboundCloudConnectionRules) {
    const desiredHash = hashOutboundCloudConnectionRules(canonical.outboundCloudConnectionRules);
    networkProtection.outboundCloudConnectionRules = {
      action: options.ruleAction ?? "update",
      reason: "rules",
      desiredHash,
      observedStateHash: options.ruleObservedIsSentinel
        ? OAP_NOT_ENABLED_SENTINEL_HASH
        : desiredHash,
    };
  }
  if (canonical.outboundGatewayRules) {
    const desiredHash = hashOutboundGatewayRules(canonical.outboundGatewayRules);
    networkProtection.outboundGatewayRules = {
      action: options.ruleAction ?? "update",
      reason: "rules",
      desiredHash,
      observedStateHash: options.ruleObservedIsSentinel
        ? OAP_NOT_ENABLED_SENTINEL_HASH
        : desiredHash,
    };
  }

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
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "network-protection-apply" },
      workspace: { id: WORKSPACE_ID },
      networkProtection: options.desired,
      items: [],
    },
  };
  const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
  plan.networkProtection = networkProtection;
  return rehashPlan(plan);
}

function checkpointFilePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-network-apply-"));
  return path.join(root, "checkpoint.json");
}

function mockAdapter() {
  return {
    plan: vi.fn(),
    getCommunicationPolicy: vi.fn(),
    putCommunicationPolicy: vi.fn(),
    getInboundFirewallRules: vi.fn(),
    putInboundFirewallRules: vi.fn(),
    getInboundAzureResourceRules: vi.fn(),
    putInboundAzureResourceRules: vi.fn(),
    getInboundExternalDataSharesPolicy: vi.fn(),
    putInboundExternalDataSharesPolicy: vi.fn(),
    getOutboundCloudConnectionRules: vi.fn(),
    putOutboundCloudConnectionRules: vi.fn(),
    getOutboundGatewayRules: vi.fn(),
    putOutboundGatewayRules: vi.fn(),
  };
}

function baseOptions(
  plan: DeploymentPlan,
  adapter: ReturnType<typeof mockAdapter>,
  checkpointFile: string,
  overrides: Partial<ApplyNetworkProtectionOptions> = {},
): ApplyNetworkProtectionOptions {
  const checkpoint = overrides.checkpoint ?? createCheckpoint(plan);
  return {
    approvedPlan: plan,
    currentPlan: plan,
    desired: plan.networkProtection ? TIGHTENING_DESIRED : undefined,
    adapter,
    checkpoint,
    checkpointFile,
    allowNetworkPolicyUpdate: false,
    allowNetworkPolicyRelaxation: false,
    allowInboundFirewallUpdate: false,
    allowInboundAzureResourceRuleUpdate: false,
    allowInboundExternalDataSharePolicyUpdate: false,
    allowInboundExternalDataSharePolicyRelaxation: false,
    acknowledgeFirewallLockoutRisk: false,
    allowOutboundCloudConnectionRuleUpdate: false,
    allowOutboundGatewayRuleUpdate: false,
    ...overrides,
  };
}

function mockSuccessfulNetworkSurfaces(
  adapter: ReturnType<typeof mockAdapter>,
  desired: NetworkProtectionManifest,
  calls: string[],
): void {
  const canonical = canonicalOf(desired);
  adapter.putCommunicationPolicy.mockImplementation(async () => {
    calls.push("put-policy");
    return {
      policy: canonical.communicationPolicy,
      etag: "policy-updated",
    };
  });
  adapter.getCommunicationPolicy.mockResolvedValue({
    policy: canonical.communicationPolicy,
    etag: "policy-updated",
  });
  if (canonical.inboundFirewallRules) {
    adapter.putInboundFirewallRules.mockImplementation(async () => {
      calls.push("put-firewall");
      return {
        configuration: canonical.inboundFirewallRules!,
        etag: "firewall-updated",
      };
    });
    adapter.getInboundFirewallRules.mockResolvedValue({
      configuration: canonical.inboundFirewallRules,
      etag: "firewall-updated",
    });
  }
  if (canonical.inboundAzureResourceRules) {
    adapter.putInboundAzureResourceRules.mockImplementation(async () => {
      calls.push("put-azure-resource");
      return {
        configuration: canonical.inboundAzureResourceRules!,
        etag: "azure-resource-updated",
      };
    });
    adapter.getInboundAzureResourceRules.mockResolvedValue({
      configuration: canonical.inboundAzureResourceRules,
      etag: "azure-resource-updated",
    });
  }
  if (canonical.inboundExternalDataSharesPolicy) {
    adapter.putInboundExternalDataSharesPolicy.mockImplementation(
      async () => {
        calls.push("put-external-data-shares");
        return {
          configuration: canonical.inboundExternalDataSharesPolicy!,
          etag: "external-data-shares-updated",
        };
      },
    );
    adapter.getInboundExternalDataSharesPolicy.mockResolvedValue({
      configuration: canonical.inboundExternalDataSharesPolicy,
      etag: "external-data-shares-updated",
    });
  }
  if (canonical.outboundCloudConnectionRules) {
    adapter.putOutboundCloudConnectionRules.mockImplementation(
      async () => {
        calls.push("put-connections");
        return canonical.outboundCloudConnectionRules!;
      },
    );
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonical.outboundCloudConnectionRules,
    );
  }
  if (canonical.outboundGatewayRules) {
    adapter.putOutboundGatewayRules.mockImplementation(async () => {
      calls.push("put-gateways");
      return canonical.outboundGatewayRules!;
    });
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonical.outboundGatewayRules,
    );
  }
}

describe("preflightNetworkProtection", () => {
  it("rejects an approved plan that omits the current networkProtection block", () => {
    const current = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    const approved = structuredClone(current);
    delete approved.networkProtection;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowInboundExternalDataSharePolicyUpdate: false,
        allowInboundExternalDataSharePolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("omits networkProtection");
  });

  it("throws when a configured surface action is blocked", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    plan.networkProtection!.communicationPolicy.action = "blocked";

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("blocked");
  });

  it("requires allow-network-policy-update for a policy update", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-network-policy-update is false");
  });

  it("additionally requires allow-network-policy-relaxation for a relaxation", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-network-policy-relaxation is false");
  });

  it("requires the two outbound rule safeguards independently", () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-outbound-cloud-connection-rule-update is false");

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-outbound-gateway-rule-update is false");
  });

  it("requires the inbound firewall safeguard independently", () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowInboundFirewallUpdate: false,
        acknowledgeFirewallLockoutRisk: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-inbound-firewall-update is false");
  });

  it("requires the inbound Azure resource rule safeguard independently, without any other flag implying it", () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "no-op",
      azureResourceAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowInboundAzureResourceRuleUpdate: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-inbound-azure-resource-rule-update is false");
  });

  it("requires all three independent safeguards before any inbound Allow -> Deny unit mutation", () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "no-op",
    });
    const base = {
      approvedPlan: plan,
      currentPlan: plan,
      checkpoint: createCheckpoint(plan),
      allowNetworkPolicyRelaxation: false,
      allowOutboundCloudConnectionRuleUpdate: false,
      allowOutboundGatewayRuleUpdate: false,
    };

    expect(() =>
      preflightNetworkProtection({
        ...base,
        allowNetworkPolicyUpdate: false,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
      }),
    ).toThrow("requires allow-network-policy-update");
    expect(() =>
      preflightNetworkProtection({
        ...base,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: false,
        acknowledgeFirewallLockoutRisk: true,
      }),
    ).toThrow("requires allow-inbound-firewall-update");
    expect(() =>
      preflightNetworkProtection({
        ...base,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: false,
      }),
    ).toThrow("acknowledge-firewall-lockout-risk");
    expect(() =>
      preflightNetworkProtection({
        ...base,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
      }),
    ).not.toThrow();
  });

  it("does not let allow-inbound-azure-resource-rule-update satisfy the inbound-Deny lockout safeguards", () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      azureResourceAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowInboundFirewallUpdate: false,
        allowInboundAzureResourceRuleUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("requires allow-network-policy-update");
  });

  it("requires the base inbound External Data Shares policy safeguard independently, without any other flag implying it", () => {
    const plan = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowInboundAzureResourceRuleUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: false,
        allowInboundExternalDataSharePolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-inbound-external-data-share-policy-update is false");
  });

  it("requires the independent relaxation safeguard in addition to the base safeguard when enabling the bypass", () => {
    const plan = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowInboundAzureResourceRuleUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-inbound-external-data-share-policy-relaxation is false");

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowInboundAzureResourceRuleUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).not.toThrow();
  });

  it("does not require the relaxation safeguard when tightening (disabling) the External Data Shares bypass", () => {
    const plan = buildApprovedPlan({
      desired: {
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Allow",
        },
        inboundExternalDataSharesPolicy: { defaultAction: "Deny" },
      },
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Allow",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowInboundAzureResourceRuleUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).not.toThrow();
  });

  it("skips re-authorization once a surface is checkpointed verified", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint,
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).not.toThrow();
  });

  it("throws when the current plan has drifted from the approved plan", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const current = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("drifted after approval");
  });

  it("rejects an approved plan that omits a configured External Data Shares policy surface", () => {
    const current = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    const approved = structuredClone(current);
    delete approved.networkProtection!.inboundExternalDataSharesPolicy;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowInboundExternalDataSharePolicyUpdate: false,
        allowInboundExternalDataSharePolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("omits inbound External Data Shares policy");
  });

  it("rejects a current plan targeting a different network workspace", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const current = structuredClone(approved);
    current.networkProtection!.workspaceId = OTHER_WORKSPACE_ID;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("does not match the approved target");
  });

  it("rejects inconsistent approved relaxation metadata", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    approved.networkProtection!.communicationPolicy.isRelaxation = false;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: approved,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("transition metadata is inconsistent");
  });

  it("rejects a tampered External Data Shares plan that reclassifies an enabling transition as non-relaxing", () => {
    const approved = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    // Tamper: the transition is really Deny -> Allow (a relaxation), but the
    // plan artifact falsely claims it is not, which would otherwise let the
    // update bypass the independent relaxation safeguard.
    approved.networkProtection!.inboundExternalDataSharesPolicy!.isRelaxation =
      false;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: approved,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("transition metadata is inconsistent");
  });

  it("fails closed when a fresh External Data Shares plan drifts from the approved transition metadata", () => {
    const approved = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    const fresh = buildApprovedPlan({
      desired: NO_INBOUND_CHANGE_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      // Live state now shows the bypass already enabled (matching the
      // desired Allow), so this surface is genuinely a no-op on the fresh
      // plan even though the approved plan captured it as an update.
      externalDataSharesAction: "no-op",
      externalDataSharesObservedDefaultAction: "Allow",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: fresh,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("Generate a new plan");
  });
});

describe("applyNetworkProtection ordering", () => {
  it("stages and verifies inbound firewall rules before inbound Allow -> Deny", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_TIGHTENING_DESIRED,
      calls,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_TIGHTENING_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
      }),
    );

    expect(calls).toEqual(["put-firewall", "put-policy"]);
    expect(
      adapter.putInboundFirewallRules.mock.calls[0]?.[2],
    ).toMatchObject({ ifMatchEtag: "firewall-etag" });
  });

  it("stages and verifies firewall then Azure resource rules, exactly once each, before inbound Allow -> Deny", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      azureResourceAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
      calls,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        allowInboundAzureResourceRuleUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
      }),
    );

    expect(calls).toEqual(["put-firewall", "put-azure-resource", "put-policy"]);
    expect(adapter.putInboundFirewallRules).toHaveBeenCalledTimes(1);
    expect(adapter.putInboundAzureResourceRules).toHaveBeenCalledTimes(1);
    expect(adapter.putCommunicationPolicy).toHaveBeenCalledTimes(1);
    expect(
      adapter.putInboundAzureResourceRules.mock.calls[0]?.[2],
    ).toMatchObject({ ifMatchEtag: "azure-resource-etag" });
    expect(result?.inboundAzureResourceRules?.status).toBe("updated");
  });

  it("requires the Azure resource rule safeguard independently even when the firewall safeguard is granted", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      azureResourceAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
      calls,
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_TIGHTENING_WITH_AZURE_RESOURCE_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowInboundFirewallUpdate: true,
          allowInboundAzureResourceRuleUpdate: false,
          acknowledgeFirewallLockoutRisk: true,
        }),
      ),
    ).rejects.toThrow("allow-inbound-azure-resource-rule-update is false");
  });

  it("stages enabling the External Data Shares bypass before inbound Allow -> Deny, alongside firewall rules, exactly once each", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      calls,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: true,
        acknowledgeFirewallLockoutRisk: true,
      }),
    );

    expect(calls).toEqual([
      "put-firewall",
      "put-external-data-shares",
      "put-policy",
    ]);
    expect(adapter.putInboundExternalDataSharesPolicy).toHaveBeenCalledTimes(
      1,
    );
    expect(adapter.putCommunicationPolicy).toHaveBeenCalledTimes(1);
    expect(result?.inboundExternalDataSharesPolicy?.status).toBe("updated");
  });

  it("requires the External Data Shares relaxation safeguard independently even when the base update and firewall safeguards are granted", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Deny",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
      calls,
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_TIGHTENING_WITH_EXTERNAL_DATA_SHARES_ENABLE_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowInboundFirewallUpdate: true,
          allowInboundExternalDataSharePolicyUpdate: true,
          allowInboundExternalDataSharePolicyRelaxation: false,
          acknowledgeFirewallLockoutRisk: true,
        }),
      ),
    ).rejects.toThrow(
      "allow-inbound-external-data-share-policy-relaxation is false",
    );
    expect(adapter.putInboundExternalDataSharesPolicy).not.toHaveBeenCalled();
  });

  it("uses the freshly observed inbound firewall ETag rather than the approval-time value", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "update",
      firewallEtag: "approval-etag",
    });
    const fresh = structuredClone(plan.networkProtection!);
    fresh.inboundFirewallRules!.etag = "fresh-etag";
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(fresh);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_RELAXING_DESIRED,
      calls,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_RELAXING_DESIRED,
        allowInboundFirewallUpdate: true,
      }),
    );

    expect(adapter.putInboundFirewallRules).toHaveBeenCalledWith(
      WORKSPACE_ID,
      canonicalOf(INBOUND_RELAXING_DESIRED).inboundFirewallRules,
      expect.objectContaining({ ifMatchEtag: "fresh-etag" }),
    );
  });

  it("applies a headerless approved firewall plan without If-Match", async () => {
    let plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "update",
    });
    delete plan.networkProtection!.inboundFirewallRules!.etag;
    plan = rehashPlan(plan);
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_RELAXING_DESIRED,
      calls,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_RELAXING_DESIRED,
        allowInboundFirewallUpdate: true,
      }),
    );

    expect(
      adapter.putInboundFirewallRules.mock.calls[0]?.[2],
    ).not.toHaveProperty("ifMatchEtag");
    expect(result?.inboundFirewallRules?.status).toBe("updated");
  });

  it("fails closed if ETag support disappears after approval", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "update",
    });
    const fresh = structuredClone(plan.networkProtection!);
    delete fresh.inboundFirewallRules!.etag;
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(fresh);

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_RELAXING_DESIRED,
          allowInboundFirewallUpdate: true,
        }),
      ),
    ).rejects.toThrow("metadata drifted after approval");
    expect(adapter.putInboundFirewallRules).not.toHaveBeenCalled();
  });

  it("fails closed on inbound Azure resource rule count drift after approval", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "no-op",
      azureResourceAction: "no-op",
    });
    const fresh = structuredClone(plan.networkProtection!);
    fresh.inboundAzureResourceRules!.ruleCount = 5;
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(fresh);

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
          allowInboundAzureResourceRuleUpdate: true,
        }),
      ),
    ).rejects.toThrow("metadata drifted after approval");
    expect(adapter.putInboundAzureResourceRules).not.toHaveBeenCalled();
  });

  it("fails closed if the approval-time Azure resource rule ETag disappears from fresh discovery", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "no-op",
      azureResourceAction: "update",
    });
    const fresh = structuredClone(plan.networkProtection!);
    delete fresh.inboundAzureResourceRules!.etag;
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(fresh);

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
          allowInboundAzureResourceRuleUpdate: true,
        }),
      ),
    ).rejects.toThrow("metadata drifted after approval");
    expect(adapter.putInboundAzureResourceRules).not.toHaveBeenCalled();
  });

  it("checkpoints the inbound firewall replacement before dispatch", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
      firewallAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(INBOUND_RELAXING_DESIRED)
        .communicationPolicy,
      etag: "policy-etag",
    });
    adapter.getInboundFirewallRules.mockResolvedValue({
      configuration:
        canonicalOf(INBOUND_RELAXING_DESIRED)
          .inboundFirewallRules!,
      etag: "updated-etag",
    });
    let duringDispatch: ApplyCheckpoint | undefined;
    adapter.putInboundFirewallRules.mockImplementation(
      async (
        _workspaceId: string,
        _desired: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        duringDispatch = loadCheckpoint(checkpointFile, plan);
        return {
          configuration:
            canonicalOf(INBOUND_RELAXING_DESIRED)
              .inboundFirewallRules!,
          etag: "updated-etag",
        };
      },
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        desired: INBOUND_RELAXING_DESIRED,
        allowInboundFirewallUpdate: true,
      }),
    );

    expect(
      duringDispatch?.networkProtection?.inboundFirewallRules
        ?.phase,
    ).toBe("submitting");
  });

  it("moves inbound Deny -> Allow before clearing or relaxing firewall rules", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_DESIRED,
      observedInbound: "Deny",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_RELAXING_DESIRED,
      calls,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_RELAXING_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
      }),
    );

    expect(calls).toEqual(["put-policy", "put-firewall"]);
  });

  it("moves inbound Deny -> Allow before clearing or relaxing firewall and Azure resource rules, exactly once each", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
      observedInbound: "Deny",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      azureResourceAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
      calls,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_RELAXING_WITH_AZURE_RESOURCE_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        allowInboundAzureResourceRuleUpdate: true,
      }),
    );

    expect(calls).toEqual(["put-policy", "put-firewall", "put-azure-resource"]);
    expect(adapter.putInboundFirewallRules).toHaveBeenCalledTimes(1);
    expect(adapter.putInboundAzureResourceRules).toHaveBeenCalledTimes(1);
  });

  it("disables the External Data Shares bypass only after inbound Deny -> Allow, exactly once", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_RELAXING_WITH_EXTERNAL_DATA_SHARES_DISABLE_DESIRED,
      observedInbound: "Deny",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      externalDataSharesAction: "update",
      externalDataSharesObservedDefaultAction: "Allow",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(
      adapter,
      INBOUND_RELAXING_WITH_EXTERNAL_DATA_SHARES_DISABLE_DESIRED,
      calls,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: INBOUND_RELAXING_WITH_EXTERNAL_DATA_SHARES_DISABLE_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        // Tightening (disabling) the bypass must not require the relaxation
        // safeguard, even though the master policy transition is itself a
        // relaxation.
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: false,
      }),
    );

    expect(calls).toEqual([
      "put-policy",
      "put-firewall",
      "put-external-data-shares",
    ]);
    expect(adapter.putInboundExternalDataSharesPolicy).toHaveBeenCalledTimes(
      1,
    );
    expect(result?.inboundExternalDataSharesPolicy?.status).toBe("updated");
  });

  it("orders combined inbound and outbound tightening firewall -> policy -> OAP rules", async () => {
    const desired: NetworkProtectionManifest = {
      ...TIGHTENING_DESIRED,
      communicationPolicy: {
        inboundDefaultAction: "Deny",
        outboundDefaultAction: "Deny",
      },
      inboundFirewallRules:
        INBOUND_TIGHTENING_DESIRED.inboundFirewallRules,
    };
    const plan = buildApprovedPlan({
      desired,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(adapter, desired, calls);

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: true,
        acknowledgeFirewallLockoutRisk: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls[0]).toBe("put-firewall");
    expect(calls[1]).toBe("put-policy");
    expect(calls.slice(2)).toEqual([
      "put-connections",
      "put-gateways",
    ]);
  });

  it("orders a mixed inbound relaxation and outbound tightening policy -> firewall -> OAP rules", async () => {
    const desired: NetworkProtectionManifest = {
      ...TIGHTENING_DESIRED,
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      inboundFirewallRules: { rules: [] },
    };
    const plan = buildApprovedPlan({
      desired,
      observedInbound: "Deny",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(adapter, desired, calls);

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowInboundFirewallUpdate: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls).toEqual([
      "put-policy",
      "put-firewall",
      "put-connections",
      "put-gateways",
    ]);
  });

  it("applies each outbound rule surface once when OAP is already enabled", async () => {
    let plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "no-op",
      ruleAction: "update",
    });
    plan.networkProtection!.outboundCloudConnectionRules!.observedStateHash =
      "a".repeat(64);
    plan.networkProtection!.outboundGatewayRules!.observedStateHash =
      "b".repeat(64);
    plan = rehashPlan(plan);

    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    mockSuccessfulNetworkSurfaces(adapter, TIGHTENING_DESIRED, calls);

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls).toEqual(["put-connections", "put-gateways"]);
    expect(adapter.getOutboundCloudConnectionRules).toHaveBeenCalledOnce();
    expect(adapter.getOutboundGatewayRules).toHaveBeenCalledOnce();
    expect(result?.outboundCloudConnectionRules?.status).toBe("updated");
    expect(result?.outboundGatewayRules?.status).toBe("updated");
  });

  it("tightens Allow -> Deny by PUTting the policy before any outbound rule", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });

    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(async () => {
      calls.push("put-policy");
      return { policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy, etag: undefined };
    });
    adapter.getCommunicationPolicy.mockImplementation(async () => ({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    }));
    adapter.putOutboundCloudConnectionRules.mockImplementation(async () => {
      calls.push("put-connections");
      return canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!;
    });
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockImplementation(async () => {
      calls.push("put-gateways");
      return canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!;
    });
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        allowNetworkPolicyUpdate: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls[0]).toBe("put-policy");
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining(["put-connections", "put-gateways"]),
    );
    expect(result?.communicationPolicy.status).toBe("updated");
    expect(result?.outboundCloudConnectionRules?.status).toBe("updated");
    expect(result?.outboundGatewayRules?.status).toBe("updated");
  });

  it("uses the freshly observed policy ETag instead of the approval-time ETag", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    plan.networkProtection!.communicationPolicy.etag = "approval-etag";
    const fresh = {
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        etag: "fresh-etag",
      },
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(fresh);
    adapter.putCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "updated-etag",
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "updated-etag",
    });

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.putCommunicationPolicy).toHaveBeenCalledWith(
      WORKSPACE_ID,
      canonicalOf(ALLOW_DESIRED).communicationPolicy,
      expect.objectContaining({ ifMatchEtag: "fresh-etag" }),
    );
  });

  it("rejects a fresh plan targeting a different network workspace", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      workspaceId: OTHER_WORKSPACE_ID,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: ALLOW_DESIRED,
        }),
      ),
    ).rejects.toThrow("does not match the approved target");
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("relaxes by applying configured outbound rules before the policy PUT", async () => {
    // Outbound stays Deny (unchanged) while only inbound is being forced back
    // to Allow from an out-of-band Deny; this is a relaxation without an
    // outbound default-action transition, so it takes the "apply rules
    // first" branch even though the master switch itself is being touched.
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Deny",
      observedOutbound: "Deny",
      policyAction: "update",
      ruleAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(async () => {
      calls.push("put-policy");
      return { policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy, etag: undefined };
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockImplementation(async () => {
      calls.push("put-connections");
      return canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!;
    });
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockImplementation(async () => {
      calls.push("put-gateways");
      return canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!;
    });
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls.indexOf("put-policy")).toBe(calls.length - 1);
    expect(calls.indexOf("put-connections")).toBeLessThan(calls.indexOf("put-policy"));
    expect(calls.indexOf("put-gateways")).toBeLessThan(calls.indexOf("put-policy"));
  });

  it("only verifies (never PUTs) a no-op surface", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), { desired: ALLOW_DESIRED }),
    );

    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(result?.communicationPolicy.status).toBe("verified");
  });

  it("writes a submitting checkpoint before the PUT resolves", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    let checkpointDuringDispatch: ApplyCheckpoint | undefined;
    adapter.putCommunicationPolicy.mockImplementation(
      async (_workspaceId: string, _body: unknown, opts?: { onDispatch?: () => void }) => {
        opts?.onDispatch?.();
        checkpointDuringDispatch = loadCheckpoint(checkpointFile, plan);
        return { policy: canonicalOf(ALLOW_DESIRED).communicationPolicy, etag: undefined };
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(checkpointDuringDispatch?.networkProtection?.communicationPolicy?.phase).toBe(
      "submitting",
    );
  });

  it("clears a definitively rejected surface so a later run can retry", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const checkpoint = createCheckpoint(plan);
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError("throttled", 429, "TooManyRequests");
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
      }).communicationPolicy,
      etag: undefined,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 429 });

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy,
    ).toBeUndefined();
  });

  it("retains submitting state when a final 4xx followed an ambiguous attempt", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError(
          "throttled after ambiguous failure",
          429,
          "TooManyRequests",
          undefined,
          true,
        );
      },
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toMatchObject({
      status: 429,
      priorAttemptAmbiguous: true,
    });

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("submitting");
    expect(adapter.getCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("accepts read-back success after a definitive retry rejection", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError(
          "precondition failed",
          412,
          "PreconditionFailed",
        );
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "new-etag",
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(result?.communicationPolicy.status).toBe("updated");
    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("verified");
  });

  it("preserves submitting state for an ambiguous transport failure", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new Error("connection reset");
      },
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toThrow("connection reset");

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("submitting");
  });

  it("fails closed when a submitting checkpoint cannot be confirmed live", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    // The live policy still shows the pre-mutation Deny state: the earlier
    // PUT's outcome is unresolved.
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
      }).communicationPolicy,
      etag: undefined,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: ALLOW_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toThrow("ambiguous");
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("resumes a submitting checkpoint once confirmed live, without re-dispatching", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(result?.communicationPolicy.status).toBe("resumed");
  });

  it("does not resubmit an ambiguous inbound firewall replacement and re-requires lockout acknowledgement", async () => {
    const plan = buildApprovedPlan({
      desired: INBOUND_TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      firewallAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      inboundFirewallRules: {
        desiredHash:
          plan.networkProtection!.inboundFirewallRules!.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_TIGHTENING_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowInboundFirewallUpdate: true,
          acknowledgeFirewallLockoutRisk: false,
        }),
      ),
    ).rejects.toThrow("acknowledge-firewall-lockout-risk");
    expect(adapter.getInboundFirewallRules).not.toHaveBeenCalled();
    expect(adapter.putInboundFirewallRules).not.toHaveBeenCalled();

    adapter.getInboundFirewallRules.mockResolvedValue({
      configuration: { rules: [] },
      etag: "current-etag",
    });
    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: INBOUND_TIGHTENING_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowInboundFirewallUpdate: true,
          acknowledgeFirewallLockoutRisk: true,
        }),
      ),
    ).rejects.toThrow("ambiguous");
    expect(adapter.putInboundFirewallRules).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });
});

describe("recoverInterruptedNetworkProtection", () => {
  it("does nothing when no surface is mid-mutation", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const adapter = mockAdapter();

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), { desired: ALLOW_DESIRED }),
    );

    expect(adapter.plan).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("does not let a stale completed marker suppress submitting recovery", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      completedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.plan).toHaveBeenCalledTimes(2);
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(checkpoint.networkProtection.communicationPolicy?.phase).toBe(
      "verified",
    );
  });

  it("completes all remaining surfaces once a tightening mutation has started", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: "a".repeat(64),
      },
      outboundGatewayRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: "b".repeat(64),
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    const checkpointFile = checkpointFilePath();

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(adapter.plan).toHaveBeenCalledTimes(2);
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(adapter.putOutboundCloudConnectionRules).toHaveBeenCalledOnce();
    expect(adapter.putOutboundGatewayRules).toHaveBeenCalledOnce();
    const persisted = loadCheckpoint(checkpointFile, plan);
    expect(persisted?.networkProtection?.communicationPolicy?.phase).toBe("verified");
    expect(
      persisted?.networkProtection?.outboundCloudConnectionRules?.phase,
    ).toBe("verified");
    expect(
      persisted?.networkProtection?.outboundGatewayRules?.phase,
    ).toBe("verified");
    expect(persisted?.networkProtection?.completedAt).toBeDefined();
  });

  it("preflights every remaining surface before recovery dispatches any PUT", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: "a".repeat(64),
      },
      outboundGatewayRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: "b".repeat(64),
      },
    });

    await expect(
      recoverInterruptedNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowOutboundCloudConnectionRuleUpdate: true,
          allowOutboundGatewayRuleUpdate: false,
        }),
      ),
    ).rejects.toThrow(
      "allow-outbound-gateway-rule-update is false",
    );

    expect(
      adapter.putOutboundCloudConnectionRules,
    ).not.toHaveBeenCalled();
    expect(adapter.putOutboundGatewayRules).not.toHaveBeenCalled();
  });

  it("does not falsely flag drift for a rule surface once OAP was enabled by an earlier recovery pass", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpointFile = checkpointFilePath();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const adapter = mockAdapter();
    // A fresh live plan now sees OAP already enabled (Deny), so the outbound
    // rule surfaces compute a real (non-sentinel) observed hash that differs
    // from the approved plan's pre-tightening sentinel snapshot.
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "no-op",
        reason: "matches",
        desiredHash: plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
      },
      outboundGatewayRules: {
        action: "no-op",
        reason: "matches",
        desiredHash: plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: plan.networkProtection!.outboundGatewayRules!.desiredHash,
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          checkpoint: loadCheckpoint(checkpointFile, plan) ?? checkpoint,
          allowNetworkPolicyUpdate: true,
          allowOutboundCloudConnectionRuleUpdate: true,
          allowOutboundGatewayRuleUpdate: true,
        }),
      ),
    ).resolves.toMatchObject({
      communicationPolicy: { status: "resumed" },
      outboundCloudConnectionRules: { status: "updated" },
      outboundGatewayRules: { status: "updated" },
    });
  });
});
