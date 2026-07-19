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
  hashInboundAzureResourceRules,
  hashInboundFirewallRules,
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

  it("recovers a started inbound firewall unit before unrelated item loading", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-main-firewall-recovery-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    const approvedPlanFile = path.join(root, "approved-plan.json");
    const planFile = path.join(root, "current-plan.json");
    const checkpointFile = path.join(root, "checkpoint.json");
    const resultFile = path.join(root, "result.json");
    const manifest = `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: main-firewall-recovery
workspace:
  id: ${WORKSPACE_ID}
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Deny
    outboundDefaultAction: Allow
  inboundFirewallRules:
    rules:
      - displayName: corporate
        value: 12.34.56.78
items: []
`;
    writeFileSync(manifestPath, manifest, "utf8");
    const loaded = loadManifest(manifestPath);
    const desired = normalizeNetworkProtection(
      loaded.manifest.networkProtection!,
    );
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const desiredPolicyHash = hashCommunicationPolicy(
      desired.communicationPolicy,
    );
    const desiredFirewallHash = hashInboundFirewallRules(
      desired.inboundFirewallRules!,
    );
    plan.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        action: "update",
        reason: "differs",
        desiredHash: desiredPolicyHash,
        observedStateHash: hashCommunicationPolicy({
          inbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
        }),
        desiredInboundDefaultAction: "Deny",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundFirewallRules: {
        action: "update",
        reason: "differs",
        desiredHash: desiredFirewallHash,
        observedStateHash: hashInboundFirewallRules({ rules: [] }),
        etag: "approval-etag",
        ruleCount: 1,
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
      inboundFirewallRules: {
        desiredHash: desiredFirewallHash,
        phase: "submitting",
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    writeFileSync(
      manifestPath,
      manifest.replace(
        "items: []",
        `items:
  - logicalId: missing
    type: Lakehouse
    path: items/does-not-exist`,
      ),
      "utf8",
    );

    const calls: string[] = [];
    const freshNetworkPlan = {
      ...approved.networkProtection!,
      communicationPolicy: {
        ...approved.networkProtection!.communicationPolicy,
        etag: "policy-etag",
      },
      inboundFirewallRules: {
        ...approved.networkProtection!.inboundFirewallRules!,
        action: "no-op" as const,
        reason: "matches",
        observedStateHash: desiredFirewallHash,
        etag: "fresh-firewall-etag",
      },
    };
    vi.spyOn(NetworkProtectionAdapter.prototype, "plan").mockImplementation(
      async () => {
        calls.push("network-plan");
        return freshNetworkPlan;
      },
    );
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "getInboundFirewallRules",
    ).mockImplementation(async () => {
      calls.push("firewall-get");
      return {
        configuration: desired.inboundFirewallRules!,
        etag: "fresh-firewall-etag",
      };
    });
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "putInboundFirewallRules",
    ).mockImplementation(async () => {
      calls.push("firewall-put");
      return {
        configuration: desired.inboundFirewallRules!,
        etag: "updated-firewall-etag",
      };
    });
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "putCommunicationPolicy",
    ).mockImplementation(async (_id, _body, options) => {
      options?.onDispatch?.();
      calls.push("policy-put");
      return {
        policy: desired.communicationPolicy,
        etag: "updated-policy-etag",
      };
    });
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "getCommunicationPolicy",
    ).mockImplementation(async () => {
      calls.push("policy-get");
      return {
        policy: desired.communicationPolicy,
        etag: "updated-policy-etag",
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
      "allow-inbound-firewall-update": "true",
      "acknowledge-firewall-lockout-risk": "true",
    })) {
      actionCore.inputs.set(name, value);
    }

    await run();

    expect(calls).toEqual([
      "network-plan",
      "network-plan",
      "firewall-get",
      "policy-put",
      "policy-get",
    ]);
    expect(calls).not.toContain("firewall-put");
    expect(enrichPlanWithFabric).not.toHaveBeenCalled();
    expect(
      loadCheckpoint(checkpointFile, approved)?.networkProtection,
    ).toMatchObject({
      inboundFirewallRules: { phase: "verified" },
      communicationPolicy: { phase: "verified" },
      completedAt: expect.any(String),
    });
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("directory not found"),
    );
  });

  it("recovers a started inbound Azure resource rule unit before unrelated item loading", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-main-azure-resource-recovery-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    const approvedPlanFile = path.join(root, "approved-plan.json");
    const planFile = path.join(root, "current-plan.json");
    const checkpointFile = path.join(root, "checkpoint.json");
    const resultFile = path.join(root, "result.json");
    const resourceId =
      "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Sql/servers/sqlserver";
    const manifest = `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: main-azure-resource-recovery
workspace:
  id: ${WORKSPACE_ID}
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  inboundAzureResourceRules:
    rules:
      - displayName: sql-server
        resourceId: ${resourceId}
items: []
`;
    writeFileSync(manifestPath, manifest, "utf8");
    const loaded = loadManifest(manifestPath);
    const desired = normalizeNetworkProtection(
      loaded.manifest.networkProtection!,
    );
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const desiredPolicyHash = hashCommunicationPolicy(
      desired.communicationPolicy,
    );
    const desiredAzureResourceHash = hashInboundAzureResourceRules(
      desired.inboundAzureResourceRules!,
    );
    plan.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: desiredPolicyHash,
        observedStateHash: desiredPolicyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundAzureResourceRules: {
        action: "update",
        reason: "differs",
        desiredHash: desiredAzureResourceHash,
        observedStateHash: hashInboundAzureResourceRules({ rules: [] }),
        etag: "approval-etag",
        ruleCount: 1,
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
      inboundAzureResourceRules: {
        desiredHash: desiredAzureResourceHash,
        phase: "submitting",
        updatedAt: "2026-07-19T00:00:00.000Z",
      },
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    writeFileSync(
      manifestPath,
      manifest.replace(
        "items: []",
        `items:
  - logicalId: missing
    type: Lakehouse
    path: items/does-not-exist`,
      ),
      "utf8",
    );

    const calls: string[] = [];
    const freshNetworkPlan = {
      ...approved.networkProtection!,
      communicationPolicy: {
        ...approved.networkProtection!.communicationPolicy,
        etag: "policy-etag",
      },
    };
    vi.spyOn(NetworkProtectionAdapter.prototype, "plan").mockImplementation(
      async () => {
        calls.push("network-plan");
        return freshNetworkPlan;
      },
    );
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "getInboundAzureResourceRules",
    ).mockImplementation(async () => {
      calls.push("azure-resource-get");
      return {
        configuration: desired.inboundAzureResourceRules!,
        etag: "approval-etag",
      };
    });
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "putInboundAzureResourceRules",
    ).mockImplementation(async () => {
      calls.push("azure-resource-put");
      return {
        configuration: desired.inboundAzureResourceRules!,
        etag: "updated-azure-resource-etag",
      };
    });
    vi.spyOn(
      NetworkProtectionAdapter.prototype,
      "getCommunicationPolicy",
    ).mockImplementation(async () => {
      calls.push("policy-get");
      return {
        policy: desired.communicationPolicy,
        etag: "policy-etag",
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
      "allow-inbound-azure-resource-rule-update": "true",
    })) {
      actionCore.inputs.set(name, value);
    }

    await run();

    expect(calls).toEqual([
      "network-plan",
      "network-plan",
      "azure-resource-get",
      "policy-get",
    ]);
    expect(calls).not.toContain("azure-resource-put");
    expect(enrichPlanWithFabric).not.toHaveBeenCalled();
    expect(
      loadCheckpoint(checkpointFile, approved)?.networkProtection,
    ).toMatchObject({
      inboundAzureResourceRules: { phase: "verified" },
      communicationPolicy: { phase: "verified" },
      completedAt: expect.any(String),
    });
    expect(actionCore.setFailed).toHaveBeenCalledWith(
      expect.stringContaining("directory not found"),
    );
  });
});
