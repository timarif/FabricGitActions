import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  hashObservedVirtualNetworkGateway,
  type VirtualNetworkGateway,
} from "../src/fabric/virtual-network-gateway";
import {
  hashCommunicationPolicy,
  hashOutboundGatewayRules,
  normalizeNetworkProtection,
} from "../src/fabric/network-protection";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  LoadedManifest,
  VirtualNetworkGatewayDefinition,
} from "../src/types";

const CREATED_ID = "11111111-1111-4111-8111-111111111111";
const DELETED_ID = "22222222-2222-4222-8222-222222222222";
const CAPACITY_ID = "33333333-3333-4333-8333-333333333333";
const SUBSCRIPTION_ID = "44444444-4444-4444-8444-444444444444";

function gatewayDefinition(
  logicalId: string,
  displayName: string,
  overrides: Partial<VirtualNetworkGatewayDefinition> = {},
): VirtualNetworkGatewayDefinition {
  return {
    logicalId,
    displayName,
    capacityId: CAPACITY_ID,
    virtualNetworkAzureResource: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroupName: "fabric-network",
      virtualNetworkName: "fabric-vnet",
      subnetName: logicalId,
    },
    inactivityMinutesBeforeSleep: 30,
    numberOfMemberGateways: 1,
    ...overrides,
  };
}

function gateway(
  definition: VirtualNetworkGatewayDefinition,
  id: string,
): VirtualNetworkGateway {
  return {
    id,
    type: "VirtualNetwork",
    displayName: definition.displayName,
    capacityId: definition.capacityId ?? CAPACITY_ID,
    virtualNetworkAzureResource:
      definition.virtualNetworkAzureResource,
    inactivityMinutesBeforeSleep:
      definition.inactivityMinutesBeforeSleep ?? 30,
    numberOfMemberGateways:
      definition.numberOfMemberGateways ?? 1,
  };
}

describe("virtual network gateway apply ordering", () => {
  it("creates present gateways before network policy and deletes absent gateways after it", async () => {
    const present = gatewayDefinition(
      "newGateway",
      "New Gateway",
    );
    const absent = gatewayDefinition(
      "retiredGateway",
      "Retired Gateway",
      {
        id: DELETED_ID,
        desiredState: "absent",
      },
    );
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
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "gateway-ordering" },
        workspace: { id: "workspace-1" },
        virtualNetworkGateways: [present, absent],
        networkProtection: {
          communicationPolicy: {
            inboundDefaultAction: "Allow",
            outboundDefaultAction: "Deny",
          },
          outboundGatewayRules: {
            defaultAction: "Deny",
            allowedGateways: [],
          },
        },
        items: [],
      },
    };
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const existing = gateway(absent, DELETED_ID);
    plan.virtualNetworkGateways = plan.virtualNetworkGateways!.map(
      (planned) =>
        planned.logicalId === present.logicalId
          ? {
              ...planned,
              action: "create",
              reason: "missing",
            }
          : {
              ...planned,
              action: "delete",
              reason: "retire",
              physicalId: DELETED_ID,
              observedStateHash:
                hashObservedVirtualNetworkGateway(existing),
            },
    );
    const network = normalizeNetworkProtection(
      loaded.manifest.networkProtection!,
    );
    const policyHash = hashCommunicationPolicy(
      network.communicationPolicy,
    );
    plan.networkProtection = {
      workspaceId: "workspace-1",
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: policyHash,
        observedStateHash: policyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Deny",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Deny",
        isRelaxation: false,
      },
      outboundGatewayRules: {
        action: "no-op",
        reason: "matches",
        desiredHash: hashOutboundGatewayRules(
          network.outboundGatewayRules!,
        ),
        observedStateHash: hashOutboundGatewayRules(
          network.outboundGatewayRules!,
        ),
      },
    };
    const approved = rehashPlan(plan);
    const calls: string[] = [];
    const created = gateway(present, CREATED_ID);
    const gatewayAdapter = {
      plan: vi.fn(
        async (definition: VirtualNetworkGatewayDefinition) => {
          const planned =
            approved.virtualNetworkGateways!.find(
              (entry) =>
                entry.logicalId === definition.logicalId,
            )!;
          return {
            action: planned.action as
              | "create"
              | "update"
              | "delete"
              | "no-op"
              | "blocked",
            reason: planned.reason,
            desiredHash: planned.desiredHash,
            observedStateHash: planned.observedStateHash,
            ...(planned.physicalId
              ? { physicalId: planned.physicalId }
              : {}),
          };
        },
      ),
      create: vi.fn(
        async (
          _definition: VirtualNetworkGatewayDefinition,
          callbacks: {
            onSubmitting?: () => void;
            onAccepted?: (id: string) => void;
          },
        ) => {
          calls.push("create");
          callbacks.onSubmitting?.();
          callbacks.onAccepted?.(CREATED_ID);
          return created;
        },
      ),
      resumeCreate: vi.fn(),
      update: vi.fn(),
      resumeUpdate: vi.fn(),
      delete: vi.fn(
        async (
          _id: string,
          _definition: VirtualNetworkGatewayDefinition,
          callbacks: {
            onSubmitting?: () => void;
            onAccepted?: (id: string) => void;
          },
        ) => {
          calls.push("delete");
          callbacks.onSubmitting?.();
          callbacks.onAccepted?.(DELETED_ID);
        },
      ),
      resumeDelete: vi.fn(),
      verifyPresent: vi.fn(async () => created),
      verifyAbsent: vi.fn(async () => undefined),
    };
    const networkAdapter = {
      plan: vi.fn(async () => approved.networkProtection!),
      getCommunicationPolicy: vi.fn(async () => {
        return {
          policy: network.communicationPolicy,
          etag: undefined,
        };
      }),
      putCommunicationPolicy: vi.fn(),
      getOutboundCloudConnectionRules: vi.fn(),
      putOutboundCloudConnectionRules: vi.fn(),
      getOutboundGatewayRules: vi.fn(async () => {
        calls.push("network");
        return network.outboundGatewayRules!;
      }),
      putOutboundGatewayRules: vi.fn(),
    };
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-vnet-ordering-"),
    );

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: {
        plan: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        resumeCreate: vi.fn(),
        verify: vi.fn(),
      },
      virtualNetworkGatewayAdapter: gatewayAdapter,
      networkProtectionAdapter: networkAdapter,
      allowCreate: false,
      allowUpdate: false,
      allowVirtualNetworkGatewayCreate: true,
      allowVirtualNetworkGatewayDelete: true,
      checkpointFile: path.join(root, "checkpoint.json"),
      resultFile: path.join(root, "result.json"),
    });

    expect(calls).toEqual(["create", "network", "delete"]);
    expect(result.virtualNetworkGateways).toEqual([
      expect.objectContaining({
        logicalId: "newGateway",
        status: "created",
      }),
      expect.objectContaining({
        logicalId: "retiredGateway",
        status: "deleted",
      }),
    ]);
  });
});
