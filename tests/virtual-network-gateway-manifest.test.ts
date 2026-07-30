import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadManifest,
  loadVirtualNetworkGatewaysManifest,
} from "../src/manifest";
import { buildPlan } from "../src/planner";

function writeManifest(source: string): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-vnet-gateway-manifest-"),
  );
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(manifestPath, source, "utf8");
  return manifestPath;
}

const gatewayYaml = `
virtualNetworkGateways:
  - logicalId: fixedGateway
    displayName: Fixed Gateway
    capacityId: 22222222-2222-4222-8222-222222222222
    virtualNetworkAzureResource:
      subscriptionId: 33333333-3333-4333-8333-333333333333
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: fixed-gateway
    inactivityMinutesBeforeSleep: 30
    numberOfMemberGateways: 2
  - logicalId: rangedGateway
    displayName: Ranged Gateway
    capacityId: 22222222-2222-4222-8222-222222222222
    virtualNetworkAzureResource:
      subscriptionId: 33333333-3333-4333-8333-333333333333
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: ranged-gateway
    inactivityMinutesBeforeSleep: 60
    minMemberGatewayCount: 2
    maxMemberGatewayCount: 4
`;

describe("virtual network gateway manifest", () => {
  it("loads fixed and ranged scaling and builds deterministic plans", () => {
    const loaded = loadManifest(
      writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
${gatewayYaml}
items: []
`),
    );

    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    expect(
      plan.virtualNetworkGateways?.map((gateway) => ({
        logicalId: gateway.logicalId,
        action: gateway.action,
        fixed: gateway.numberOfMemberGateways,
        min: gateway.minMemberGatewayCount,
        max: gateway.maxMemberGatewayCount,
      })),
    ).toEqual([
      {
        logicalId: "fixedGateway",
        action: "unknown",
        fixed: 2,
        min: undefined,
        max: undefined,
      },
      {
        logicalId: "rangedGateway",
        action: "unknown",
        fixed: undefined,
        min: 2,
        max: 4,
      },
    ]);
  });

  it("requires an explicit ID for deletion", () => {
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
virtualNetworkGateways:
  - logicalId: retiredGateway
    desiredState: absent
    displayName: Retired Gateway
    virtualNetworkAzureResource:
      subscriptionId: 33333333-3333-4333-8333-333333333333
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: retired-gateway
items: []
`),
      ),
    ).toThrow("Invalid deployment manifest");
  });

  it("accepts a deletion proof without irrelevant mutable settings", () => {
    const loaded = loadManifest(
      writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
virtualNetworkGateways:
  - logicalId: retiredGateway
    id: 11111111-1111-4111-8111-111111111111
    desiredState: absent
    displayName: Retired Gateway
    virtualNetworkAzureResource:
      subscriptionId: 33333333-3333-4333-8333-333333333333
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: retired-gateway
items: []
`),
    );

    expect(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }).virtualNetworkGateways,
    ).toEqual([
      expect.objectContaining({
        logicalId: "retiredGateway",
        desiredState: "absent",
        physicalId:
          "11111111-1111-4111-8111-111111111111",
      }),
    ]);
  });

  it("rejects mixed scaling modes and invalid ranges", () => {
    const mixed = gatewayYaml.replace(
      "    numberOfMemberGateways: 2",
      "    numberOfMemberGateways: 2\n    minMemberGatewayCount: 1\n    maxMemberGatewayCount: 2",
    );
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
${mixed}
items: []
`),
      ),
    ).toThrow("Invalid deployment manifest");

    const invalidRange = gatewayYaml.replace(
      "    minMemberGatewayCount: 2\n    maxMemberGatewayCount: 4",
      "    minMemberGatewayCount: 5\n    maxMemberGatewayCount: 4",
    );
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
${invalidRange}
items: []
`),
      ),
    ).toThrow("cannot exceed");
  });

  it("rejects deleting a gateway that remains in the desired outbound allow list", () => {
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
virtualNetworkGateways:
  - logicalId: retiredGateway
    id: 11111111-1111-4111-8111-111111111111
    desiredState: absent
    displayName: Retired Gateway
    virtualNetworkAzureResource:
      subscriptionId: 33333333-3333-4333-8333-333333333333
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: retired-gateway
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  outboundGatewayRules:
    defaultAction: Deny
    allowedGateways:
      - id: 11111111-1111-4111-8111-111111111111
items: []
`),
      ),
    ).toThrow("cannot be absent");
  });

  it("loads gateway declarations for recovery without traversing item paths", () => {
    const manifestPath = writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: vnet-gateways
workspace:
  id: workspace-1
${gatewayYaml}
items:
  - logicalId: missingItem
    type: Lakehouse
    path: items/does-not-exist
`);

    expect(
      loadVirtualNetworkGatewaysManifest(manifestPath),
    ).toHaveLength(2);
    expect(() => loadManifest(manifestPath)).toThrow(
      "directory not found",
    );
  });
});
