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
  hashCommunicationPolicy,
  NetworkProtectionAdapter,
  normalizeNetworkProtection,
} from "../src/fabric/network-protection";
import { loadManifest } from "../src/manifest";
import { run } from "../src/main";
import { buildPlan, rehashPlan } from "../src/planner";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

describe("main apply recovery ordering", () => {
  beforeEach(() => {
    actionCore.inputs.clear();
    actionCore.getInput.mockClear();
    actionCore.setFailed.mockClear();
    actionCore.setOutput.mockClear();
    actionCore.setSecret.mockClear();
    enrichPlanWithFabric.mockReset();
    vi.restoreAllMocks();
  });

  it("completes started network recovery before unrelated item loading", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-main-network-recovery-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    const approvedPlanFile = path.join(root, "approved-plan.json");
    const planFile = path.join(root, "current-plan.json");
    const checkpointFile = path.join(root, "checkpoint.json");
    const resultFile = path.join(root, "result.json");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: main-network-recovery
workspace:
  id: ${WORKSPACE_ID}
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
items: []
`,
      "utf8",
    );
    const loaded = loadManifest(manifestPath);
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const desired = normalizeNetworkProtection(
      loaded.manifest.networkProtection!,
    );
    const desiredHash = hashCommunicationPolicy(
      desired.communicationPolicy,
    );
    plan.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        action: "update",
        reason: "differs",
        desiredHash,
        observedStateHash: hashCommunicationPolicy({
          inbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
        }),
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Deny",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
    };
    const approved = rehashPlan(plan);
    writeFileSync(
      approvedPlanFile,
      `${JSON.stringify(approved, null, 2)}\n`,
      "utf8",
    );
    const checkpoint = createCheckpoint(approved);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: main-network-recovery
workspace:
  id: ${WORKSPACE_ID}
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
items:
  - logicalId: missing
    type: Lakehouse
    path: items/does-not-exist
`,
      "utf8",
    );

    const calls: string[] = [];
    vi.spyOn(NetworkProtectionAdapter.prototype, "plan").mockImplementation(
      async () => {
        calls.push("network-plan");
        return {
          workspaceId: WORKSPACE_ID,
          communicationPolicy: {
            action: "no-op",
            reason: "matches",
            desiredHash,
            observedStateHash: desiredHash,
            desiredInboundDefaultAction: "Allow",
            desiredOutboundDefaultAction: "Deny",
            observedInboundDefaultAction: "Allow",
            observedOutboundDefaultAction: "Deny",
            isRelaxation: false,
          },
        };
      },
    );
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "getCommunicationPolicy",
    ).mockImplementation(async () => {
      calls.push("network-get");
      return {
        policy: desired.communicationPolicy,
        etag: undefined,
      };
    });

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
      "allow-network-policy-update": "true",
    })) {
      actionCore.inputs.set(name, value);
    }

    await run();

    expect(calls).toEqual([
      "network-plan",
      "network-plan",
      "network-get",
    ]);
    expect(enrichPlanWithFabric).not.toHaveBeenCalled();
    expect(
      loadCheckpoint(checkpointFile, approved)?.networkProtection,
    ).toMatchObject({
      communicationPolicy: { phase: "verified" },
      completedAt: expect.any(String),
    });
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("directory not found"),
    );
  });
});
