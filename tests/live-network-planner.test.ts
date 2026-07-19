import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type {
  LoadedManifest,
  NetworkProtectionManifest,
  PlannedNetworkProtection,
} from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INDEPENDENT_WORKSPACE_ID = "55555555-5555-4555-8555-555555555555";
const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";

const desiredNetworkProtection: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
};

function loadedManifest(
  overrides: Partial<LoadedManifest["manifest"]> = {},
): LoadedManifest {
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
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "network-protection" },
      items: [],
      ...overrides,
    },
  };
}

function unsupportedAdapter() {
  return {
    plan: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
}

function baseAdapters(networkProtectionPlan: PlannedNetworkProtection | undefined) {
  return {
    lakehouse: unsupportedAdapter(),
    environment: unsupportedAdapter(),
    notebook: unsupportedAdapter(),
    sparkJob: unsupportedAdapter(),
    pipeline: unsupportedAdapter(),
    sparkCustomPool: unsupportedAdapter(),
    networkProtection: {
      plan: vi.fn(async () => networkProtectionPlan as PlannedNetworkProtection),
    },
  };
}

describe("network protection live planning", () => {
  it("plans network protection against an explicit workspace ID target", async () => {
    const loaded = loadedManifest({
      workspace: { id: WORKSPACE_ID },
      networkProtection: desiredNetworkProtection,
    });
    const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
    const networkProtectionPlan = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        action: "no-op" as const,
        reason: "matches",
        desiredHash: "desired-hash",
        observedStateHash: "observed-hash",
        desiredInboundDefaultAction: "Allow" as const,
        desiredOutboundDefaultAction: "Allow" as const,
        observedInboundDefaultAction: "Allow" as const,
        observedOutboundDefaultAction: "Allow" as const,
        isRelaxation: false,
      },
    };
    const adapters = baseAdapters(networkProtectionPlan);

    const enriched = await enrichPlanWithFabric(plan, loaded, adapters);

    expect(adapters.networkProtection.plan).toHaveBeenCalledWith(
      WORKSPACE_ID,
      desiredNetworkProtection,
    );
    expect(enriched.networkProtection).toEqual(networkProtectionPlan);
  });

  it("blocks network protection when the managed workspace is pending creation and no explicit workspaceId is set", async () => {
    const loaded = loadedManifest({
      workspace: { displayName: "tva-Analytics" },
      networkProtection: {
        ...desiredNetworkProtection,
        inboundFirewallRules: {
          rules: [
            {
              displayName: "corporate",
              value: "12.34.56.78",
            },
          ],
        },
        inboundAzureResourceRules: {
          rules: [
            {
              displayName: "sql-server",
              resourceId: TARGET_ID,
            },
          ],
        },
        inboundExternalDataSharesPolicy: { defaultAction: "Deny" },
        managedPrivateEndpoints: [
          {
            name: "storage-blob",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve",
          },
        ],
      },
    });
    const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
    const adapters = {
      ...baseAdapters(undefined),
      workspace: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
          managedMetadataMatches: false,
          capacityAssignmentRequired: false,
        })),
      },
    };

    const enriched = await enrichPlanWithFabric(plan, loaded, adapters);

    expect(enriched.networkProtection?.communicationPolicy.action).toBe(
      "blocked",
    );
    expect(
      enriched.networkProtection?.inboundFirewallRules,
    ).toMatchObject({
      action: "blocked",
      ruleCount: 1,
    });
    expect(
      enriched.networkProtection?.inboundAzureResourceRules,
    ).toMatchObject({
      action: "blocked",
      ruleCount: 1,
    });
    expect(
      enriched.networkProtection?.inboundExternalDataSharesPolicy,
    ).toMatchObject({
      action: "blocked",
      desiredDefaultAction: "Deny",
    });
    expect(enriched.networkProtection?.communicationPolicy.reason).toContain(
      "managed workspace must be provisioned",
    );
    expect(
      enriched.networkProtection?.managedPrivateEndpoints?.[0],
    ).toMatchObject({
      action: "blocked",
      bootstrapBlocked: true,
    });
    expect(adapters.networkProtection.plan).not.toHaveBeenCalled();
  });

  it("does not block network protection with an independent explicit workspaceId, even while the managed workspace is pending creation", async () => {
    const loaded = loadedManifest({
      workspace: { displayName: "tva-Analytics" },
      networkProtection: {
        ...desiredNetworkProtection,
        workspaceId: INDEPENDENT_WORKSPACE_ID,
      },
    });
    const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
    const networkProtectionPlan = {
      workspaceId: INDEPENDENT_WORKSPACE_ID,
      communicationPolicy: {
        action: "no-op" as const,
        reason: "matches",
        desiredHash: "desired-hash",
        observedStateHash: "observed-hash",
        desiredInboundDefaultAction: "Allow" as const,
        desiredOutboundDefaultAction: "Allow" as const,
      },
    };
    const adapters = {
      ...baseAdapters(networkProtectionPlan),
      workspace: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
          managedMetadataMatches: false,
          capacityAssignmentRequired: false,
        })),
      },
    };

    const enriched = await enrichPlanWithFabric(plan, loaded, adapters);

    expect(adapters.networkProtection.plan).toHaveBeenCalledWith(
      expect.any(String),
      loaded.manifest.networkProtection,
    );
    expect(enriched.networkProtection).toEqual(networkProtectionPlan);
  });

  it("blocks network protection when the managed workspace plan itself is blocked", async () => {
    const loaded = loadedManifest({
      workspace: { displayName: "tva-Analytics" },
      networkProtection: desiredNetworkProtection,
    });
    const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
    const adapters = {
      ...baseAdapters(undefined),
      workspace: {
        plan: vi.fn(async () => ({
          action: "blocked" as const,
          reason: "name collision",
          observedStateHash: "collision",
          managedMetadataMatches: false,
          capacityAssignmentRequired: false,
        })),
      },
    };

    const enriched = await enrichPlanWithFabric(plan, loaded, adapters);

    expect(enriched.networkProtection?.communicationPolicy.action).toBe(
      "blocked",
    );
    expect(enriched.networkProtection?.communicationPolicy.reason).toBe(
      "The managed workspace plan is blocked.",
    );
  });

  it("omits networkProtection entirely when the manifest does not declare it", async () => {
    const loaded = loadedManifest({ workspace: { id: WORKSPACE_ID } });
    const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
    const adapters = baseAdapters(undefined);

    const enriched = await enrichPlanWithFabric(plan, loaded, adapters);

    expect(enriched.networkProtection).toBeUndefined();
    expect(adapters.networkProtection.plan).not.toHaveBeenCalled();
  });
});
