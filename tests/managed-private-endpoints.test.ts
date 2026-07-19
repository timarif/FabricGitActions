import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricApiError, FabricClient } from "../src/fabric/client";
import {
  ManagedPrivateEndpointAdapter,
  normalizeManagedPrivateEndpoints,
  parseManagedPrivateEndpointResponse,
  planManagedPrivateEndpoints,
  redactManagedPrivateEndpointError,
  redactManagedPrivateEndpointRequestMessages,
  type LiveManagedPrivateEndpoint,
} from "../src/fabric/managed-private-endpoints";
import { NetworkProtectionAdapter } from "../src/fabric/network-protection";

const tokenProvider = {
  getToken: async () => "token",
};
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ENDPOINT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ENDPOINT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID =
  "/subscriptions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/resourceGroups/DataRG/providers/Microsoft.Storage/storageAccounts/data";
const CANONICAL_TARGET_ID = TARGET_ID.toLowerCase();

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(
    body === undefined ? undefined : JSON.stringify(body),
    { status, headers },
  );
}

function createClient(fetchImpl: FetchLike): FabricClient {
  return new FabricClient({
    endpoint: "https://api.fabric.microsoft.com",
    scope: "scope",
    tokenProvider,
    fetchImpl,
    sleep: async () => undefined,
  });
}

function liveEndpoint(
  overrides: Partial<LiveManagedPrivateEndpoint> = {},
): LiveManagedPrivateEndpoint {
  return {
    id: ENDPOINT_ID,
    name: "storage-blob",
    targetPrivateLinkResourceId: CANONICAL_TARGET_ID,
    targetSubresourceType: "blob",
    provisioningState: "Succeeded",
    connectionStatus: "Approved",
    ...overrides,
  };
}

function apiEndpoint(
  overrides: Partial<LiveManagedPrivateEndpoint> = {},
): Record<string, unknown> {
  const endpoint = liveEndpoint(overrides);
  const {
    connectionStatus,
    ...body
  } = endpoint;
  return {
    ...body,
    ...(connectionStatus
      ? { connectionState: { status: connectionStatus } }
      : {}),
  };
}

describe("managed private endpoint normalization", () => {
  it("defaults present, canonicalizes ARM IDs, and sorts names deterministically", () => {
    const endpoints = normalizeManagedPrivateEndpoints([
      {
        name: "zeta",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage: "Approve zeta",
      },
      {
        name: "Alpha",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
      },
    ]);

    expect(endpoints.map((endpoint) => endpoint.name)).toEqual([
      "Alpha",
      "zeta",
    ]);
    expect(endpoints[1]).toMatchObject({
      desiredState: "present",
      targetPrivateLinkResourceId: CANONICAL_TARGET_ID,
    });
  });

  it("rejects case-insensitive collisions, padding, oversize fields, and targetFQDNs", () => {
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "Storage",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
        },
        {
          name: "storage",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
        },
      ]),
    ).toThrow("case-insensitive name collision");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: " padded",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
        },
      ]),
    ).toThrow("surrounding whitespace");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "x".repeat(65),
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
        },
      ]),
    ).toThrow("64");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "x".repeat(141),
        },
      ]),
    ).toThrow("140");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
          targetFQDNs: ["storage.example"] ,
        },
      ]),
    ).toThrow("targetFQDNs");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          targetPrivateLinkResourceId:
            "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts",
          requestMessage: "Approve",
        },
      ]),
    ).toThrow("valid subscription-scoped ARM resource ID");
  });

  it("requires requestMessage for present, forbids it for absent, and requires a deletion target", () => {
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          targetPrivateLinkResourceId: TARGET_ID,
        },
      ]),
    ).toThrow("requestMessage");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          desiredState: "absent",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "not allowed",
        },
      ]),
    ).toThrow("forbidden");
    expect(() =>
      normalizeManagedPrivateEndpoints([
        {
          name: "storage",
          desiredState: "absent",
        },
      ]),
    ).toThrow("targetPrivateLinkResourceId");
  });
});

describe("managed private endpoint parsing and planning", () => {
  it("redacts immutable errors and malformed Unicode without throwing", () => {
    const requestMessage = "private timeout context";
    const redactedError = redactManagedPrivateEndpointError(
      new DOMException(
        `Timed out for ${requestMessage}`,
        "TimeoutError",
      ),
      [requestMessage],
    );
    expect(redactedError).toBeInstanceOf(Error);
    expect((redactedError as Error).message).not.toContain(
      requestMessage,
    );

    const loneSurrogate = "\ud800";
    expect(() =>
      redactManagedPrivateEndpointRequestMessages(
        `Rejected ${loneSurrogate}`,
        [loneSurrogate],
      ),
    ).not.toThrow();
    expect(
      redactManagedPrivateEndpointRequestMessages(
        `Rejected ${loneSurrogate}`,
        [loneSurrogate],
      ),
    ).not.toContain(loneSurrogate);

    const shortMessages = ["E", "A", "D", "T", "R"];
    const once = redactManagedPrivateEndpointRequestMessages(
      "E A D T R",
      shortMessages,
    );
    const twice = redactManagedPrivateEndpointRequestMessages(
      once,
      shortMessages,
    );
    expect(twice).toBe(once);
    expect(twice.length).toBeLessThan(100);
  });

  it("preserves extensible state strings without crashing", () => {
    expect(
      parseManagedPrivateEndpointResponse({
        id: ENDPOINT_ID,
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        provisioningState: "FutureProvisioningState",
        connectionState: { status: "FutureConnectionState" },
      }),
    ).toMatchObject({
      provisioningState: "FutureProvisioningState",
      connectionStatus: "FutureConnectionState",
    });
  });

  it("plans create/no-op/delete and never emits the request message", () => {
    const [present] = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "secret approval message",
      },
    ]);
    const [absent] = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
      },
    ]);

    expect(planManagedPrivateEndpoints([present!], [])[0]?.action).toBe(
      "create",
    );
    const pending = planManagedPrivateEndpoints(
      [present!],
      [liveEndpoint({ connectionStatus: "Pending" })],
    )[0]!;
    expect(pending).toMatchObject({
      action: "no-op",
      approvalRequired: true,
      physicalId: ENDPOINT_ID,
    });
    expect(JSON.stringify(pending)).not.toContain(
      "secret approval message",
    );
    expect(
      planManagedPrivateEndpoints([absent!], [liveEndpoint()])[0],
    ).toMatchObject({
      action: "delete",
      physicalId: ENDPOINT_ID,
      observedIdentityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    [{ provisioningState: "Failed" }, "blocked"],
    [{ provisioningState: "Deleting" }, "blocked"],
    [{ connectionStatus: "Rejected" }, "blocked"],
    [{ connectionStatus: "Disconnected" }, "blocked"],
    [{ provisioningState: "FutureState" }, "unknown"],
    [{ connectionStatus: "FutureState" }, "unknown"],
  ] as const)(
    "fails closed for unsafe or unknown live state %#",
    (overrides, action) => {
      const desired = normalizeManagedPrivateEndpoints([
        {
          name: "storage-blob",
          targetPrivateLinkResourceId: TARGET_ID,
          targetSubresourceType: "blob",
          requestMessage: "Approve",
        },
      ]);
      expect(
        planManagedPrivateEndpoints(
          desired,
          [liveEndpoint(overrides)],
        )[0]?.action,
      ).toBe(action);
    },
  );

  it("blocks exact-name identity mismatches and case-insensitive live collisions", () => {
    const desired = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve",
      },
    ]);
    expect(
      planManagedPrivateEndpoints(desired, [
        liveEndpoint({
          targetPrivateLinkResourceId:
            "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/DataRG/providers/Microsoft.Storage/storageAccounts/other".toLowerCase(),
        }),
      ])[0]?.action,
    ).toBe("blocked");
    expect(
      planManagedPrivateEndpoints(desired, [
        liveEndpoint({ name: "Storage-Blob" }),
      ])[0]?.action,
    ).toBe("blocked");
  });
});

describe("ManagedPrivateEndpointAdapter", () => {
  it("lists all pages in deterministic order and retries only 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errorCode: "TooManyRequests" }, 429, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [
            {
              ...apiEndpoint({ id: OTHER_ENDPOINT_ID, name: "zeta" }),
            },
          ],
          continuationToken: "next%3D",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          value: [apiEndpoint({ name: "Alpha" })],
        }),
      );
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(fetchImpl),
    );

    const result = await adapter.listManagedPrivateEndpoints(
      WORKSPACE_ID,
    );

    expect(result.map((endpoint) => endpoint.name)).toEqual([
      "Alpha",
      "zeta",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain(
      "continuationToken=next%3D",
    );
    expect(String(fetchImpl.mock.calls[2]?.[0])).not.toContain(
      "continuationToken=next%253D",
    );
  });

  it("rejects malformed continuation metadata instead of accepting an incomplete list", async () => {
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(
        vi.fn(async () =>
          jsonResponse({
            value: [],
            continuationToken: 42,
          }),
        ),
      ),
    );

    await expect(
      adapter.listManagedPrivateEndpoints(WORKSPACE_ID),
    ).rejects.toThrow("continuationToken must be a string");
  });

  it.each([408, 500, 503])(
    "does not retry HTTP %s",
    async (status) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ errorCode: "failure" }, status),
      );
      const adapter = new ManagedPrivateEndpointAdapter(
        createClient(fetchImpl),
      );
      await expect(
        adapter.listManagedPrivateEndpoints(WORKSPACE_ID),
      ).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not retry transport failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(fetchImpl),
    );
    await expect(
      adapter.listManagedPrivateEndpoints(WORKSPACE_ID),
    ).rejects.toThrow("connection reset");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("creates with POST 201, polls to Succeeded+Pending, and treats requestMessage as write-only", async () => {
    const requests: Array<{ method: string; body?: unknown }> = [];
    let getCount = 0;
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          body: init?.body
            ? JSON.parse(String(init.body))
            : undefined,
        });
        if (init?.method === "POST") {
          return jsonResponse(
            apiEndpoint({
              provisioningState: "Provisioning",
              connectionStatus: undefined,
            }),
            201,
            {
              location: `https://api.fabric.microsoft.com/v1/workspaces/${WORKSPACE_ID}/managedPrivateEndpoints/${ENDPOINT_ID}`,
            },
          );
        }
        getCount += 1;
        return jsonResponse(
          getCount === 1
            ? apiEndpoint({
                provisioningState: "Provisioning",
                connectionStatus: undefined,
              })
            : apiEndpoint({ connectionStatus: "Pending" }),
        );
      },
    );
    let clock = 0;
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(fetchImpl),
      {
        operationTimeoutMs: 100,
        operationPollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      },
    );
    const desired = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve this endpoint",
      },
    ])[0]!;

    const created = await adapter.createManagedPrivateEndpoint(
      WORKSPACE_ID,
      desired,
    );
    const outcome = await adapter.waitForProvisioningSucceeded(
      WORKSPACE_ID,
      created.id,
      desired,
    );

    expect(requests[0]).toMatchObject({
      method: "POST",
      body: {
        name: "storage-blob",
        targetPrivateLinkResourceId: CANONICAL_TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve this endpoint",
      },
    });
    expect(created).not.toHaveProperty("requestMessage");
    expect(outcome).toMatchObject({
      approvalRequired: true,
      endpoint: {
        provisioningState: "Succeeded",
        connectionStatus: "Pending",
      },
    });
  });

  it("redacts a request message echoed by a definitive create error", async () => {
    const requestMessage = "private approval context";
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(
        vi.fn(async () =>
          jsonResponse(
            {
              message: `Rejected request: ${requestMessage}`,
            },
            400,
          ),
        ),
      ),
    );
    const desired = normalizeManagedPrivateEndpoints([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        requestMessage,
      },
    ])[0]!;

    const error = await adapter
      .createManagedPrivateEndpoint(WORKSPACE_ID, desired)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FabricApiError);
    expect((error as Error).message).not.toContain(requestMessage);
    expect((error as Error).message).toContain("████████");
  });

  it("accepts delete 200 and 404 without retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(undefined, 200))
      .mockResolvedValueOnce(jsonResponse(undefined, 404));
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(fetchImpl),
    );

    await expect(
      adapter.deleteManagedPrivateEndpoint(
        WORKSPACE_ID,
        ENDPOINT_ID,
      ),
    ).resolves.toBe("deleted");
    await expect(
      adapter.deleteManagedPrivateEndpoint(
        WORKSPACE_ID,
        ENDPOINT_ID,
      ),
    ).resolves.toBe("not-found");
  });

  it("rejects a get response whose physical ID differs from the requested ID", async () => {
    const adapter = new ManagedPrivateEndpointAdapter(
      createClient(
        vi.fn(async () =>
          jsonResponse(apiEndpoint({ id: OTHER_ENDPOINT_ID })),
        ),
      ),
    );

    await expect(
      adapter.getManagedPrivateEndpoint(
        WORKSPACE_ID,
        ENDPOINT_ID,
      ),
    ).rejects.toThrow("does not match the requested physical ID");
  });
});

describe("network protection OAP interaction", () => {
  it("blocks outbound Allow-to-Deny until a declared present endpoint is approved", async () => {
    const client = createClient(
      vi.fn(async () =>
        jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Allow" } },
        }),
      ),
    );
    const mpeAdapter = {
      listManagedPrivateEndpoints: vi.fn(async () => []),
    } as unknown as ManagedPrivateEndpointAdapter;
    const adapter = new NetworkProtectionAdapter(
      client,
      mpeAdapter,
    );

    const plan = await adapter.plan(WORKSPACE_ID, {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      managedPrivateEndpoints: [
        {
          name: "storage-blob",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve",
        },
      ],
    });

    expect(plan.communicationPolicy).toMatchObject({
      action: "blocked",
      blockedByManagedPrivateEndpoints: ["storage-blob"],
    });
    expect(plan.managedPrivateEndpoints?.[0]?.action).toBe("create");
  });
});
