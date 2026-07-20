import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import {
  hashCommunicationPolicy,
  hashInboundAzureResourceRules,
  hashInboundExternalDataSharesPolicy,
  hashInboundFirewallRules,
  normalizeNetworkProtection,
} from "../src/fabric/network-protection";
import type {
  DesiredWorkspace,
  WorkspaceLifecycleCallbacks,
} from "../src/fabric/workspace";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest, NetworkProtectionManifest } from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const DESIRED_NETWORK_PROTECTION: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Deny",
  },
};

function loadedWithLakehouseAndNetworkProtection(): LoadedManifest {
  return {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: { lakehouse: "content" },
    itemDirectories: { lakehouse: "items/lakehouse" },
    itemDefinitions: { lakehouse: { displayName: "Bronze" } },
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: {},
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "network-protection-integration" },
      workspace: { id: WORKSPACE_ID },
      networkProtection: DESIRED_NETWORK_PROTECTION,
      items: [
        {
          logicalId: "lakehouse",
          type: "Lakehouse",
          path: "items/lakehouse",
        },
      ],
    },
  };
}

function files() {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-network-protection-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function buildApprovedPlan(
  loaded: LoadedManifest,
  policyAction: "update" | "no-op" | "blocked",
  desired: NetworkProtectionManifest = DESIRED_NETWORK_PROTECTION,
) {
  const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
  const canonical = normalizeNetworkProtection(desired);
  const desiredHash = hashCommunicationPolicy(canonical.communicationPolicy);
  const observedHash = hashCommunicationPolicy({
    inbound: { publicAccessRules: { defaultAction: "Allow" } },
    outbound: { publicAccessRules: { defaultAction: "Allow" } },
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: "create",
    reason: "missing",
    observedStateHash: "absent",
  };
  plan.networkProtection = {
    workspaceId: WORKSPACE_ID,
    communicationPolicy: {
      action: policyAction,
      reason: policyAction === "no-op" ? "matches" : "differs",
      desiredHash,
      observedStateHash: policyAction === "no-op" ? desiredHash : observedHash,
      desiredInboundDefaultAction:
        canonical.communicationPolicy.inbound.publicAccessRules
          .defaultAction,
      desiredOutboundDefaultAction:
        canonical.communicationPolicy.outbound.publicAccessRules
          .defaultAction,
      observedInboundDefaultAction: "Allow",
      observedOutboundDefaultAction: "Allow",
      isRelaxation: false,
    },
  };
  if (canonical.inboundFirewallRules) {
    plan.networkProtection.inboundFirewallRules = {
      action: "update",
      reason: "differs",
      desiredHash: hashInboundFirewallRules(
        canonical.inboundFirewallRules,
      ),
      observedStateHash: hashInboundFirewallRules({ rules: [] }),
      etag: "firewall-etag",
      ruleCount: canonical.inboundFirewallRules.rules.length,
    };
  }
  if (canonical.inboundAzureResourceRules) {
    plan.networkProtection.inboundAzureResourceRules = {
      action: "update",
      reason: "differs",
      desiredHash: hashInboundAzureResourceRules(
        canonical.inboundAzureResourceRules,
      ),
      observedStateHash: hashInboundAzureResourceRules({ rules: [] }),
      etag: "azure-resource-etag",
      ruleCount: canonical.inboundAzureResourceRules.rules.length,
    };
  }
  if (canonical.inboundExternalDataSharesPolicy) {
    const desiredDefaultAction =
      canonical.inboundExternalDataSharesPolicy.defaultAction;
    const observedDefaultAction =
      desiredDefaultAction === "Allow" ? "Deny" : "Allow";
    plan.networkProtection.inboundExternalDataSharesPolicy = {
      action: "update",
      reason: "differs",
      desiredHash: hashInboundExternalDataSharesPolicy(
        canonical.inboundExternalDataSharesPolicy,
      ),
      observedStateHash: hashInboundExternalDataSharesPolicy({
        defaultAction: observedDefaultAction,
      }),
      etag: "external-data-shares-etag",
      desiredDefaultAction,
      observedDefaultAction,
      isRelaxation:
        observedDefaultAction === "Deny" && desiredDefaultAction === "Allow",
    };
  }
  return rehashPlan(plan);
}

function networkProtectionAdapter(calls: string[]) {
  return {
    plan: vi.fn(async () => undefined as never),
    getCommunicationPolicy: vi.fn(async () => ({
      policy: normalizeNetworkProtection(DESIRED_NETWORK_PROTECTION).communicationPolicy,
      etag: undefined,
    })),
    putCommunicationPolicy: vi.fn(async () => {
      calls.push("network-protection-put");
      return {
        policy: normalizeNetworkProtection(DESIRED_NETWORK_PROTECTION).communicationPolicy,
        etag: undefined,
      };
    }),
    getOutboundCloudConnectionRules: vi.fn(),
    putOutboundCloudConnectionRules: vi.fn(),
    getOutboundGatewayRules: vi.fn(),
    putOutboundGatewayRules: vi.fn(),
  };
}

describe("network protection apply integration", () => {
  it("rejects a rehashed plan that omits networkProtection before any item mutation", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundExternalDataSharesPolicy: { defaultAction: "Allow" },
    };
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.networkProtection = desired;
    const current = buildApprovedPlan(loaded, "no-op", desired);
    const tampered = structuredClone(current);
    delete tampered.networkProtection;
    const approved = rehashPlan(tampered);
    const create = vi.fn();
    const adapter = {
      ...networkProtectionAdapter([]),
      getInboundExternalDataSharesPolicy: vi.fn(),
      putInboundExternalDataSharesPolicy: vi.fn(),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: false,
        allowInboundExternalDataSharePolicyUpdate: false,
        allowInboundExternalDataSharePolicyRelaxation: false,
        ...files(),
      }),
    ).rejects.toThrow("omits networkProtection");

    expect(create).not.toHaveBeenCalled();
    expect(adapter.plan).not.toHaveBeenCalled();
    expect(adapter.putInboundExternalDataSharesPolicy).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("applies network protection only after every item stage completes", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    const approved = buildApprovedPlan(loaded, "update");
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    npAdapter.plan.mockResolvedValue(approved.networkProtection as never);
    const create = vi.fn(
      async (
        _workspaceId: string,
        _desired: { displayName: string },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        calls.push("lakehouse-create");
        onMutationAccepted?.("lakehouse-created");
        return {
          id: "lakehouse-created",
          displayName: "Bronze",
          type: "Lakehouse" as const,
        };
      },
    );
    const planLakehouse = vi.fn(async () => ({
      action: "create" as const,
      reason: "missing",
      observedStateHash: "absent",
    }));

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: {
        plan: planLakehouse,
        create,
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(),
      },
      networkProtectionAdapter: npAdapter,
      allowCreate: true,
      allowUpdate: false,
      allowNetworkPolicyUpdate: true,
      allowNetworkPolicyRelaxation: true,
      ...files(),
    });

    expect(calls).toEqual(["lakehouse-create", "network-protection-put"]);
    expect(result.status).toBe("succeeded");
    expect(result.items[0]?.status).toBe("created");
    expect(result.networkProtection?.communicationPolicy.status).toBe("updated");
  });

  it("requires allow-network-policy-update before mutating the communication policy", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    const approved = buildApprovedPlan(loaded, "update");
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    npAdapter.plan.mockResolvedValue(approved.networkProtection as never);
    const create = vi.fn(async () => ({
      id: "lakehouse-created",
      displayName: "Bronze",
      type: "Lakehouse" as const,
    }));
    const planLakehouse = vi.fn(async () => ({
      action: "create" as const,
      reason: "missing",
      observedStateHash: "absent",
    }));

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: planLakehouse,
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: npAdapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: false,
        ...files(),
      }),
    ).rejects.toThrow("allow-network-policy-update is false");
    expect(npAdapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("preflights inbound firewall lockout safeguards before any item mutation", async () => {
    const desired: NetworkProtectionManifest = {
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
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.networkProtection = desired;
    const approved = buildApprovedPlan(
      loaded,
      "update",
      desired,
    );
    const create = vi.fn();
    const adapter = {
      ...networkProtectionAdapter([]),
      getInboundFirewallRules: vi.fn(),
      putInboundFirewallRules: vi.fn(),
    };
    adapter.plan.mockResolvedValue(
      approved.networkProtection as never,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowInboundFirewallUpdate: false,
        acknowledgeFirewallLockoutRisk: true,
        ...files(),
      }),
    ).rejects.toThrow("requires allow-inbound-firewall-update");

    expect(create).not.toHaveBeenCalled();
    expect(adapter.putInboundFirewallRules).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("preflights the inbound Azure resource rule safeguard independently before any item mutation", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundAzureResourceRules: {
        rules: [
          {
            displayName: "sql-server",
            resourceId:
              "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Sql/servers/sqlserver",
          },
        ],
      },
    };
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.networkProtection = desired;
    const approved = buildApprovedPlan(loaded, "no-op", desired);
    const create = vi.fn();
    const adapter = {
      ...networkProtectionAdapter([]),
      getInboundAzureResourceRules: vi.fn(),
      putInboundAzureResourceRules: vi.fn(),
    };
    adapter.plan.mockResolvedValue(
      approved.networkProtection as never,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowInboundAzureResourceRuleUpdate: false,
        ...files(),
      }),
    ).rejects.toThrow("allow-inbound-azure-resource-rule-update is false");

    expect(create).not.toHaveBeenCalled();
    expect(adapter.putInboundAzureResourceRules).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("preflights the inbound External Data Shares policy relaxation safeguard independently before any item mutation", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundExternalDataSharesPolicy: { defaultAction: "Allow" },
    };
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.networkProtection = desired;
    const approved = buildApprovedPlan(loaded, "no-op", desired);
    const create = vi.fn();
    const adapter = {
      ...networkProtectionAdapter([]),
      getInboundExternalDataSharesPolicy: vi.fn(),
      putInboundExternalDataSharesPolicy: vi.fn(),
    };
    adapter.plan.mockResolvedValue(
      approved.networkProtection as never,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowInboundExternalDataSharePolicyUpdate: true,
        allowInboundExternalDataSharePolicyRelaxation: false,
        ...files(),
      }),
    ).rejects.toThrow(
      "allow-inbound-external-data-share-policy-relaxation is false",
    );

    expect(create).not.toHaveBeenCalled();
    expect(adapter.putInboundExternalDataSharesPolicy).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("rejects a rehashed plan that omits the External Data Shares policy before any item mutation", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundExternalDataSharesPolicy: { defaultAction: "Allow" },
    };
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.networkProtection = desired;
    const current = buildApprovedPlan(loaded, "no-op", desired);
    const tampered = structuredClone(current);
    delete tampered.networkProtection!.inboundExternalDataSharesPolicy;
    const approved = rehashPlan(tampered);
    const create = vi.fn();
    const adapter = {
      ...networkProtectionAdapter([]),
      getInboundExternalDataSharesPolicy: vi.fn(),
      putInboundExternalDataSharesPolicy: vi.fn(),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: false,
        allowInboundExternalDataSharePolicyUpdate: false,
        allowInboundExternalDataSharePolicyRelaxation: false,
        ...files(),
      }),
    ).rejects.toThrow("omits inbound External Data Shares policy");

    expect(create).not.toHaveBeenCalled();
    expect(adapter.plan).not.toHaveBeenCalled();
    expect(adapter.putInboundExternalDataSharesPolicy).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("refuses to apply a blocked network protection plan", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    const approved = buildApprovedPlan(loaded, "blocked");
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    const create = vi.fn(async () => ({
      id: "lakehouse-created",
      displayName: "Bronze",
      type: "Lakehouse" as const,
    }));
    const planLakehouse = vi.fn(async () => ({
      action: "create" as const,
      reason: "missing",
      observedStateHash: "absent",
    }));

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: planLakehouse,
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: npAdapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        ...files(),
      }),
    ).rejects.toThrow("blocked");
  });

  it("preflights the current network target before recovery or item mutation", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    const approved = buildApprovedPlan(loaded, "update");
    const current = structuredClone(approved);
    current.networkProtection!.workspaceId = OTHER_WORKSPACE_ID;
    const outputFiles = files();
    const checkpoint = createCheckpoint(approved);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash:
          approved.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(outputFiles.checkpointFile, checkpoint);
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    const create = vi.fn(async () => ({
      id: "lakehouse-created",
      displayName: "Bronze",
      type: "Lakehouse" as const,
    }));

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: current,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: npAdapter,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        ...outputFiles,
      }),
    ).rejects.toThrow("does not match the approved target");

    expect(npAdapter.plan).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("recovers a started network mutation before unrelated item preflight fails", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    const approved = buildApprovedPlan(loaded, "update");
    const outputFiles = files();
    const checkpoint = createCheckpoint(approved);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash:
          approved.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(outputFiles.checkpointFile, checkpoint);
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    npAdapter.plan.mockResolvedValue(
      {
        ...approved.networkProtection!,
        communicationPolicy: {
          ...approved.networkProtection!.communicationPolicy,
          action: "no-op",
          reason: "matches",
          observedStateHash:
            approved.networkProtection!.communicationPolicy.desiredHash,
          observedOutboundDefaultAction: "Deny",
          isRelaxation: false,
        },
      } as never,
    );
    const create = vi.fn();

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create,
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: vi.fn(),
        },
        networkProtectionAdapter: npAdapter,
        allowCreate: false,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        ...outputFiles,
      }),
    ).rejects.toThrow("allow-create");

    expect(npAdapter.plan).toHaveBeenCalledTimes(2);
    expect(npAdapter.getCommunicationPolicy).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(
      loadCheckpoint(outputFiles.checkpointFile, approved)
        ?.networkProtection?.communicationPolicy?.phase,
    ).toBe("verified");
  });

  it("applies an independent network target during managed workspace bootstrap", async () => {
    const loaded = loadedWithLakehouseAndNetworkProtection();
    loaded.manifest.workspace = { displayName: "Managed Workspace" };
    loaded.manifest.networkProtection = {
      ...DESIRED_NETWORK_PROTECTION,
      workspaceId: WORKSPACE_ID,
    };
    const plan = buildApprovedPlan(loaded, "update");
    plan.workspace = {
      ...plan.workspace!,
      action: "create",
      reason: "missing",
      observedStateHash: "absent",
      capacityAssignmentRequired: false,
    };
    plan.items[0] = {
      ...plan.items[0]!,
      action: "blocked",
      reason: "workspace bootstrap",
      observedStateHash: "absent",
    };
    const approved = rehashPlan(plan);
    const calls: string[] = [];
    const npAdapter = networkProtectionAdapter(calls);
    npAdapter.plan.mockResolvedValue(approved.networkProtection as never);
    const failItem = vi.fn(async () => {
      throw new Error("Child item adapter should not run before replanning.");
    });
    const workspaceAdapter = {
      create: vi.fn(
        async (
          _desired: DesiredWorkspace,
          callbacks: WorkspaceLifecycleCallbacks = {},
        ) => {
          calls.push("workspace-create");
          callbacks.onCreateSubmitting?.();
          callbacks.onCreateAccepted?.("workspace-created");
          return {
            id: "workspace-created",
            displayName: "Managed Workspace",
            type: "Workspace" as const,
            capacityAssignmentProgress: "Completed" as const,
          };
        },
      ),
      resumeCreate: vi.fn(),
      update: vi.fn(),
      resumeUpdate: vi.fn(),
      verify: vi.fn(),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      workspaceAdapter,
      lakehouseAdapter: {
        plan: failItem,
        create: failItem,
        update: failItem,
        resumeCreate: failItem,
        verify: failItem,
      },
      networkProtectionAdapter: npAdapter,
      allowCreate: true,
      allowUpdate: false,
      allowWorkspaceCreate: true,
      allowWorkspaceUpdate: false,
      allowNetworkPolicyUpdate: true,
      allowNetworkPolicyRelaxation: true,
      ...files(),
    });

    expect(calls).toEqual([
      "workspace-create",
      "network-protection-put",
    ]);
    expect(result).toMatchObject({
      status: "succeeded",
      workspaceId: "workspace-created",
      requiresItemReplan: true,
      networkProtection: {
        workspaceId: WORKSPACE_ID,
        communicationPolicy: { status: "updated" },
      },
      items: [],
    });
    expect(failItem).not.toHaveBeenCalled();
  });
});
