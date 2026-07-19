import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createCheckpoint } from "../src/checkpoint";
import { FabricApiError } from "../src/fabric/client";
import {
  hashCommunicationPolicy,
  normalizeNetworkProtection,
} from "../src/fabric/network-protection";
import {
  managedPrivateEndpointCheckpointKey,
  normalizeManagedPrivateEndpoints,
  planManagedPrivateEndpoints,
  type LiveManagedPrivateEndpoint,
} from "../src/fabric/managed-private-endpoints";
import {
  applyManagedPrivateEndpoints,
  preflightManagedPrivateEndpoints,
  recoverInterruptedManagedPrivateEndpoints,
} from "../src/managed-private-endpoint-apply";
import { rehashPlan } from "../src/planner";
import type {
  ApplyCheckpoint,
  DeploymentPlan,
  NetworkProtectionManifest,
  PlannedManagedPrivateEndpoint,
} from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_ID = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";
const STORAGE_CHECKPOINT_KEY =
  managedPrivateEndpointCheckpointKey("storage-blob");
const ALPHA_CHECKPOINT_KEY =
  managedPrivateEndpointCheckpointKey("alpha");
const ZETA_CHECKPOINT_KEY =
  managedPrivateEndpointCheckpointKey("zeta");

function liveEndpoint(
  overrides: Partial<LiveManagedPrivateEndpoint> = {},
): LiveManagedPrivateEndpoint {
  return {
    id: ENDPOINT_ID,
    name: "storage-blob",
    targetPrivateLinkResourceId: TARGET_ID.toLowerCase(),
    targetSubresourceType: "blob",
    provisioningState: "Succeeded",
    connectionStatus: "Approved",
    ...overrides,
  };
}

function manifest(
  endpoints: NetworkProtectionManifest["managedPrivateEndpoints"],
): NetworkProtectionManifest {
  return {
    communicationPolicy: {
      inboundDefaultAction: "Allow",
      outboundDefaultAction: "Allow",
    },
    managedPrivateEndpoints: endpoints,
  };
}

function planFor(
  desired: NetworkProtectionManifest,
  live: LiveManagedPrivateEndpoint[],
): DeploymentPlan {
  const canonical = normalizeNetworkProtection(desired);
  const policyHash = hashCommunicationPolicy(
    canonical.communicationPolicy,
  );
  const endpoints = planManagedPrivateEndpoints(
    canonical.managedPrivateEndpoints ?? [],
    live,
  );
  return rehashPlan({
    schemaVersion: "1",
    mode: "plan",
    deploymentId: "mpe-apply",
    environment: "dev",
    workspaceId: WORKSPACE_ID,
    networkProtection: {
      workspaceId: WORKSPACE_ID,
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: policyHash,
        observedStateHash: policyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      managedPrivateEndpoints: endpoints,
    },
    sourceHash: "source",
    resolvedHash: "resolved",
    planHash: "",
    generatedAt: "2026-07-18T00:00:00.000Z",
    stages: [],
    items: [],
  });
}

function checkpointFile(): string {
  return path.join(
    mkdtempSync(path.join(tmpdir(), "fabric-mpe-checkpoint-")),
    "checkpoint.json",
  );
}

function options(
  plan: DeploymentPlan,
  desired: NetworkProtectionManifest,
  checkpoint: ApplyCheckpoint,
  file: string,
  adapter: Record<string, unknown>,
  overrides: Partial<{
    allowManagedPrivateEndpointCreate: boolean;
    allowManagedPrivateEndpointDelete: boolean;
    now: () => number;
  }> = {},
) {
  return {
    approvedPlan: plan,
    currentPlan: plan,
    desired,
    adapter: adapter as never,
    checkpoint,
    checkpointFile: file,
    allowManagedPrivateEndpointCreate: true,
    allowManagedPrivateEndpointDelete: true,
    ...overrides,
  };
}

describe("managed private endpoint preflight", () => {
  it("requires create and delete safeguards independently", () => {
    const desired = manifest([
      {
        name: "create-me",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: "Approve",
      },
      {
        name: "storage-blob",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
      },
    ]);
    const plan = planFor(desired, [liveEndpoint()]);
    const checkpoint = createCheckpoint(plan);

    expect(() =>
      preflightManagedPrivateEndpoints({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint,
        allowManagedPrivateEndpointCreate: false,
        allowManagedPrivateEndpointDelete: true,
      }),
    ).toThrow("allow-managed-private-endpoint-create is false");
    expect(() =>
      preflightManagedPrivateEndpoints({
        approvedPlan: plan,
        currentPlan: plan,
        checkpoint,
        allowManagedPrivateEndpointCreate: true,
        allowManagedPrivateEndpointDelete: false,
      }),
    ).toThrow("allow-managed-private-endpoint-delete is false");
  });
});

describe("managed private endpoint create and recovery", () => {
  it("checkpoints before POST and reports Succeeded+Pending as approval required", async () => {
    const desired = manifest([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve this endpoint",
      },
    ]);
    const plan = planFor(desired, []);
    const checkpoint = createCheckpoint(plan);
    const file = checkpointFile();
    const created = liveEndpoint({
      provisioningState: "Provisioning",
      connectionStatus: undefined,
    });
    const adapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _endpoint: unknown,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          expect(
            JSON.parse(readFileSync(file, "utf8")).networkProtection
              .managedPrivateEndpoints[STORAGE_CHECKPOINT_KEY]
              .phase,
          ).toBe("create-submitting");
          return created;
        },
      ),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: liveEndpoint({ connectionStatus: "Pending" }),
        approvalRequired: true,
      })),
    };

    const result = await applyManagedPrivateEndpoints(
      options(plan, desired, checkpoint, file, adapter),
      "present",
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: "storage-blob",
        status: "created",
        provisioningState: "Succeeded",
        connectionStatus: "Pending",
        approvalRequired: true,
      }),
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain(
      "Approve this endpoint",
    );
    expect(
      checkpoint.networkProtection?.managedPrivateEndpoints?.[
        STORAGE_CHECKPOINT_KEY
      ]?.phase,
    ).toBe("present-verified");
  });

  it("adopts exactly one exact live match after an ambiguous POST and never resubmits", async () => {
    const desired = manifest([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve",
      },
    ]);
    const plan = planFor(desired, []);
    const checkpoint = createCheckpoint(plan);
    const file = checkpointFile();
    const adapter = {
      listManagedPrivateEndpoints: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          liveEndpoint({ provisioningState: "Provisioning" }),
        ]),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _endpoint: unknown,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          throw new Error("connection reset");
        },
      ),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: liveEndpoint({ connectionStatus: "Approved" }),
        approvalRequired: false,
      })),
      getManagedPrivateEndpoint: vi.fn(async () => liveEndpoint()),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(plan, desired, checkpoint, file, adapter),
        "present",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ status: "created" }),
    ]);
    expect(adapter.createManagedPrivateEndpoint).toHaveBeenCalledOnce();

    await expect(
      applyManagedPrivateEndpoints(
        options(plan, desired, checkpoint, file, adapter),
        "present",
      ),
    ).resolves.toEqual([
      expect.objectContaining({ status: "resumed" }),
    ]);
    expect(adapter.createManagedPrivateEndpoint).toHaveBeenCalledOnce();
  });

  it("early recovery resumes only the already-started endpoint", async () => {
    const desired = manifest([
      {
        name: "alpha",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: "Approve alpha",
      },
      {
        name: "zeta",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: "Approve zeta",
      },
    ]);
    const plan = planFor(desired, []);
    const checkpoint = createCheckpoint(plan);
    const file = checkpointFile();
    const alpha = plan.networkProtection!
      .managedPrivateEndpoints![0]!;
    checkpoint.networkProtection = {
      workspaceId: WORKSPACE_ID,
      managedPrivateEndpoints: {
        [ALPHA_CHECKPOINT_KEY]: {
          name: alpha.name,
          desiredState: "present",
          action: "create",
          operationHash: alpha.operationHash,
          desiredIdentityHash: alpha.desiredIdentityHash,
          phase: "create-submitting",
          submittedAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      },
      updatedAt: "2026-07-18T00:00:00.000Z",
    };
    const adapter = {
      listManagedPrivateEndpoints: vi.fn(async () => [
        liveEndpoint({
          name: "alpha",
          provisioningState: "Provisioning",
        }),
      ]),
      createManagedPrivateEndpoint: vi.fn(),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: liveEndpoint({
          name: "alpha",
          connectionStatus: "Approved",
        }),
        approvalRequired: false,
      })),
    };

    await recoverInterruptedManagedPrivateEndpoints(
      options(plan, desired, checkpoint, file, adapter),
    );

    expect(adapter.createManagedPrivateEndpoint).not.toHaveBeenCalled();
    expect(
      checkpoint.networkProtection.managedPrivateEndpoints?.[
        ALPHA_CHECKPOINT_KEY
      ]?.phase,
    ).toBe("present-verified");
    expect(
      checkpoint.networkProtection.managedPrivateEndpoints?.[
        ZETA_CHECKPOINT_KEY
      ],
    ).toBeUndefined();
  });

  it("fails closed if the observed target identity changes while provisioning", async () => {
    const desired = manifest([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: "Approve",
      },
    ]);
    const plan = planFor(desired, []);
    const checkpoint = createCheckpoint(plan);
    const file = checkpointFile();
    const adapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _endpoint: unknown,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          return liveEndpoint({
            provisioningState: "Provisioning",
          });
        },
      ),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: liveEndpoint({
          targetSubresourceType: "dfs",
        }),
        approvalRequired: false,
      })),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(plan, desired, checkpoint, file, adapter),
        "present",
      ),
    ).rejects.toThrow("physical identity changed while provisioning");
  });

  it("uses safe deterministic checkpoint keys for prototype and numeric endpoint names", async () => {
    const names = ["constructor", "__proto__", "2", "10"];
    const desired = manifest(
      names.map((name) => ({
        name,
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: `Approve ${name}`,
      })),
    );
    const plan = planFor(desired, []);
    const checkpoint = createCheckpoint(plan);
    const file = checkpointFile();
    const ids = new Map(
      names.map((name, index) => [
        name,
        `0000000${index + 1}-0000-4000-8000-000000000000`,
      ]),
    );
    const adapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          endpoint: { name: string },
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          return liveEndpoint({
            id: ids.get(endpoint.name)!,
            name: endpoint.name,
            provisioningState: "Provisioning",
            connectionStatus: undefined,
          });
        },
      ),
      waitForProvisioningSucceeded: vi.fn(
        async (
          _workspaceId: string,
          physicalId: string,
          endpoint: { name: string },
        ) => ({
          endpoint: liveEndpoint({
            id: physicalId,
            name: endpoint.name,
          }),
          approvalRequired: false,
        }),
      ),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(plan, desired, checkpoint, file, adapter),
        "present",
      ),
    ).resolves.toHaveLength(names.length);

    expect(
      Object.keys(
        checkpoint.networkProtection?.managedPrivateEndpoints ?? {},
      ),
    ).toEqual(
      names
        .map(managedPrivateEndpointCheckpointKey)
        .sort(),
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        checkpoint.networkProtection?.managedPrivateEndpoints,
        managedPrivateEndpointCheckpointKey("constructor"),
      ),
    ).toBe(true);
    expect(
      Object.prototype.hasOwnProperty.call(
        checkpoint.networkProtection?.managedPrivateEndpoints,
        managedPrivateEndpointCheckpointKey("__proto__"),
      ),
    ).toBe(true);
  });
});

describe("managed private endpoint delete and recovery", () => {
  function deleteFixture() {
    const desired = manifest([
      {
        name: "storage-blob",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
      },
    ]);
    const plan = planFor(desired, [liveEndpoint()]);
    return {
      desired,
      plan,
      checkpoint: createCheckpoint(plan),
      file: checkpointFile(),
    };
  }

  it("checkpoints before DELETE, treats 404 as success, and records the recreate delay", async () => {
    const fixture = deleteFixture();
    const adapter = {
      getManagedPrivateEndpoint: vi
        .fn()
        .mockResolvedValueOnce(liveEndpoint())
        .mockResolvedValueOnce(undefined),
      listManagedPrivateEndpoints: vi.fn(async () => []),
      deleteManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _physicalId: string,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          expect(
            JSON.parse(readFileSync(fixture.file, "utf8"))
              .networkProtection.managedPrivateEndpoints[
              STORAGE_CHECKPOINT_KEY
            ].phase,
          ).toBe("delete-submitting");
          return "not-found";
        },
      ),
    };
    const now = () => Date.parse("2026-07-18T12:00:00.000Z");

    const result = await applyManagedPrivateEndpoints(
      options(
        fixture.plan,
        fixture.desired,
        fixture.checkpoint,
        fixture.file,
        adapter,
        { now },
      ),
      "absent",
    );

    expect(result?.[0]).toMatchObject({
      status: "deleted",
      deletedAt: "2026-07-18T12:00:00.000Z",
      recreateNotBefore: "2026-07-18T12:15:00.000Z",
    });
    expect(
      fixture.checkpoint.networkProtection
        ?.managedPrivateEndpoints?.[STORAGE_CHECKPOINT_KEY],
    ).toMatchObject({
      phase: "absent-verified",
      deletedAt: "2026-07-18T12:00:00.000Z",
      recreateNotBefore: "2026-07-18T12:15:00.000Z",
    });
  });

  it("does not redispatch an ambiguous delete while the exact ID remains", async () => {
    const fixture = deleteFixture();
    const adapter = {
      getManagedPrivateEndpoint: vi.fn(async () => liveEndpoint()),
      listManagedPrivateEndpoints: vi.fn(async () => [liveEndpoint()]),
      deleteManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _physicalId: string,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          throw new Error("connection reset");
        },
      ),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(
          fixture.plan,
          fixture.desired,
          fixture.checkpoint,
          fixture.file,
          adapter,
        ),
        "absent",
      ),
    ).rejects.toThrow("connection reset");
    expect(
      fixture.checkpoint.networkProtection
        ?.managedPrivateEndpoints?.[STORAGE_CHECKPOINT_KEY]?.phase,
    ).toBe("delete-submitting");

    await expect(
      recoverInterruptedManagedPrivateEndpoints(
        options(
          fixture.plan,
          fixture.desired,
          fixture.checkpoint,
          fixture.file,
          adapter,
        ),
      ),
    ).rejects.toThrow("will not be redispatched");
    expect(adapter.deleteManagedPrivateEndpoint).toHaveBeenCalledOnce();
  });

  it("clears a definitive delete rejection before fallible outcome inspection", async () => {
    const fixture = deleteFixture();
    const adapter = {
      getManagedPrivateEndpoint: vi
        .fn()
        .mockResolvedValueOnce(liveEndpoint())
        .mockRejectedValueOnce(new Error("verification unavailable")),
      listManagedPrivateEndpoints: vi.fn(),
      deleteManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _physicalId: string,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          throw new FabricApiError("Forbidden", 403);
        },
      ),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(
          fixture.plan,
          fixture.desired,
          fixture.checkpoint,
          fixture.file,
          adapter,
        ),
        "absent",
      ),
    ).rejects.toThrow("verification unavailable");
    expect(
      fixture.checkpoint.networkProtection
        ?.managedPrivateEndpoints?.[STORAGE_CHECKPOINT_KEY],
    ).toBeUndefined();
  });

  it("detects a replacement physical ID after deletion", async () => {
    const fixture = deleteFixture();
    const adapter = {
      getManagedPrivateEndpoint: vi
        .fn()
        .mockResolvedValueOnce(liveEndpoint())
        .mockResolvedValueOnce(undefined),
      listManagedPrivateEndpoints: vi.fn(async () => [
        liveEndpoint({ id: REPLACEMENT_ID }),
      ]),
      deleteManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _physicalId: string,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          return "deleted";
        },
      ),
    };

    await expect(
      applyManagedPrivateEndpoints(
        options(
          fixture.plan,
          fixture.desired,
          fixture.checkpoint,
          fixture.file,
          adapter,
        ),
        "absent",
      ),
    ).rejects.toThrow("replaced or collided");
  });
});
