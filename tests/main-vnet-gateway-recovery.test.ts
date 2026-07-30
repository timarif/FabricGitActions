import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const actionCore = vi.hoisted(() => {
  const inputs = new Map<string, string>();
  return {
    inputs,
    getInput: vi.fn((name: string) => inputs.get(name) ?? ""),
    getIDToken: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    setSecret: vi.fn(),
    summary: {
      addHeading: vi.fn().mockReturnThis(),
      addTable: vi.fn().mockReturnThis(),
      addRaw: vi.fn().mockReturnThis(),
      write: vi.fn(),
    },
  };
});
const enrichPlanWithFabric = vi.hoisted(() => vi.fn());

vi.mock("@actions/core", () => actionCore);
vi.mock("../src/fabric/live-planner", () => ({
  enrichPlanWithFabric,
}));

import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import {
  VirtualNetworkGatewayAdapter,
  type VirtualNetworkGateway,
} from "../src/fabric/virtual-network-gateway";
import { loadManifest } from "../src/manifest";
import { run } from "../src/main";
import { buildPlan, rehashPlan } from "../src/planner";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_ID = "22222222-2222-4222-8222-222222222222";

describe("main virtual network gateway recovery ordering", () => {
  beforeEach(() => {
    actionCore.inputs.clear();
    actionCore.getInput.mockClear();
    actionCore.setFailed.mockClear();
    actionCore.setOutput.mockClear();
    actionCore.setSecret.mockClear();
    enrichPlanWithFabric.mockReset();
    vi.restoreAllMocks();
  });

  it("completes a started gateway recovery before unrelated item loading", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-main-vnet-recovery-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    const approvedPlanFile = path.join(root, "approved-plan.json");
    const planFile = path.join(root, "current-plan.json");
    const checkpointFile = path.join(root, "checkpoint.json");
    const resultFile = path.join(root, "result.json");
    const baseManifest = `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: main-vnet-recovery
workspace:
  id: ${WORKSPACE_ID}
virtualNetworkGateways:
  - logicalId: managedGateway
    displayName: Managed Gateway
    capacityId: 33333333-3333-4333-8333-333333333333
    virtualNetworkAzureResource:
      subscriptionId: 44444444-4444-4444-8444-444444444444
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: fabric-gateway
    inactivityMinutesBeforeSleep: 30
    numberOfMemberGateways: 2
items: []
`;
    writeFileSync(manifestPath, baseManifest, "utf8");
    const loaded = loadManifest(manifestPath);
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
    const approved = rehashPlan(plan);
    writeFileSync(
      approvedPlanFile,
      `${JSON.stringify(approved, null, 2)}\n`,
      "utf8",
    );
    const checkpoint = createCheckpoint(approved);
    checkpoint.virtualNetworkGateways = {
      managedGateway: {
        logicalId: "managedGateway",
        desiredHash:
          approved.virtualNetworkGateways![0]!.desiredHash,
        action: "create",
        phase: "submitting",
        observedStateHash:
          approved.virtualNetworkGateways![0]!.observedStateHash,
        updatedAt: "2026-07-22T00:00:00.000Z",
      },
    };
    writeCheckpoint(checkpointFile, checkpoint);
    writeFileSync(
      manifestPath,
      baseManifest.replace(
        "items: []",
        `items:
  - logicalId: missing
    type: Lakehouse
    path: items/does-not-exist`,
      ),
      "utf8",
    );

    const recovered: VirtualNetworkGateway = {
      id: GATEWAY_ID,
      type: "VirtualNetwork",
      displayName: "Managed Gateway",
      capacityId: "33333333-3333-4333-8333-333333333333",
      virtualNetworkAzureResource: {
        subscriptionId:
          "44444444-4444-4444-8444-444444444444",
        resourceGroupName: "fabric-network",
        virtualNetworkName: "fabric-vnet",
        subnetName: "fabric-gateway",
      },
      inactivityMinutesBeforeSleep: 30,
      numberOfMemberGateways: 2,
    };
    const resumeCreate = vi
      .spyOn(
        VirtualNetworkGatewayAdapter.prototype,
        "resumeCreate",
      )
      .mockResolvedValue(recovered);

    for (const [name, value] of Object.entries({
      mode: "apply",
      manifest: manifestPath,
      environment: "dev",
      "auth-mode": "service-principal-secret",
      "tenant-id": "tenant",
      "client-id": "client",
      "client-secret": "secret",
      "approved-plan-file": approvedPlanFile,
      "plan-file": planFile,
      "checkpoint-file": checkpointFile,
      "result-file": resultFile,
      "allow-vnet-gateway-create": "true",
    })) {
      actionCore.inputs.set(name, value);
    }

    await run();

    expect(resumeCreate).toHaveBeenCalledOnce();
    expect(enrichPlanWithFabric).not.toHaveBeenCalled();
    expect(
      loadCheckpoint(checkpointFile, approved)
        ?.virtualNetworkGateways?.managedGateway,
    ).toMatchObject({
      phase: "verified",
      physicalId: GATEWAY_ID,
    });
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("directory not found"),
    );
  });
});
