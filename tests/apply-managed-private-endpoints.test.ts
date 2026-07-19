import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import { FabricApiError } from "../src/fabric/client";
import {
  hashCommunicationPolicy,
  normalizeNetworkProtection,
} from "../src/fabric/network-protection";
import {
  planManagedPrivateEndpoints,
  type LiveManagedPrivateEndpoint,
} from "../src/fabric/managed-private-endpoints";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  LoadedManifest,
  NetworkProtectionManifest,
} from "../src/types";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ALPHA_ID = "22222222-2222-4222-8222-222222222222";
const ZETA_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";

function live(
  name: string,
  id: string,
): LiveManagedPrivateEndpoint {
  return {
    id,
    name,
    targetPrivateLinkResourceId: TARGET_ID.toLowerCase(),
    targetSubresourceType: "blob",
    provisioningState: "Succeeded",
    connectionStatus: "Approved",
  };
}

function outputFiles() {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-mpe-apply-order-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function loadedManifest(
  desired: NetworkProtectionManifest,
  withItem = true,
): LoadedManifest {
  return {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: withItem ? { lakehouse: "content" } : {},
    itemDirectories: withItem
      ? { lakehouse: "items/lakehouse" }
      : {},
    itemDefinitions: withItem
      ? { lakehouse: { displayName: "Bronze" } }
      : {},
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: {},
    sparkCustomPoolDefinitions: {},
    manifest: {
      apiVersion: "fabric.deploy/v1alpha1",
      kind: "FabricDeployment",
      metadata: { deploymentId: "mpe-order" },
      workspace: { id: WORKSPACE_ID },
      networkProtection: desired,
      items: withItem
        ? [
            {
              logicalId: "lakehouse",
              type: "Lakehouse",
              path: "items/lakehouse",
            },
          ]
        : [],
    },
  };
}

function approvedPlan(
  loaded: LoadedManifest,
  observedEndpoints: LiveManagedPrivateEndpoint[],
  policy:
    | "relaxation"
    | "managed-private-endpoint-block",
) {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  if (plan.items[0]) {
    plan.items[0] = {
      ...plan.items[0],
      action: "create",
      reason: "missing",
      observedStateHash: "absent",
    };
  }
  const canonical = normalizeNetworkProtection(
    loaded.manifest.networkProtection!,
  );
  const desiredHash = hashCommunicationPolicy(
    canonical.communicationPolicy,
  );
  const observedPolicy =
    policy === "relaxation"
      ? {
          inbound: {
            publicAccessRules: { defaultAction: "Allow" as const },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Deny" as const },
          },
        }
      : {
          inbound: {
            publicAccessRules: { defaultAction: "Allow" as const },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Allow" as const },
          },
        };
  const observedHash = hashCommunicationPolicy(observedPolicy);
  plan.networkProtection = {
    workspaceId: WORKSPACE_ID,
    communicationPolicy: {
      action:
        policy === "managed-private-endpoint-block"
          ? "blocked"
          : "update",
      reason:
        policy === "managed-private-endpoint-block"
          ? "endpoint approval required"
          : "relaxation",
      desiredHash,
      observedStateHash: observedHash,
      desiredInboundDefaultAction: "Allow",
      desiredOutboundDefaultAction:
        canonical.communicationPolicy.outbound.publicAccessRules
          .defaultAction,
      observedInboundDefaultAction: "Allow",
      observedOutboundDefaultAction:
        observedPolicy.outbound.publicAccessRules.defaultAction,
      isRelaxation: policy === "relaxation",
      ...(policy === "managed-private-endpoint-block"
        ? { blockedByManagedPrivateEndpoints: ["alpha"] }
        : {}),
    },
    managedPrivateEndpoints: planManagedPrivateEndpoints(
      canonical.managedPrivateEndpoints ?? [],
      observedEndpoints,
    ),
  };
  return rehashPlan(plan);
}

function lakehouseAdapter(calls: string[]) {
  return {
    plan: vi.fn(async () => ({
      action: "create" as const,
      reason: "missing",
      observedStateHash: "absent",
    })),
    create: vi.fn(
      async (
        _workspaceId: string,
        _desired: unknown,
        accepted?: (physicalId: string) => void,
      ) => {
        calls.push("item-create");
        accepted?.("lakehouse-id");
        return {
          id: "lakehouse-id",
          displayName: "Bronze",
          type: "Lakehouse" as const,
        };
      },
    ),
    update: vi.fn(),
    resumeCreate: vi.fn(),
    verify: vi.fn(),
  };
}

describe("managed private endpoint apply integration", () => {
  it("orders item reconciliation, present endpoint create, OAP, then absent endpoint delete", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      managedPrivateEndpoints: [
        {
          name: "zeta",
          desiredState: "absent",
          targetPrivateLinkResourceId: TARGET_ID,
          targetSubresourceType: "blob",
        },
        {
          name: "alpha",
          targetPrivateLinkResourceId: TARGET_ID,
          targetSubresourceType: "blob",
          requestMessage: "Approve alpha",
        },
      ],
    };
    const zeta = live("zeta", ZETA_ID);
    const loaded = loadedManifest(desired);
    const approved = approvedPlan(
      loaded,
      [zeta],
      "relaxation",
    );
    const calls: string[] = [];
    const networkAdapter = {
      plan: vi.fn(async () => approved.networkProtection!),
      getCommunicationPolicy: vi.fn(async () => ({
        policy: normalizeNetworkProtection(desired)
          .communicationPolicy,
        etag: undefined,
      })),
      putCommunicationPolicy: vi.fn(
        async (
          _workspaceId: string,
          _policy: unknown,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          calls.push("oap-put");
          return {
            policy: normalizeNetworkProtection(desired)
              .communicationPolicy,
          };
        },
      ),
      getOutboundCloudConnectionRules: vi.fn(),
      putOutboundCloudConnectionRules: vi.fn(),
      getOutboundGatewayRules: vi.fn(),
      putOutboundGatewayRules: vi.fn(),
    };
    const mpeAdapter = {
      listManagedPrivateEndpoints: vi
        .fn()
        .mockResolvedValueOnce([zeta])
        .mockResolvedValueOnce([]),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          endpoint: { name: string },
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          calls.push(`mpe-create:${endpoint.name}`);
          return {
            ...live(endpoint.name, ALPHA_ID),
            provisioningState: "Provisioning",
            connectionStatus: undefined,
          };
        },
      ),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: live("alpha", ALPHA_ID),
        approvalRequired: false,
      })),
      getManagedPrivateEndpoint: vi
        .fn()
        .mockResolvedValueOnce(zeta)
        .mockResolvedValueOnce(undefined),
      deleteManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _physicalId: string,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          calls.push("mpe-delete:zeta");
          return "deleted" as const;
        },
      ),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(calls),
      networkProtectionAdapter: networkAdapter,
      managedPrivateEndpointAdapter: mpeAdapter,
      allowCreate: true,
      allowUpdate: false,
      allowNetworkPolicyUpdate: true,
      allowNetworkPolicyRelaxation: true,
      allowManagedPrivateEndpointCreate: true,
      allowManagedPrivateEndpointDelete: true,
      ...outputFiles(),
    });

    expect(calls).toEqual([
      "item-create",
      "mpe-create:alpha",
      "oap-put",
      "mpe-delete:zeta",
    ]);
    expect(
      result.networkProtection?.managedPrivateEndpoints?.map(
        (endpoint) => endpoint.name,
      ),
    ).toEqual(["alpha", "zeta"]);
  });

  it("preflights MPE safeguards before any item or OAP mutation", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      managedPrivateEndpoints: [
        {
          name: "alpha",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve alpha",
        },
      ],
    };
    const loaded = loadedManifest(desired);
    const approved = approvedPlan(
      loaded,
      [],
      "relaxation",
    );
    const calls: string[] = [];
    const itemAdapter = lakehouseAdapter(calls);
    const networkAdapter = {
      plan: vi.fn(),
      getCommunicationPolicy: vi.fn(),
      putCommunicationPolicy: vi.fn(),
      getOutboundCloudConnectionRules: vi.fn(),
      putOutboundCloudConnectionRules: vi.fn(),
      getOutboundGatewayRules: vi.fn(),
      putOutboundGatewayRules: vi.fn(),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: approved,
        currentPlan: approved,
        loadedManifest: loaded,
        lakehouseAdapter: itemAdapter,
        networkProtectionAdapter: networkAdapter,
        managedPrivateEndpointAdapter: {} as never,
        allowCreate: true,
        allowUpdate: false,
        allowNetworkPolicyUpdate: true,
        allowNetworkPolicyRelaxation: true,
        allowManagedPrivateEndpointCreate: false,
        allowManagedPrivateEndpointDelete: true,
        ...outputFiles(),
      }),
    ).rejects.toThrow(
      "allow-managed-private-endpoint-create is false",
    );
    expect(itemAdapter.create).not.toHaveBeenCalled();
    expect(networkAdapter.putCommunicationPolicy).not.toHaveBeenCalled();
  });

  it("creates the endpoint but defers outbound Deny until approval and replan", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      managedPrivateEndpoints: [
        {
          name: "alpha",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve alpha",
        },
      ],
    };
    const loaded = loadedManifest(desired, false);
    const approved = approvedPlan(
      loaded,
      [],
      "managed-private-endpoint-block",
    );
    const networkAdapter = {
      plan: vi.fn(),
      getCommunicationPolicy: vi.fn(),
      putCommunicationPolicy: vi.fn(),
      getOutboundCloudConnectionRules: vi.fn(),
      putOutboundCloudConnectionRules: vi.fn(),
      getOutboundGatewayRules: vi.fn(),
      putOutboundGatewayRules: vi.fn(),
    };
    const mpeAdapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          endpoint: { name: string },
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          return {
            ...live(endpoint.name, ALPHA_ID),
            provisioningState: "Provisioning",
            connectionStatus: undefined,
          };
        },
      ),
      waitForProvisioningSucceeded: vi.fn(async () => ({
        endpoint: {
          ...live("alpha", ALPHA_ID),
          connectionStatus: "Pending",
        },
        approvalRequired: true,
      })),
      getManagedPrivateEndpoint: vi.fn(),
      deleteManagedPrivateEndpoint: vi.fn(),
    };

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter([]),
      networkProtectionAdapter: networkAdapter,
      managedPrivateEndpointAdapter: mpeAdapter,
      allowCreate: false,
      allowUpdate: false,
      allowNetworkPolicyUpdate: false,
      allowNetworkPolicyRelaxation: false,
      allowManagedPrivateEndpointCreate: true,
      allowManagedPrivateEndpointDelete: false,
      ...outputFiles(),
    });

    expect(result.status).toBe("succeeded");
    expect(
      result.networkProtection?.communicationPolicy.status,
    ).toBe("deferred");
    expect(
      result.networkProtection?.managedPrivateEndpoints?.[0],
    ).toMatchObject({
      status: "created",
      approvalRequired: true,
    });
    expect(networkAdapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(networkAdapter.plan).not.toHaveBeenCalled();
  });

  it("resumes an approved endpoint without auto-tightening the originally deferred OAP plan", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      managedPrivateEndpoints: [
        {
          name: "alpha",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve alpha",
        },
      ],
    };
    const loaded = loadedManifest(desired, false);
    const approved = approvedPlan(
      loaded,
      [],
      "managed-private-endpoint-block",
    );
    const files = outputFiles();
    const pending = {
      ...live("alpha", ALPHA_ID),
      connectionStatus: "Pending",
    };
    const approvedEndpoint = live("alpha", ALPHA_ID);
    const networkAdapter = {
      plan: vi.fn(),
      getCommunicationPolicy: vi.fn(),
      putCommunicationPolicy: vi.fn(),
      getOutboundCloudConnectionRules: vi.fn(),
      putOutboundCloudConnectionRules: vi.fn(),
      getOutboundGatewayRules: vi.fn(),
      putOutboundGatewayRules: vi.fn(),
    };
    const mpeAdapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          endpoint: { name: string },
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          return {
            ...pending,
            name: endpoint.name,
            provisioningState: "Provisioning",
            connectionStatus: undefined,
          };
        },
      ),
      waitForProvisioningSucceeded: vi
        .fn()
        .mockResolvedValueOnce({
          endpoint: pending,
          approvalRequired: true,
        })
        .mockResolvedValueOnce({
          endpoint: approvedEndpoint,
          approvalRequired: false,
        }),
      getManagedPrivateEndpoint: vi.fn(async () => approvedEndpoint),
      deleteManagedPrivateEndpoint: vi.fn(),
    };

    await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter([]),
      networkProtectionAdapter: networkAdapter,
      managedPrivateEndpointAdapter: mpeAdapter,
      allowCreate: false,
      allowUpdate: false,
      allowNetworkPolicyUpdate: false,
      allowNetworkPolicyRelaxation: false,
      allowManagedPrivateEndpointCreate: true,
      allowManagedPrivateEndpointDelete: false,
      ...files,
    });

    const current = structuredClone(approved);
    current.networkProtection = {
      ...approved.networkProtection!,
      communicationPolicy: {
        ...approved.networkProtection!.communicationPolicy,
        action: "update",
        reason: "endpoint approved; OAP can be tightened by a new plan",
        blockedByManagedPrivateEndpoints: undefined,
      },
      managedPrivateEndpoints: planManagedPrivateEndpoints(
        normalizeNetworkProtection(desired).managedPrivateEndpoints ?? [],
        [approvedEndpoint],
      ),
    };
    const currentPlan = rehashPlan(current);

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter([]),
      networkProtectionAdapter: networkAdapter,
      managedPrivateEndpointAdapter: mpeAdapter,
      allowCreate: false,
      allowUpdate: false,
      allowNetworkPolicyUpdate: false,
      allowNetworkPolicyRelaxation: false,
      allowManagedPrivateEndpointCreate: false,
      allowManagedPrivateEndpointDelete: false,
      ...files,
    });

    expect(
      result.networkProtection?.communicationPolicy.status,
    ).toBe("deferred");
    expect(
      result.networkProtection?.managedPrivateEndpoints?.[0],
    ).toMatchObject({
      name: "alpha",
      status: "resumed",
      connectionStatus: "Approved",
    });
    expect(networkAdapter.putCommunicationPolicy).not.toHaveBeenCalled();
    expect(mpeAdapter.createManagedPrivateEndpoint).toHaveBeenCalledTimes(1);
  });

  it("redacts requestMessage from thrown errors and failed result artifacts", async () => {
    const requestMessage = "sensitive approval rationale";
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      managedPrivateEndpoints: [
        {
          name: "alpha",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage,
        },
      ],
    };
    const loaded = loadedManifest(desired, false);
    const approved = approvedPlan(
      loaded,
      [],
      "relaxation",
    );
    const files = outputFiles();
    const mpeAdapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
      createManagedPrivateEndpoint: vi.fn(
        async (
          _workspaceId: string,
          _endpoint: unknown,
          request: { onDispatch?: () => void },
        ) => {
          request.onDispatch?.();
          throw new FabricApiError(
            `Rejected: ${requestMessage}`,
            400,
          );
        },
      ),
      waitForProvisioningSucceeded: vi.fn(),
      getManagedPrivateEndpoint: vi.fn(),
      deleteManagedPrivateEndpoint: vi.fn(),
    };

    const error = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter([]),
      networkProtectionAdapter: {
        plan: vi.fn(),
        getCommunicationPolicy: vi.fn(),
        putCommunicationPolicy: vi.fn(),
        getOutboundCloudConnectionRules: vi.fn(),
        putOutboundCloudConnectionRules: vi.fn(),
        getOutboundGatewayRules: vi.fn(),
        putOutboundGatewayRules: vi.fn(),
      },
      managedPrivateEndpointAdapter: mpeAdapter,
      allowCreate: false,
      allowUpdate: false,
      allowNetworkPolicyUpdate: true,
      allowNetworkPolicyRelaxation: true,
      allowManagedPrivateEndpointCreate: true,
      allowManagedPrivateEndpointDelete: false,
      ...files,
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).not.toContain(requestMessage);
    const result = readFileSync(files.resultFile, "utf8");
    expect(result).not.toContain(requestMessage);
    expect(result).toContain("████████");
  });
});
