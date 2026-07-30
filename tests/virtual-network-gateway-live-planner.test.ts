import { describe, expect, it, vi } from "vitest";

import {
  enrichPlanWithFabric,
  type FabricPlanAdapters,
} from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

function loaded(): LoadedManifest {
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
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "vnet-gateway" },
      workspace: { id: "workspace-1" },
      virtualNetworkGateways: [
        {
          logicalId: "managedGateway",
          displayName: "Managed Gateway",
          capacityId: "22222222-2222-4222-8222-222222222222",
          virtualNetworkAzureResource: {
            subscriptionId:
              "33333333-3333-4333-8333-333333333333",
            resourceGroupName: "fabric-network",
            virtualNetworkName: "fabric-vnet",
            subnetName: "fabric-gateway",
          },
          inactivityMinutesBeforeSleep: 30,
          numberOfMemberGateways: 2,
        },
      ],
      items: [],
    },
  };
}

function requiredAdapters(): FabricPlanAdapters {
  const unused = { plan: vi.fn() };
  return {
    lakehouse: unused as never,
    environment: unused as never,
    notebook: unused as never,
    sparkJob: unused as never,
    pipeline: unused as never,
    semanticModel: unused as never,
    sparkCustomPool: unused as never,
  };
}

describe("virtual network gateway live planning", () => {
  it("maps global gateway discovery into the deployment plan", async () => {
    const manifest = loaded();
    const offline = buildPlan(manifest, {
      mode: "plan",
      environment: "dev",
    });
    const planAll = vi.fn(async () => [
      {
        action: "create" as const,
        reason: "missing",
        desiredHash:
          offline.virtualNetworkGateways![0]!.desiredHash,
        observedStateHash: "a".repeat(64),
      },
    ]);

    const online = await enrichPlanWithFabric(offline, manifest, {
      ...requiredAdapters(),
      virtualNetworkGateways: { planAll },
    });

    expect(planAll).toHaveBeenCalledWith(
      manifest.manifest.virtualNetworkGateways,
    );
    expect(online.virtualNetworkGateways).toEqual([
      expect.objectContaining({
        logicalId: "managedGateway",
        action: "create",
        reason: "missing",
        observedStateHash: "a".repeat(64),
      }),
    ]);
  });

  it("plans gateways even while a managed workspace bootstrap is pending", async () => {
    const manifest = loaded();
    manifest.manifest.workspace = {
      displayName: "Managed workspace",
    };
    const offline = buildPlan(manifest, {
      mode: "plan",
      environment: "dev",
    });

    const online = await enrichPlanWithFabric(offline, manifest, {
      ...requiredAdapters(),
      workspace: {
        plan: vi.fn(async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "b".repeat(64),
          managedMetadataMatches: false,
          capacityAssignmentRequired: false,
        })),
      },
      virtualNetworkGateways: {
        planAll: vi.fn(async () => [
          {
            action: "no-op" as const,
            reason: "matches",
            desiredHash:
              offline.virtualNetworkGateways![0]!.desiredHash,
            observedStateHash: "c".repeat(64),
            physicalId:
              "11111111-1111-4111-8111-111111111111",
          },
        ]),
      },
    });

    expect(online.workspace?.action).toBe("create");
    expect(online.virtualNetworkGateways?.[0]).toMatchObject({
      action: "no-op",
      physicalId: "11111111-1111-4111-8111-111111111111",
    });
  });
});
