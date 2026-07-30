import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";

function gatewayPlan() {
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
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  plan.virtualNetworkGateways = [
    {
      ...plan.virtualNetworkGateways![0]!,
      action: "create",
      reason: "missing",
    },
  ];
  return rehashPlan(plan);
}

function checkpointFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "fabric-vnet-checkpoint-")),
    "checkpoint.json",
  );
}

describe("virtual network gateway checkpoint", () => {
  it("round-trips an accepted create bound to the approved desired hash", () => {
    const plan = gatewayPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          plan.virtualNetworkGateways![0]!.desiredHash,
        action: "create",
        phase: "accepted",
        physicalId: GATEWAY_ID,
        observedStateHash: "a".repeat(64),
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };
    const file = checkpointFile();

    writeCheckpoint(file, checkpoint);

    expect(
      loadCheckpoint(file, plan)?.virtualNetworkGateways,
    ).toEqual(checkpoint.virtualNetworkGateways);
  });

  it("rejects gateway state that is not bound to the approved action", () => {
    const plan = gatewayPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          plan.virtualNetworkGateways![0]!.desiredHash,
        action: "update",
        phase: "accepted",
        physicalId: GATEWAY_ID,
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };
    const file = checkpointFile();
    writeCheckpoint(file, checkpoint);

    expect(() => loadCheckpoint(file, plan)).toThrow(
      "does not match the approved deployment plan",
    );
  });

  it("rejects an accepted create without a physical ID", () => {
    const plan = gatewayPlan();
    const checkpoint = createCheckpoint(plan);
    checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          plan.virtualNetworkGateways![0]!.desiredHash,
        action: "create",
        phase: "accepted",
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };
    const file = checkpointFile();
    writeCheckpoint(file, checkpoint);

    expect(() => loadCheckpoint(file, plan)).toThrow(
      "invalid structure",
    );
  });
});
