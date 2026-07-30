import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadApprovedPlan } from "../src/plan-artifact";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

function plan() {
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
  const result = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  result.virtualNetworkGateways = [
    {
      ...result.virtualNetworkGateways![0]!,
      action: "create",
      reason: "missing",
    },
  ];
  return rehashPlan(result);
}

function planFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "fabric-vnet-plan-")),
    "plan.json",
  );
}

describe("virtual network gateway approved plan", () => {
  it("loads a structurally valid gateway plan", () => {
    const approved = plan();
    const file = planFile();
    writeFileSync(file, JSON.stringify(approved), "utf8");

    expect(
      loadApprovedPlan(file).virtualNetworkGateways,
    ).toEqual(approved.virtualNetworkGateways);
  });

  it("rejects a delete plan without an exact physical ID", () => {
    const approved = plan();
    approved.virtualNetworkGateways![0] = {
      ...approved.virtualNetworkGateways![0]!,
      desiredState: "absent",
      action: "delete",
    };
    delete approved.virtualNetworkGateways![0]!.capacityId;
    delete approved.virtualNetworkGateways![0]!
      .inactivityMinutesBeforeSleep;
    delete approved.virtualNetworkGateways![0]!
      .numberOfMemberGateways;
    delete approved.virtualNetworkGateways![0]!.physicalId;
    const file = planFile();
    writeFileSync(
      file,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );

    expect(() => loadApprovedPlan(file)).toThrow(
      "invalid structure",
    );
  });

  it("rejects a plan that combines fixed and ranged scaling", () => {
    const approved = plan();
    approved.virtualNetworkGateways![0]!.minMemberGatewayCount = 1;
    approved.virtualNetworkGateways![0]!.maxMemberGatewayCount = 2;
    const file = planFile();
    writeFileSync(
      file,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );

    expect(() => loadApprovedPlan(file)).toThrow(
      "invalid structure",
    );
  });
});
