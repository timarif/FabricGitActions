import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCheckpoint, loadCheckpoint, writeCheckpoint } from "../src/checkpoint";
import { FabricApiError } from "../src/fabric/client";
import {
  hashCommunicationPolicy,
  hashOutboundCloudConnectionRules,
  hashOutboundGatewayRules,
  normalizeNetworkProtection,
  OAP_NOT_ENABLED_SENTINEL_HASH,
} from "../src/fabric/network-protection";
import {
  applyNetworkProtection,
  preflightNetworkProtection,
  recoverInterruptedNetworkProtection,
  type ApplyNetworkProtectionOptions,
} from "../src/network-apply";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  ApplyCheckpoint,
  DeploymentPlan,
  LoadedManifest,
  NetworkProtectionManifest,
  PlannedNetworkProtection,
} from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";

const TIGHTENING_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Deny",
  },
  outboundCloudConnectionRules: {
    defaultAction: "Deny",
    rules: [{ connectionType: "Web", defaultAction: "Allow" }],
  },
  outboundGatewayRules: {
    defaultAction: "Deny",
    allowedGateways: [{ id: GATEWAY_ID }],
  },
};

const ALLOW_DESIRED: NetworkProtectionManifest = {
  communicationPolicy: {
    inboundDefaultAction: "Allow",
    outboundDefaultAction: "Allow",
  },
};

function canonicalOf(desired: NetworkProtectionManifest) {
  return normalizeNetworkProtection(desired);
}

/** Builds an approved DeploymentPlan carrying a fully authenticated networkProtection block. */
function buildApprovedPlan(options: {
  desired: NetworkProtectionManifest;
  observedInbound: "Allow" | "Deny";
  observedOutbound: "Allow" | "Deny";
  policyAction: "update" | "no-op";
  ruleAction?: "update" | "no-op";
  ruleObservedIsSentinel?: boolean;
}): DeploymentPlan {
  const canonical = canonicalOf(options.desired);
  const desiredPolicyHash = hashCommunicationPolicy(canonical.communicationPolicy);
  const observedPolicyHash = hashCommunicationPolicy({
    inbound: { publicAccessRules: { defaultAction: options.observedInbound } },
    outbound: { publicAccessRules: { defaultAction: options.observedOutbound } },
  });

  const networkProtection: PlannedNetworkProtection = {
    workspaceId: WORKSPACE_ID,
    communicationPolicy: {
      action: options.policyAction,
      reason: options.policyAction === "no-op" ? "matches" : "differs",
      desiredHash: desiredPolicyHash,
      observedStateHash: options.policyAction === "no-op" ? desiredPolicyHash : observedPolicyHash,
      desiredInboundDefaultAction:
        canonical.communicationPolicy.inbound.publicAccessRules.defaultAction,
      desiredOutboundDefaultAction:
        canonical.communicationPolicy.outbound.publicAccessRules.defaultAction,
      observedInboundDefaultAction: options.observedInbound,
      observedOutboundDefaultAction: options.observedOutbound,
      isRelaxation:
        (options.observedInbound === "Deny" &&
          canonical.communicationPolicy.inbound.publicAccessRules.defaultAction === "Allow") ||
        (options.observedOutbound === "Deny" &&
          canonical.communicationPolicy.outbound.publicAccessRules.defaultAction === "Allow"),
    },
  };

  if (canonical.outboundCloudConnectionRules) {
    const desiredHash = hashOutboundCloudConnectionRules(canonical.outboundCloudConnectionRules);
    networkProtection.outboundCloudConnectionRules = {
      action: options.ruleAction ?? "update",
      reason: "rules",
      desiredHash,
      observedStateHash: options.ruleObservedIsSentinel
        ? OAP_NOT_ENABLED_SENTINEL_HASH
        : desiredHash,
    };
  }
  if (canonical.outboundGatewayRules) {
    const desiredHash = hashOutboundGatewayRules(canonical.outboundGatewayRules);
    networkProtection.outboundGatewayRules = {
      action: options.ruleAction ?? "update",
      reason: "rules",
      desiredHash,
      observedStateHash: options.ruleObservedIsSentinel
        ? OAP_NOT_ENABLED_SENTINEL_HASH
        : desiredHash,
    };
  }

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
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "network-protection-apply" },
      workspace: { id: WORKSPACE_ID },
      networkProtection: options.desired,
      items: [],
    },
  };
  const plan = buildPlan(loaded, { mode: "plan", environment: "dev" });
  plan.networkProtection = networkProtection;
  return rehashPlan(plan);
}

function checkpointFilePath(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-network-apply-"));
  return path.join(root, "checkpoint.json");
}

function mockAdapter() {
  return {
    plan: vi.fn(),
    getCommunicationPolicy: vi.fn(),
    putCommunicationPolicy: vi.fn(),
    getOutboundCloudConnectionRules: vi.fn(),
    putOutboundCloudConnectionRules: vi.fn(),
    getOutboundGatewayRules: vi.fn(),
    putOutboundGatewayRules: vi.fn(),
  };
}

function baseOptions(
  plan: DeploymentPlan,
  adapter: ReturnType<typeof mockAdapter>,
  checkpointFile: string,
  overrides: Partial<ApplyNetworkProtectionOptions> = {},
): ApplyNetworkProtectionOptions {
  const checkpoint = overrides.checkpoint ?? createCheckpoint(plan);
  return {
    approvedPlan: plan,
    currentPlan: plan,
    desired: plan.networkProtection ? TIGHTENING_DESIRED : undefined,
    adapter,
    checkpoint,
    checkpointFile,
    allowNetworkPolicyUpdate: false,
    allowNetworkPolicyRelaxation: false,
    allowOutboundCloudConnectionRuleUpdate: false,
    allowOutboundGatewayRuleUpdate: false,
    ...overrides,
  };
}

describe("preflightNetworkProtection", () => {
  it("throws when a configured surface action is blocked", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    plan.networkProtection!.communicationPolicy.action = "blocked";

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("blocked");
  });

  it("requires allow-network-policy-update for a policy update", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-network-policy-update is false");
  });

  it("additionally requires allow-network-policy-relaxation for a relaxation", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-network-policy-relaxation is false");
  });

  it("requires the two outbound rule safeguards independently", () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("allow-outbound-cloud-connection-rule-update is false");

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint: createCheckpoint(plan),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).toThrow("allow-outbound-gateway-rule-update is false");
  });

  it("skips re-authorization once a surface is checkpointed verified", () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint,
        allowNetworkPolicyUpdate: false,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: false,
        allowOutboundGatewayRuleUpdate: false,
      }),
    ).not.toThrow();
  });

  it("throws when the current plan has drifted from the approved plan", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const current = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("drifted after approval");
  });

  it("rejects a current plan targeting a different network workspace", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const current = structuredClone(approved);
    current.networkProtection!.workspaceId = OTHER_WORKSPACE_ID;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: current,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("does not match the approved target");
  });

  it("rejects inconsistent approved relaxation metadata", () => {
    const approved = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    approved.networkProtection!.communicationPolicy.isRelaxation = false;

    expect(() =>
      preflightNetworkProtection({
        approvedPlan: approved,
        currentPlan: approved,
        checkpoint: createCheckpoint(approved),
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: false,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    ).toThrow("transition metadata is inconsistent");
  });
});

describe("applyNetworkProtection ordering", () => {
  it("tightens Allow -> Deny by PUTting the policy before any outbound rule", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });

    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(async () => {
      calls.push("put-policy");
      return { policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy, etag: undefined };
    });
    adapter.getCommunicationPolicy.mockImplementation(async () => ({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    }));
    adapter.putOutboundCloudConnectionRules.mockImplementation(async () => {
      calls.push("put-connections");
      return canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!;
    });
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockImplementation(async () => {
      calls.push("put-gateways");
      return canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!;
    });
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        allowNetworkPolicyUpdate: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls[0]).toBe("put-policy");
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining(["put-connections", "put-gateways"]),
    );
    expect(result?.communicationPolicy.status).toBe("updated");
    expect(result?.outboundCloudConnectionRules?.status).toBe("updated");
    expect(result?.outboundGatewayRules?.status).toBe("updated");
  });

  it("uses the freshly observed policy ETag instead of the approval-time ETag", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    plan.networkProtection!.communicationPolicy.etag = "approval-etag";
    const fresh = {
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        etag: "fresh-etag",
      },
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(fresh);
    adapter.putCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "updated-etag",
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "updated-etag",
    });

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.putCommunicationPolicy).toHaveBeenCalledWith(
      WORKSPACE_ID,
      canonicalOf(ALLOW_DESIRED).communicationPolicy,
      expect.objectContaining({ ifMatchEtag: "fresh-etag" }),
    );
  });

  it("rejects a fresh plan targeting a different network workspace", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      workspaceId: OTHER_WORKSPACE_ID,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: ALLOW_DESIRED,
        }),
      ),
    ).rejects.toThrow("does not match the approved target");
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("relaxes by applying configured outbound rules before the policy PUT", async () => {
    // Outbound stays Deny (unchanged) while only inbound is being forced back
    // to Allow from an out-of-band Deny; this is a relaxation without an
    // outbound default-action transition, so it takes the "apply rules
    // first" branch even though the master switch itself is being touched.
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Deny",
      observedOutbound: "Deny",
      policyAction: "update",
      ruleAction: "update",
    });
    const adapter = mockAdapter();
    const calls: string[] = [];
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(async () => {
      calls.push("put-policy");
      return { policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy, etag: undefined };
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockImplementation(async () => {
      calls.push("put-connections");
      return canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!;
    });
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockImplementation(async () => {
      calls.push("put-gateways");
      return canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!;
    });
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(calls.indexOf("put-policy")).toBe(calls.length - 1);
    expect(calls.indexOf("put-connections")).toBeLessThan(calls.indexOf("put-policy"));
    expect(calls.indexOf("put-gateways")).toBeLessThan(calls.indexOf("put-policy"));
  });

  it("only verifies (never PUTs) a no-op surface", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "no-op",
    });
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), { desired: ALLOW_DESIRED }),
    );

    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(result?.communicationPolicy.status).toBe("verified");
  });

  it("writes a submitting checkpoint before the PUT resolves", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    let checkpointDuringDispatch: ApplyCheckpoint | undefined;
    adapter.putCommunicationPolicy.mockImplementation(
      async (_workspaceId: string, _body: unknown, opts?: { onDispatch?: () => void }) => {
        opts?.onDispatch?.();
        checkpointDuringDispatch = loadCheckpoint(checkpointFile, plan);
        return { policy: canonicalOf(ALLOW_DESIRED).communicationPolicy, etag: undefined };
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(checkpointDuringDispatch?.networkProtection?.communicationPolicy?.phase).toBe(
      "submitting",
    );
  });

  it("clears a definitively rejected surface so a later run can retry", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const checkpoint = createCheckpoint(plan);
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError("throttled", 429, "TooManyRequests");
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
      }).communicationPolicy,
      etag: undefined,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toMatchObject({ status: 429 });

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy,
    ).toBeUndefined();
  });

  it("retains submitting state when a final 4xx followed an ambiguous attempt", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError(
          "throttled after ambiguous failure",
          429,
          "TooManyRequests",
          undefined,
          true,
        );
      },
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toMatchObject({
      status: 429,
      priorAttemptAmbiguous: true,
    });

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("submitting");
    expect(adapter.getCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("accepts read-back success after a definitive retry rejection", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new FabricApiError(
          "precondition failed",
          412,
          "PreconditionFailed",
        );
      },
    );
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: "new-etag",
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        desired: ALLOW_DESIRED,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(result?.communicationPolicy.status).toBe("updated");
    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("verified");
  });

  it("preserves submitting state for an ambiguous transport failure", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpointFile = checkpointFilePath();
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.putCommunicationPolicy.mockImplementation(
      async (
        _workspaceId: string,
        _body: unknown,
        options?: { onDispatch?: () => void },
      ) => {
        options?.onDispatch?.();
        throw new Error("connection reset");
      },
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          desired: ALLOW_DESIRED,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toThrow("connection reset");

    expect(
      loadCheckpoint(checkpointFile, plan)?.networkProtection
        ?.communicationPolicy?.phase,
    ).toBe("submitting");
  });

  it("fails closed when a submitting checkpoint cannot be confirmed live", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    // The live policy still shows the pre-mutation Deny state: the earlier
    // PUT's outcome is unresolved.
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
      }).communicationPolicy,
      etag: undefined,
    });

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          desired: ALLOW_DESIRED,
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowNetworkPolicyRelaxation: true,
        }),
      ),
    ).rejects.toThrow("ambiguous");
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("resumes a submitting checkpoint once confirmed live, without re-dispatching", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue(plan.networkProtection);
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    const result = await applyNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(result?.communicationPolicy.status).toBe("resumed");
  });
});

describe("recoverInterruptedNetworkProtection", () => {
  it("does nothing when no surface is mid-mutation", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const adapter = mockAdapter();

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), { desired: ALLOW_DESIRED }),
    );

    expect(adapter.plan).not.toHaveBeenCalled();
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("does not let a stale completed marker suppress submitting recovery", async () => {
    const plan = buildApprovedPlan({
      desired: ALLOW_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Deny",
      policyAction: "update",
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      completedAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(ALLOW_DESIRED).communicationPolicy,
      etag: undefined,
    });

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFilePath(), {
        desired: ALLOW_DESIRED,
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
      }),
    );

    expect(adapter.plan).toHaveBeenCalledTimes(2);
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(checkpoint.networkProtection.communicationPolicy?.phase).toBe(
      "verified",
    );
  });

  it("completes all remaining surfaces once a tightening mutation has started", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "submitting",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: "a".repeat(64),
      },
      outboundGatewayRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: "b".repeat(64),
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    const checkpointFile = checkpointFilePath();

    await recoverInterruptedNetworkProtection(
      baseOptions(plan, adapter, checkpointFile, {
        checkpoint,
        allowNetworkPolicyUpdate: true,
        allowOutboundCloudConnectionRuleUpdate: true,
        allowOutboundGatewayRuleUpdate: true,
      }),
    );

    expect(adapter.plan).toHaveBeenCalledTimes(2);
    expect(adapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(adapter.putOutboundCloudConnectionRules).toHaveBeenCalledOnce();
    expect(adapter.putOutboundGatewayRules).toHaveBeenCalledOnce();
    const persisted = loadCheckpoint(checkpointFile, plan);
    expect(persisted?.networkProtection?.communicationPolicy?.phase).toBe("verified");
    expect(
      persisted?.networkProtection?.outboundCloudConnectionRules?.phase,
    ).toBe("verified");
    expect(
      persisted?.networkProtection?.outboundGatewayRules?.phase,
    ).toBe("verified");
    expect(persisted?.networkProtection?.completedAt).toBeDefined();
  });

  it("preflights every remaining surface before recovery dispatches any PUT", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    const adapter = mockAdapter();
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection!,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: "a".repeat(64),
      },
      outboundGatewayRules: {
        action: "update",
        reason: "differs",
        desiredHash:
          plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: "b".repeat(64),
      },
    });

    await expect(
      recoverInterruptedNetworkProtection(
        baseOptions(plan, adapter, checkpointFilePath(), {
          checkpoint,
          allowNetworkPolicyUpdate: true,
          allowOutboundCloudConnectionRuleUpdate: true,
          allowOutboundGatewayRuleUpdate: false,
        }),
      ),
    ).rejects.toThrow(
      "allow-outbound-gateway-rule-update is false",
    );

    expect(
      adapter.putOutboundCloudConnectionRules,
    ).not.toHaveBeenCalled();
    expect(adapter.putOutboundGatewayRules).not.toHaveBeenCalled();
  });

  it("does not falsely flag drift for a rule surface once OAP was enabled by an earlier recovery pass", async () => {
    const plan = buildApprovedPlan({
      desired: TIGHTENING_DESIRED,
      observedInbound: "Allow",
      observedOutbound: "Allow",
      policyAction: "update",
      ruleAction: "update",
      ruleObservedIsSentinel: true,
    });
    const checkpointFile = checkpointFilePath();
    const checkpoint = createCheckpoint(plan);
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        desiredHash: plan.networkProtection!.communicationPolicy.desiredHash,
        phase: "verified",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
      updatedAt: "2026-07-17T00:00:00.000Z",
    };
    writeCheckpoint(checkpointFile, checkpoint);
    const adapter = mockAdapter();
    // A fresh live plan now sees OAP already enabled (Deny), so the outbound
    // rule surfaces compute a real (non-sentinel) observed hash that differs
    // from the approved plan's pre-tightening sentinel snapshot.
    adapter.plan.mockResolvedValue({
      ...plan.networkProtection,
      communicationPolicy: {
        ...plan.networkProtection!.communicationPolicy,
        action: "no-op",
        reason: "matches",
        observedStateHash:
          plan.networkProtection!.communicationPolicy.desiredHash,
        observedOutboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        action: "no-op",
        reason: "matches",
        desiredHash: plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
        observedStateHash: plan.networkProtection!.outboundCloudConnectionRules!.desiredHash,
      },
      outboundGatewayRules: {
        action: "no-op",
        reason: "matches",
        desiredHash: plan.networkProtection!.outboundGatewayRules!.desiredHash,
        observedStateHash: plan.networkProtection!.outboundGatewayRules!.desiredHash,
      },
    });
    adapter.getCommunicationPolicy.mockResolvedValue({
      policy: canonicalOf(TIGHTENING_DESIRED).communicationPolicy,
      etag: undefined,
    });
    adapter.putOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.getOutboundCloudConnectionRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundCloudConnectionRules!,
    );
    adapter.putOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );
    adapter.getOutboundGatewayRules.mockResolvedValue(
      canonicalOf(TIGHTENING_DESIRED).outboundGatewayRules!,
    );

    await expect(
      applyNetworkProtection(
        baseOptions(plan, adapter, checkpointFile, {
          checkpoint: loadCheckpoint(checkpointFile, plan) ?? checkpoint,
          allowNetworkPolicyUpdate: true,
          allowOutboundCloudConnectionRuleUpdate: true,
          allowOutboundGatewayRuleUpdate: true,
        }),
      ),
    ).resolves.toMatchObject({
      communicationPolicy: { status: "resumed" },
      outboundCloudConnectionRules: { status: "updated" },
      outboundGatewayRules: { status: "updated" },
    });
  });
});
