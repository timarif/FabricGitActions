import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCheckpoint } from "../src/checkpoint";
import {
  hashDesiredVirtualNetworkGateway,
  hashObservedVirtualNetworkGateway,
  type VirtualNetworkGateway,
} from "../src/fabric/virtual-network-gateway";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  LoadedManifest,
  VirtualNetworkGatewayDefinition,
} from "../src/types";
import {
  applyVirtualNetworkGateways,
  preflightVirtualNetworkGateways,
  recoverInterruptedVirtualNetworkGateways,
} from "../src/virtual-network-gateway-apply";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const CAPACITY_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333";

function desired(
  overrides: Partial<VirtualNetworkGatewayDefinition> = {},
): VirtualNetworkGatewayDefinition {
  return {
    logicalId: "managedGateway",
    displayName: "Managed Gateway",
    capacityId: CAPACITY_ID,
    virtualNetworkAzureResource: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroupName: "fabric-network",
      virtualNetworkName: "fabric-vnet",
      subnetName: "fabric-gateway",
    },
    inactivityMinutesBeforeSleep: 30,
    numberOfMemberGateways: 2,
    ...overrides,
  };
}

function gateway(): VirtualNetworkGateway {
  return {
    id: GATEWAY_ID,
    type: "VirtualNetwork",
    displayName: "Managed Gateway",
    capacityId: CAPACITY_ID,
    virtualNetworkAzureResource: desired().virtualNetworkAzureResource,
    inactivityMinutesBeforeSleep: 30,
    numberOfMemberGateways: 2,
  };
}

function deployment(
  definition = desired(),
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
    semanticModelDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "vnet-gateway" },
      workspace: { id: "workspace-1" },
      virtualNetworkGateways: [definition],
      items: [],
    },
  };
}

function plan(
  action: "create" | "update" | "delete" | "no-op",
  definition = desired(),
): DeploymentPlan {
  const planned = buildPlan(deployment(definition), {
    mode: "plan",
    environment: "dev",
  });
  planned.virtualNetworkGateways = [
    {
      ...planned.virtualNetworkGateways![0]!,
      action,
      reason: action,
      observedStateHash:
        action === "create" ||
        (action === "no-op" &&
          definition.desiredState === "absent")
          ? hashObservedVirtualNetworkGateway(undefined)
          : hashObservedVirtualNetworkGateway(gateway()),
      ...(action === "create" ? {} : { physicalId: GATEWAY_ID }),
    },
  ];
  return rehashPlan(planned);
}

function adapter(planned: DeploymentPlan) {
  const gatewayPlan = planned.virtualNetworkGateways![0]!;
  return {
    plan: vi.fn(async () => ({
      action: gatewayPlan.action as
        | "create"
        | "update"
        | "delete"
        | "no-op"
        | "blocked",
      reason: gatewayPlan.reason,
      desiredHash: gatewayPlan.desiredHash,
      observedStateHash: gatewayPlan.observedStateHash,
      ...(gatewayPlan.physicalId
        ? { physicalId: gatewayPlan.physicalId }
        : {}),
    })),
    create: vi.fn(
      async (
        _definition: VirtualNetworkGatewayDefinition,
        callbacks: {
          onSubmitting?: () => void;
          onAccepted?: (physicalId: string) => void;
        },
      ) => {
        callbacks.onSubmitting?.();
        callbacks.onAccepted?.(GATEWAY_ID);
        return gateway();
      },
    ),
    resumeCreate: vi.fn(async () => gateway()),
    update: vi.fn(async () => gateway()),
    resumeUpdate: vi.fn(async () => gateway()),
    delete: vi.fn(async () => undefined),
    resumeDelete: vi.fn(async () => undefined),
    verifyPresent: vi.fn(async () => gateway()),
    verifyAbsent: vi.fn(async () => undefined),
  };
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-vnet-gateway-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
  };
}

function options(
  approvedPlan: DeploymentPlan,
  adapterOverride = adapter(approvedPlan),
) {
  const checkpoint = createCheckpoint(approvedPlan);
  return {
    approvedPlan,
    currentPlan: approvedPlan,
    desired: deployment().manifest.virtualNetworkGateways,
    adapter: adapterOverride,
    checkpoint,
    checkpointFile: files().checkpointFile,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
  };
}

describe("virtual network gateway apply", () => {
  it("requires the dedicated create safeguard before mutation", () => {
    const approved = plan("create");
    const applyOptions = {
      ...options(approved),
      allowCreate: false,
    };

    expect(() =>
      preflightVirtualNetworkGateways(applyOptions),
    ).toThrow("allow-vnet-gateway-create is false");
    expect(applyOptions.adapter.create).not.toHaveBeenCalled();
  });

  it("checkpoints and verifies a newly created gateway", async () => {
    const approved = plan("create");
    const applyOptions = options(approved);

    preflightVirtualNetworkGateways(applyOptions);
    const results =
      await applyVirtualNetworkGateways(applyOptions);

    expect(results).toEqual([
      expect.objectContaining({
        logicalId: "managedGateway",
        status: "created",
        physicalId: GATEWAY_ID,
      }),
    ]);
    expect(
      applyOptions.checkpoint.virtualNetworkGateways?.managedGateway,
    ).toMatchObject({
      action: "create",
      phase: "verified",
      physicalId: GATEWAY_ID,
      observedStateHash: hashObservedVirtualNetworkGateway(gateway()),
    });
  });

  it("resumes a checkpointed create without redispatching POST", async () => {
    const approved = plan("create");
    const applyOptions = options(approved);
    applyOptions.checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          hashDesiredVirtualNetworkGateway(desired()),
        action: "create",
        phase: "submitting",
        observedStateHash:
          hashObservedVirtualNetworkGateway(undefined),
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };

    preflightVirtualNetworkGateways(applyOptions);
    await recoverInterruptedVirtualNetworkGateways(
      applyOptions,
    );
    const results =
      await applyVirtualNetworkGateways(applyOptions);

    expect(applyOptions.adapter.resumeCreate).toHaveBeenCalledOnce();
    expect(applyOptions.adapter.create).not.toHaveBeenCalled();
    expect(results?.[0]).toMatchObject({
      status: "resumed",
      physicalId: GATEWAY_ID,
    });
  });

  it("allows early recovery when another gateway is already verified", () => {
    const first = desired();
    const second = desired({
      logicalId: "secondGateway",
      displayName: "Second Gateway",
      virtualNetworkAzureResource: {
        ...desired().virtualNetworkAzureResource,
        subnetName: "second-gateway",
      },
    });
    const loaded = deployment(first);
    loaded.manifest.virtualNetworkGateways = [first, second];
    const planned = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    planned.virtualNetworkGateways =
      planned.virtualNetworkGateways!.map((gatewayPlan) => ({
        ...gatewayPlan,
        action: "create",
        reason: "missing",
      }));
    const approved = rehashPlan(planned);
    const applyOptions = {
      ...options(approved, adapter(approved)),
      desired: [first, second],
    };
    applyOptions.checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          approved.virtualNetworkGateways![0]!.desiredHash,
        action: "create",
        phase: "verified",
        physicalId: GATEWAY_ID,
        observedStateHash:
          hashObservedVirtualNetworkGateway(gateway()),
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
      secondGateway: {
        logicalId: "secondGateway",
        desiredHash:
          approved.virtualNetworkGateways![1]!.desiredHash,
        action: "create",
        phase: "submitting",
        observedStateHash:
          hashObservedVirtualNetworkGateway(undefined),
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };

    expect(() =>
      preflightVirtualNetworkGateways(applyOptions),
    ).not.toThrow();
  });

  it("fails closed when live state changes after approval", async () => {
    const approved = plan("create");
    const applyAdapter = adapter(approved);
    applyAdapter.plan.mockResolvedValueOnce({
      action: "create",
      reason: "create",
      desiredHash:
        approved.virtualNetworkGateways![0]!.desiredHash,
      observedStateHash: "f".repeat(64),
    });
    const applyOptions = options(approved, applyAdapter);

    preflightVirtualNetworkGateways(applyOptions);
    await expect(
      applyVirtualNetworkGateways(applyOptions),
    ).rejects.toThrow("changed after approval");
    expect(applyAdapter.create).not.toHaveBeenCalled();
  });

  it("requires the delete safeguard and preserves exact deletion proof", async () => {
    const absent = desired({
      id: GATEWAY_ID,
      desiredState: "absent",
    });
    const approved = plan("delete", absent);
    const applyOptions = {
      ...options(approved, adapter(approved)),
      desired: [absent],
      allowDelete: false,
    };

    expect(() =>
      preflightVirtualNetworkGateways(applyOptions),
    ).toThrow("allow-vnet-gateway-delete is false");

    applyOptions.allowDelete = true;
    preflightVirtualNetworkGateways(applyOptions);
    expect(
      await applyVirtualNetworkGateways(
        applyOptions,
        "present",
      ),
    ).toBeUndefined();
    expect(applyOptions.adapter.delete).not.toHaveBeenCalled();
    const results =
      await applyVirtualNetworkGateways(
        applyOptions,
        "absent",
      );

    expect(applyOptions.adapter.delete).toHaveBeenCalledWith(
      GATEWAY_ID,
      expect.objectContaining({
        logicalId: "managedGateway",
        id: GATEWAY_ID,
        desiredState: "absent",
        displayName: "Managed Gateway",
      }),
      expect.any(Object),
    );
    expect(results?.[0]).toMatchObject({
      status: "deleted",
      physicalId: GATEWAY_ID,
    });
  });
});
