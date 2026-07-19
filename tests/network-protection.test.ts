import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  hashCommunicationPolicy,
  hashInboundAzureResourceRules,
  hashInboundFirewallRules,
  hashOutboundCloudConnectionRules,
  hashOutboundGatewayRules,
  NetworkProtectionAdapter,
  normalizeInboundAzureResourceRules,
  normalizeInboundFirewallRules,
  normalizeNetworkProtection,
  quoteEtag,
} from "../src/fabric/network-protection";
import type { NetworkProtectionManifest } from "../src/types";

const tokenProvider = {
  getToken: async () => "token",
};

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ID_A = "33333333-3333-4333-8333-333333333333";
const GATEWAY_ID_B = "44444444-4444-4444-8444-444444444444";

function createAdapter(fetchImpl: FetchLike): NetworkProtectionAdapter {
  return new NetworkProtectionAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function desiredAllowOutbound(): NetworkProtectionManifest {
  return {
    communicationPolicy: {
      inboundDefaultAction: "Allow",
      outboundDefaultAction: "Allow",
    },
  };
}

function desiredDenyOutboundWithRules(): NetworkProtectionManifest {
  return {
    communicationPolicy: {
      inboundDefaultAction: "Allow",
      outboundDefaultAction: "Deny",
    },
    outboundCloudConnectionRules: {
      defaultAction: "Deny",
      rules: [
        {
          connectionType: "SQL",
          defaultAction: "Deny",
          allowedEndpoints: [{ hostnamePattern: "*.database.windows.net" }],
        },
        {
          connectionType: "Web",
          defaultAction: "Allow",
        },
      ],
    },
    outboundGatewayRules: {
      defaultAction: "Deny",
      allowedGateways: [{ id: GATEWAY_ID_B }, { id: GATEWAY_ID_A }],
    },
  };
}

describe("normalizeNetworkProtection", () => {
  it("sorts rules, endpoints, workspaces, and gateway IDs deterministically", () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        defaultAction: "Deny",
        rules: [
          {
            connectionType: "Web",
            defaultAction: "Allow",
          },
          {
            connectionType: "LakeHouse",
            defaultAction: "Deny",
            allowedWorkspaces: [
              { workspaceId: OTHER_WORKSPACE_ID.toUpperCase() },
              { workspaceId: WORKSPACE_ID },
            ],
          },
          {
            connectionType: "SQL",
            defaultAction: "Deny",
            allowedEndpoints: [
              { hostnamePattern: "*.contoso.com" },
              { hostnamePattern: "*.database.windows.net" },
            ],
          },
        ],
      },
      outboundGatewayRules: {
        defaultAction: "Deny",
        allowedGateways: [
          { id: GATEWAY_ID_B },
          { id: GATEWAY_ID_A.toUpperCase() },
        ],
      },
    };

    const canonical = normalizeNetworkProtection(desired);

    expect(canonical.outboundCloudConnectionRules?.rules.map((rule) => rule.connectionType)).toEqual([
      "LakeHouse",
      "SQL",
      "Web",
    ]);
    expect(
      canonical.outboundCloudConnectionRules?.rules[0]?.allowedWorkspaces?.map(
        (workspace) => workspace.workspaceId,
      ),
    ).toEqual([WORKSPACE_ID.toLowerCase(), OTHER_WORKSPACE_ID.toLowerCase()]);
    expect(
      canonical.outboundCloudConnectionRules?.rules[1]?.allowedEndpoints?.map(
        (endpoint) => endpoint.hostnamePattern,
      ),
    ).toEqual(["*.contoso.com", "*.database.windows.net"]);
    expect(canonical.outboundGatewayRules?.allowedGateways.map((gateway) => gateway.id)).toEqual(
      [GATEWAY_ID_A.toLowerCase(), GATEWAY_ID_B.toLowerCase()],
    );
  });

  it("canonicalizes empty optional allowlists to omission", () => {
    const omitted = normalizeNetworkProtection({
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        defaultAction: "Deny",
        rules: [
          {
            connectionType: "Web",
            defaultAction: "Allow",
          },
        ],
      },
    });
    const explicitEmpty = normalizeNetworkProtection({
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
      outboundCloudConnectionRules: {
        defaultAction: "Deny",
        rules: [
          {
            connectionType: "Web",
            defaultAction: "Allow",
            allowedEndpoints: [],
            allowedWorkspaces: [],
          },
        ],
      },
    });

    expect(explicitEmpty).toEqual(omitted);
    expect(
      hashOutboundCloudConnectionRules(
        explicitEmpty.outboundCloudConnectionRules!,
      ),
    ).toBe(
      hashOutboundCloudConnectionRules(
        omitted.outboundCloudConnectionRules!,
      ),
    );
  });

  it("rejects duplicate connection types, hostnames, workspace IDs, and gateway IDs", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [
            { connectionType: "SQL", defaultAction: "Deny" },
            { connectionType: "SQL", defaultAction: "Allow" },
          ],
        },
      }),
    ).toThrow("duplicate connectionType 'SQL'");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [
            {
              connectionType: "SQL",
              defaultAction: "Deny",
              allowedEndpoints: [
                { hostnamePattern: "*.contoso.com" },
                { hostnamePattern: "*.contoso.com" },
              ],
            },
          ],
        },
      }),
    ).toThrow("duplicate hostnamePattern");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [
            {
              connectionType: "LakeHouse",
              defaultAction: "Deny",
              allowedWorkspaces: [
                { workspaceId: WORKSPACE_ID },
                { workspaceId: WORKSPACE_ID.toUpperCase() },
              ],
            },
          ],
        },
      }),
    ).toThrow("duplicate workspaceId");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundGatewayRules: {
          defaultAction: "Deny",
          allowedGateways: [{ id: GATEWAY_ID_A }, { id: GATEWAY_ID_A }],
        },
      }),
    ).toThrow("duplicate gateway id");
  });

  it("rejects blank connection types and hostname patterns", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [{ connectionType: "   ", defaultAction: "Deny" }],
        },
      }),
    ).toThrow("non-blank string");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [
            {
              connectionType: "Web",
              defaultAction: "Deny",
              allowedEndpoints: [{ hostnamePattern: "  " }],
            },
          ],
        },
      }),
    ).toThrow("non-blank string");
  });

  it("rejects non-GUID workspace, gateway, and top-level workspace IDs", () => {
    expect(() =>
      normalizeNetworkProtection({
        workspaceId: "not-a-guid",
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Allow",
        },
      }),
    ).toThrow("must be a GUID");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundGatewayRules: {
          defaultAction: "Deny",
          allowedGateways: [{ id: "not-a-guid" }],
        },
      }),
    ).toThrow("must be a GUID");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Deny",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [
            {
              connectionType: "LakeHouse",
              defaultAction: "Deny",
              allowedWorkspaces: [{ workspaceId: "not-a-guid" }],
            },
          ],
        },
      }),
    ).toThrow("must be a GUID");
  });

  it("rejects inbound Deny without an explicit non-empty firewall body", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Deny",
          outboundDefaultAction: "Allow",
        },
      }),
    ).toThrow("requires an explicit inboundFirewallRules configuration");
  });

  it("rejects outbound rules declared while outboundDefaultAction is Allow", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Allow",
        },
        outboundCloudConnectionRules: {
          defaultAction: "Deny",
          rules: [],
        },
      }),
    ).toThrow("may only be declared when communicationPolicy.outboundDefaultAction is 'Deny'");

    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Allow",
        },
        outboundGatewayRules: {
          defaultAction: "Deny",
          allowedGateways: [],
        },
      }),
    ).toThrow("may only be declared when communicationPolicy.outboundDefaultAction is 'Deny'");
  });

  it("requires explicit defaultAction fields", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          outboundDefaultAction: "Allow",
        } as never,
      }),
    ).toThrow("must be either 'Allow' or 'Deny'");
  });
});

describe("normalizeInboundFirewallRules", () => {
  it("canonicalizes rule order and equivalent IPv4 forms deterministically", () => {
    const first = normalizeInboundFirewallRules(
      {
        rules: [
          {
            displayName: "cidr",
            value: "52.10.20.99/24",
          },
          {
            displayName: "range",
            value: "23.45.67.80-23.45.67.89",
          },
          {
            displayName: "single",
            value: "8.8.8.8/32",
          },
        ],
      },
      "networkProtection.inboundFirewallRules",
    );
    const second = normalizeInboundFirewallRules(
      {
        rules: [
          {
            displayName: "single",
            value: "8.8.8.8",
          },
          {
            displayName: "range",
            value: "23.45.67.80-23.45.67.89",
          },
          {
            displayName: "cidr",
            value: "52.10.20.0/24",
          },
        ],
      },
      "networkProtection.inboundFirewallRules",
    );

    expect(first).toEqual({
      rules: [
        { displayName: "single", value: "8.8.8.8" },
        {
          displayName: "range",
          value: "23.45.67.80-23.45.67.89",
        },
        { displayName: "cidr", value: "52.10.20.0/24" },
      ],
    });
    expect(hashInboundFirewallRules(first)).toBe(
      hashInboundFirewallRules(second),
    );
  });

  it("rejects malformed, ambiguous, IPv6, and non-public values", () => {
    for (const value of [
      "1.2.3",
      "01.2.3.4",
      "1.2.3.4/33",
      "1.2.3.9-1.2.3.4",
      "1.2.3.4 -1.2.3.5",
      "2001:db8::1",
      "10.0.0.1",
      "192.168.1.0/24",
    ]) {
      expect(() =>
        normalizeInboundFirewallRules(
          {
            rules: [{ displayName: "rule", value }],
          },
          "networkProtection.inboundFirewallRules",
        ),
      ).toThrow();
    }
  });

  it("rejects duplicate names and duplicate or overlapping address declarations", () => {
    expect(() =>
      normalizeInboundFirewallRules(
        {
          rules: [
            { displayName: "Corporate", value: "8.8.8.8" },
            { displayName: "corporate", value: "9.9.9.9" },
          ],
        },
        "networkProtection.inboundFirewallRules",
      ),
    ).toThrow("case-ambiguous displayName");

    expect(() =>
      normalizeInboundFirewallRules(
        {
          rules: [
            {
              displayName: "network",
              value: "52.10.20.0/24",
            },
            {
              displayName: "host",
              value: "52.10.20.10",
            },
          ],
        },
        "networkProtection.inboundFirewallRules",
      ),
    ).toThrow("overlapping IP declarations");
  });

  it("accepts inbound Deny only with an approved public rule", () => {
    expect(
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Deny",
          outboundDefaultAction: "Allow",
        },
        inboundFirewallRules: {
          rules: [
            {
              displayName: "corporate",
              value: "12.34.56.78",
            },
          ],
        },
      }).inboundFirewallRules,
    ).toEqual({
      rules: [
        {
          displayName: "corporate",
          value: "12.34.56.78",
        },
      ],
    });
  });
});

describe("normalizeInboundAzureResourceRules", () => {
  const RESOURCE_ID_A =
    "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/storageacct";
  const RESOURCE_ID_B =
    "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/sqlserver";

  it("canonicalizes ARM resource IDs and sorts deterministically", () => {
    const first = normalizeInboundAzureResourceRules(
      {
        rules: [
          { displayName: "sql", resourceId: RESOURCE_ID_B },
          {
            displayName: "storage",
            resourceId: RESOURCE_ID_A.toUpperCase(),
          },
        ],
      },
      "networkProtection.inboundAzureResourceRules",
    );
    const second = normalizeInboundAzureResourceRules(
      {
        rules: [
          { displayName: "storage", resourceId: RESOURCE_ID_A },
          { displayName: "sql", resourceId: RESOURCE_ID_B },
        ],
      },
      "networkProtection.inboundAzureResourceRules",
    );

    expect(first.rules.map((rule) => rule.resourceId)).toEqual(
      second.rules.map((rule) => rule.resourceId),
    );
    expect(hashInboundAzureResourceRules(first)).toBe(
      hashInboundAzureResourceRules(second),
    );
  });

  it("rejects unknown fields, malformed ARM IDs, and duplicate resource declarations", () => {
    expect(() =>
      normalizeInboundAzureResourceRules(
        {
          rules: [
            {
              displayName: "resource",
              resourceId: RESOURCE_ID_A,
              extra: "nope",
            } as never,
          ],
        },
        "networkProtection.inboundAzureResourceRules",
      ),
    ).toThrow("unsupported property");

    expect(() =>
      normalizeInboundAzureResourceRules(
        {
          rules: [{ displayName: "bad-id", resourceId: "not-an-arm-id" }],
        },
        "networkProtection.inboundAzureResourceRules",
      ),
    ).toThrow("ARM resource ID");

    expect(() =>
      normalizeInboundAzureResourceRules(
        {
          rules: [
            { displayName: "a", resourceId: RESOURCE_ID_A },
            { displayName: "b", resourceId: RESOURCE_ID_A.toUpperCase() },
          ],
        },
        "networkProtection.inboundAzureResourceRules",
      ),
    ).toThrow("case-ambiguous resourceId");
  });

  it("does not invent undocumented count, display-name length, or name uniqueness limits", () => {
    const displayName = "resource-".repeat(20);
    const rules = Array.from({ length: 257 }, (_, index) => ({
      displayName,
      resourceId: `${RESOURCE_ID_A}-${index}`,
    }));

    expect(
      normalizeInboundAzureResourceRules(
        { rules },
        "networkProtection.inboundAzureResourceRules",
      ).rules,
    ).toHaveLength(257);
  });

  it("does not require inboundAzureResourceRules for inbound Deny, and allows it independently of firewall rules", () => {
    const canonical = normalizeNetworkProtection({
      communicationPolicy: {
        inboundDefaultAction: "Deny",
        outboundDefaultAction: "Allow",
      },
      inboundFirewallRules: {
        rules: [{ displayName: "corporate", value: "12.34.56.78" }],
      },
      inboundAzureResourceRules: { rules: [] },
    });
    expect(canonical.inboundAzureResourceRules).toEqual({ rules: [] });
  });

  it("rejects unknown top-level networkProtection.inboundAzureResourceRules shapes", () => {
    expect(() =>
      normalizeNetworkProtection({
        communicationPolicy: {
          inboundDefaultAction: "Allow",
          outboundDefaultAction: "Allow",
        },
        inboundAzureResourceRules: { rules: [], extra: true } as never,
      }),
    ).toThrow("unsupported property");
  });
});

describe("quoteEtag", () => {
  it("wraps a bare etag in quotes", () => {
    expect(quoteEtag("abc123")).toBe('"abc123"');
  });

  it("leaves an already-quoted etag unchanged", () => {
    expect(quoteEtag('"abc123"')).toBe('"abc123"');
  });
});

describe("NetworkProtectionAdapter GET/PUT", () => {
  it("captures the ETag on GET and parses the nested communication policy body", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse(
          {
            inbound: { publicAccessRules: { defaultAction: "Allow" } },
            outbound: { publicAccessRules: { defaultAction: "Deny" } },
          },
          200,
          { etag: '"policy-etag"' },
        ),
      ),
    );

    const result = await adapter.getCommunicationPolicy(WORKSPACE_ID);

    expect(result.etag).toBe('"policy-etag"');
    expect(result.policy.inbound.publicAccessRules.defaultAction).toBe("Allow");
    expect(result.policy.outbound.publicAccessRules.defaultAction).toBe("Deny");
  });

  it("sends a quoted If-Match header on PUT only when an ETag is available", async () => {
    const requests: Array<{ url: string; headers: Headers; body: unknown }> = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse(
          {
            inbound: { publicAccessRules: { defaultAction: "Allow" } },
            outbound: { publicAccessRules: { defaultAction: "Deny" } },
          },
          200,
          { etag: '"new-etag"' },
        );
      }),
    );

    await adapter.putCommunicationPolicy(WORKSPACE_ID, {
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Deny" } },
    });
    await adapter.putCommunicationPolicy(
      WORKSPACE_ID,
      {
        inbound: { publicAccessRules: { defaultAction: "Allow" } },
        outbound: { publicAccessRules: { defaultAction: "Deny" } },
      },
      { ifMatchEtag: "bare-etag" },
    );

    expect(requests[0]?.url).toMatch(
      /\/v1\/workspaces\/.+\/networking\/communicationPolicy$/,
    );
    expect(requests[0]?.headers.get("if-match")).toBeNull();
    expect(requests[1]?.headers.get("if-match")).toBe('"bare-etag"');
  });

  it("GETs the documented inbound firewall path and captures an optional ETag", async () => {
    const requests: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requests.push(String(input));
        return jsonResponse(
          {
            rules: [
              {
                displayName: "corporate",
                value: "12.34.56.78",
              },
            ],
          },
          200,
          { etag: "firewall-etag" },
        );
      }),
    );

    await expect(
      adapter.getInboundFirewallRules(WORKSPACE_ID),
    ).resolves.toEqual({
      configuration: {
        rules: [
          {
            displayName: "corporate",
            value: "12.34.56.78",
          },
        ],
      },
      etag: "firewall-etag",
    });
    expect(requests[0]).toMatch(
      /\/networking\/communicationPolicy\/inbound\/firewall$/,
    );

    const missingEtag = createAdapter(
      vi.fn(async () => jsonResponse({ rules: [] })),
    );
    await expect(
      missingEtag.getInboundFirewallRules(WORKSPACE_ID),
    ).resolves.toEqual({
      configuration: { rules: [] },
    });
  });

  it.each([200, 204])(
    "PUTs the exact full firewall body with If-Match and accepts documented status %i",
    async (status) => {
      const requests: Array<{
        headers: Headers;
        body: unknown;
      }> = [];
      const adapter = createAdapter(
        vi.fn(async (_input: string | URL, init?: RequestInit) => {
          requests.push({
            headers: new Headers(init?.headers),
            body: JSON.parse(String(init?.body)),
          });
          return new Response(null, {
            status,
            headers: { etag: "updated-firewall-etag" },
          });
        }),
      );
      const desired = {
        rules: [
          {
            displayName: "corporate",
            value: "12.34.56.78",
          },
        ],
      };

      await expect(
        adapter.putInboundFirewallRules(
          WORKSPACE_ID,
          desired,
          { ifMatchEtag: "observed-etag" },
        ),
      ).resolves.toEqual({
        configuration: desired,
        etag: "updated-firewall-etag",
      });
      expect(requests[0]?.headers.get("if-match")).toBe(
        '"observed-etag"',
      );
      expect(requests[0]?.body).toEqual(desired);
    },
  );

  it("fails closed on undocumented firewall PUT response bodies", async () => {
    const desired = {
      rules: [
        {
          displayName: "corporate",
          value: "12.34.56.78",
        },
      ],
    };
    const unexpectedBody = createAdapter(
      vi.fn(async () =>
        jsonResponse(desired, 200, { etag: "updated" }),
      ),
    );
    await expect(
      unexpectedBody.putInboundFirewallRules(
        WORKSPACE_ID,
        desired,
        { ifMatchEtag: "observed" },
      ),
    ).rejects.toThrow("unexpected response body");
  });

  it("omits If-Match and accepts a missing response ETag when the preview API omits it", async () => {
    const requests: Headers[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        requests.push(new Headers(init?.headers));
        return new Response(null, { status: 204 });
      }),
    );
    const desired = {
      rules: [
        {
          displayName: "corporate",
          value: "12.34.56.78",
        },
      ],
    };

    await expect(
      adapter.putInboundFirewallRules(
        WORKSPACE_ID,
        desired,
        {},
      ),
    ).resolves.toEqual({ configuration: desired });
    expect(requests[0]?.get("if-match")).toBeNull();
  });

  it("retries only definitive 429 responses for full firewall replacement", async () => {
    const desired = {
      rules: [
        {
          displayName: "corporate",
          value: "12.34.56.78",
        },
      ],
    };
    const onDispatch = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errorCode: "TooManyRequests" }, 429, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: { etag: "updated" },
        }),
      );
    const adapter = createAdapter(fetchImpl);

    await adapter.putInboundFirewallRules(
      WORKSPACE_ID,
      desired,
      { ifMatchEtag: "observed", onDispatch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDispatch).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      fetchImpl.mock.calls[1]?.[1]?.body,
    );
  });

  it.each([
    ["408", 408],
    ["5xx", 503],
  ])(
    "does not blindly retry ambiguous firewall %s responses",
    async (_label, status) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ errorCode: "ambiguous" }, status),
      );
      const adapter = createAdapter(fetchImpl);

      await expect(
        adapter.putInboundFirewallRules(
          WORKSPACE_ID,
          {
            rules: [
              {
                displayName: "corporate",
                value: "12.34.56.78",
              },
            ],
          },
          { ifMatchEtag: "observed" },
        ),
      ).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not retry an ambiguous firewall transport failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.putInboundFirewallRules(
        WORKSPACE_ID,
        {
          rules: [
            {
              displayName: "corporate",
              value: "12.34.56.78",
            },
          ],
        },
        { ifMatchEtag: "observed" },
      ),
    ).rejects.toThrow("connection reset");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("GETs the documented inbound Azure resource rules path and opportunistically captures an ETag", async () => {
    const requests: string[] = [];
    const resourceId =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/sqlserver";
    const canonicalResourceId = resourceId.toLowerCase();
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requests.push(String(input));
        return jsonResponse(
          {
            rules: [{ displayName: "sql-server", resourceId }],
          },
          200,
          { etag: "azure-resource-etag" },
        );
      }),
    );

    await expect(
      adapter.getInboundAzureResourceRules(WORKSPACE_ID),
    ).resolves.toEqual({
      configuration: {
        rules: [{ displayName: "sql-server", resourceId: canonicalResourceId }],
      },
      etag: "azure-resource-etag",
    });
    expect(requests[0]).toMatch(
      /\/networking\/communicationPolicy\/inbound\/azureResources$/,
    );

    const missingEtag = createAdapter(
      vi.fn(async () => jsonResponse({ rules: [] })),
    );
    await expect(
      missingEtag.getInboundAzureResourceRules(WORKSPACE_ID),
    ).resolves.toEqual({ configuration: { rules: [] } });
  });

  it("PUTs the exact full Azure resource rules body with If-Match and accepts only the documented 200 status", async () => {
    const requests: Array<{ headers: Headers; body: unknown }> = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        requests.push({
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(null, {
          status: 200,
          headers: { etag: "updated-azure-resource-etag" },
        });
      }),
    );
    const desired = {
      rules: [
        {
          displayName: "sql-server",
          resourceId:
            "/subscriptions/00000000-0000-0000-0000-000000000001/resourcegroups/rg/providers/microsoft.sql/servers/sqlserver",
        },
      ],
    };

    await expect(
      adapter.putInboundAzureResourceRules(WORKSPACE_ID, desired, {
        ifMatchEtag: "observed-etag",
      }),
    ).resolves.toEqual({
      configuration: desired,
      etag: "updated-azure-resource-etag",
    });
    expect(requests[0]?.headers.get("if-match")).toBe('"observed-etag"');
    expect(requests[0]?.body).toEqual(desired);
  });

  it("rejects a 204 for Set Inbound Azure Resource Rules because only 200 is documented", async () => {
    const adapter = createAdapter(
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    await expect(
      adapter.putInboundAzureResourceRules(
        WORKSPACE_ID,
        { rules: [] },
        {},
      ),
    ).rejects.toThrow();
  });

  it("fails closed on undocumented Azure resource rules PUT response bodies", async () => {
    const desired = { rules: [] };
    const unexpectedBody = createAdapter(
      vi.fn(async () => jsonResponse(desired, 200, { etag: "updated" })),
    );
    await expect(
      unexpectedBody.putInboundAzureResourceRules(
        WORKSPACE_ID,
        desired,
        { ifMatchEtag: "observed" },
      ),
    ).rejects.toThrow("unexpected response body");
  });

  it("omits If-Match and accepts a missing response ETag for Azure resource rules (undocumented for this surface)", async () => {
    const requests: Headers[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        requests.push(new Headers(init?.headers));
        return new Response(null, { status: 200 });
      }),
    );
    const desired = { rules: [] };

    await expect(
      adapter.putInboundAzureResourceRules(WORKSPACE_ID, desired, {}),
    ).resolves.toEqual({ configuration: desired });
    expect(requests[0]?.get("if-match")).toBeNull();
  });

  it("retries only definitive 429 responses for full Azure resource rules replacement", async () => {
    const desired = { rules: [] };
    const onDispatch = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errorCode: "TooManyRequests" }, 429, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { etag: "updated" } }),
      );
    const adapter = createAdapter(fetchImpl);

    await adapter.putInboundAzureResourceRules(WORKSPACE_ID, desired, {
      ifMatchEtag: "observed",
      onDispatch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["408", 408],
    ["5xx", 503],
  ])(
    "does not blindly retry ambiguous Azure resource rules %s responses",
    async (_label, status) => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ errorCode: "ambiguous" }, status),
      );
      const adapter = createAdapter(fetchImpl);

      await expect(
        adapter.putInboundAzureResourceRules(
          WORKSPACE_ID,
          { rules: [] },
          { ifMatchEtag: "observed" },
        ),
      ).rejects.toMatchObject({ status });
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("retries a throttled communication-policy PUT with the same body", async () => {
    const desired = normalizeNetworkProtection(
      desiredAllowOutbound(),
    ).communicationPolicy;
    const onDispatch = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errorCode: "TooManyRequests" }, 429, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(desired));
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.putCommunicationPolicy(WORKSPACE_ID, desired, {
        onDispatch,
      }),
    ).resolves.toMatchObject({ policy: desired });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDispatch).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      fetchImpl.mock.calls[1]?.[1]?.body,
    );
  });

  it("does not retry an ambiguous outbound-rule PUT failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.putOutboundCloudConnectionRules(WORKSPACE_ID, {
        defaultAction: "Deny",
        rules: [],
      }),
    ).rejects.toThrow("connection reset");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("round-trips outbound cloud connection rules through GET and PUT", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requests.push({ url: String(input), method: init?.method ?? "GET" });
        return jsonResponse({
          defaultAction: "Deny",
          rules: [{ connectionType: "Web", defaultAction: "Allow" }],
        });
      }),
    );

    const observed = await adapter.getOutboundCloudConnectionRules(WORKSPACE_ID);
    expect(observed.rules).toEqual([{ connectionType: "Web", defaultAction: "Allow" }]);

    const applied = await adapter.putOutboundCloudConnectionRules(WORKSPACE_ID, {
      defaultAction: "Deny",
      rules: [],
    });
    expect(applied.defaultAction).toBe("Deny");

    expect(requests[0]?.url).toMatch(
      /\/v1\/workspaces\/.+\/networking\/communicationPolicy\/outbound\/connections$/,
    );
    expect(requests[1]?.method).toBe("PUT");
  });

  it("round-trips outbound gateway rules through GET and PUT", async () => {
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return jsonResponse(JSON.parse(String(init.body)));
        }
        return jsonResponse({
          defaultAction: "Deny",
          allowedGateways: [{ id: GATEWAY_ID_A }],
        });
      }),
    );

    await expect(
      adapter.getOutboundGatewayRules(WORKSPACE_ID),
    ).resolves.toEqual({
      defaultAction: "Deny",
      allowedGateways: [{ id: GATEWAY_ID_A }],
    });
    await expect(
      adapter.putOutboundGatewayRules(WORKSPACE_ID, {
        defaultAction: "Deny",
        allowedGateways: [{ id: GATEWAY_ID_B }],
      }),
    ).resolves.toEqual({
      defaultAction: "Deny",
      allowedGateways: [{ id: GATEWAY_ID_B }],
    });
  });
});

describe("NetworkProtectionAdapter plan", () => {
  it("binds the canonical inbound firewall body, observed hash, ETag, and rule count", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Deny",
        outboundDefaultAction: "Allow",
      },
      inboundFirewallRules: {
        rules: [
          {
            displayName: "corporate",
            value: "12.34.56.78",
          },
        ],
      },
    };
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/inbound/firewall")) {
          return jsonResponse(
            {
              rules: [
                {
                  displayName: "old",
                  value: "8.8.8.8",
                },
              ],
            },
            200,
            { etag: "firewall-etag" },
          );
        }
        return jsonResponse({
          inbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
        });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.plan(WORKSPACE_ID, desired);

    expect(result.communicationPolicy).toMatchObject({
      action: "update",
      observedInboundDefaultAction: "Allow",
      desiredInboundDefaultAction: "Deny",
    });
    expect(result.inboundFirewallRules).toMatchObject({
      action: "update",
      etag: "firewall-etag",
      ruleCount: 1,
      desiredHash: hashInboundFirewallRules(
        normalizeNetworkProtection(desired).inboundFirewallRules!,
      ),
    });
  });

  it("keeps a headerless live firewall response actionable", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundFirewallRules: { rules: [] },
    };
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/inbound/firewall")
          ? jsonResponse({ rules: [] })
          : jsonResponse({
              inbound: {
                publicAccessRules: { defaultAction: "Allow" },
              },
              outbound: {
                publicAccessRules: { defaultAction: "Allow" },
              },
            }),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, desired);

    expect(result.inboundFirewallRules).toMatchObject({
      action: "no-op",
      ruleCount: 0,
      observedStateHash: hashInboundFirewallRules({ rules: [] }),
    });
    expect(result.inboundFirewallRules).not.toHaveProperty("etag");
  });

  it("binds the canonical inbound Azure resource rules body, observed hash, opportunistic ETag, and rule count", async () => {
    const resourceId =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/sqlserver";
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundAzureResourceRules: {
        rules: [{ displayName: "sql-server", resourceId }],
      },
    };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/inbound/azureResources")) {
        return jsonResponse(
          { rules: [] },
          200,
          { etag: "azure-resource-etag" },
        );
      }
      return jsonResponse({
        inbound: { publicAccessRules: { defaultAction: "Allow" } },
        outbound: { publicAccessRules: { defaultAction: "Allow" } },
      });
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.plan(WORKSPACE_ID, desired);

    expect(result.inboundAzureResourceRules).toMatchObject({
      action: "update",
      etag: "azure-resource-etag",
      ruleCount: 1,
      desiredHash: hashInboundAzureResourceRules(
        normalizeNetworkProtection(desired).inboundAzureResourceRules!,
      ),
    });
  });

  it("keeps a headerless live Azure resource rules response actionable", async () => {
    const desired: NetworkProtectionManifest = {
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
      inboundAzureResourceRules: { rules: [] },
    };
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/inbound/azureResources")
          ? jsonResponse({ rules: [] })
          : jsonResponse({
              inbound: { publicAccessRules: { defaultAction: "Allow" } },
              outbound: { publicAccessRules: { defaultAction: "Allow" } },
            }),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, desired);

    expect(result.inboundAzureResourceRules).toMatchObject({
      action: "no-op",
      ruleCount: 0,
      observedStateHash: hashInboundAzureResourceRules({ rules: [] }),
    });
    expect(result.inboundAzureResourceRules).not.toHaveProperty("etag");
  });

  it("reports no-op when the observed policy already matches the desired configuration", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Allow" } },
        }),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredAllowOutbound());

    expect(result.communicationPolicy).toMatchObject({
      action: "no-op",
      observedInboundDefaultAction: "Allow",
      observedOutboundDefaultAction: "Allow",
      desiredInboundDefaultAction: "Allow",
      desiredOutboundDefaultAction: "Allow",
      isRelaxation: false,
    });
    expect(result.outboundCloudConnectionRules).toBeUndefined();
    expect(result.outboundGatewayRules).toBeUndefined();
  });

  it("reports update and isRelaxation for an outbound Deny -> Allow transition", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Deny" } },
        }),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredAllowOutbound());

    expect(result.communicationPolicy).toMatchObject({
      action: "update",
      isRelaxation: true,
    });
  });

  it("reports isRelaxation when inbound is observed Deny even though it is forced back to Allow", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Deny" } },
          outbound: { publicAccessRules: { defaultAction: "Allow" } },
        }),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredAllowOutbound());

    expect(result.communicationPolicy).toMatchObject({
      action: "update",
      isRelaxation: true,
    });
  });

  it("uses the OAP-not-enabled sentinel and skips reading rules when outbound is still Allow", async () => {
    const requestedPaths: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requestedPaths.push(String(input));
        return jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Allow" } },
        });
      }),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredDenyOutboundWithRules());

    expect(result.communicationPolicy.action).toBe("update");
    expect(result.outboundCloudConnectionRules).toMatchObject({ action: "update" });
    expect(result.outboundGatewayRules).toMatchObject({ action: "update" });
    expect(
      requestedPaths.some((path) => path.includes("/outbound/connections")),
    ).toBe(false);
    expect(
      requestedPaths.some((path) => path.includes("/outbound/gateways")),
    ).toBe(false);
  });

  it("reads and compares outbound rules once OAP is already enabled", async () => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/outbound/connections")) {
          return jsonResponse({
            defaultAction: "Deny",
            rules: [
              {
                connectionType: "SQL",
                defaultAction: "Deny",
                allowedEndpoints: [{ hostnamePattern: "*.database.windows.net" }],
              },
              { connectionType: "Web", defaultAction: "Allow" },
            ],
          });
        }
        if (url.includes("/outbound/gateways")) {
          return jsonResponse({
            defaultAction: "Deny",
            allowedGateways: [{ id: GATEWAY_ID_A }, { id: GATEWAY_ID_B }],
          });
        }
        return jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Deny" } },
        });
      }),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredDenyOutboundWithRules());

    expect(result.communicationPolicy.action).toBe("no-op");
    expect(result.outboundCloudConnectionRules).toMatchObject({ action: "no-op" });
    expect(result.outboundGatewayRules).toMatchObject({ action: "no-op" });
  });

  it("reports update when the observed outbound rules differ", async () => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/outbound/connections")) {
          return jsonResponse({ defaultAction: "Allow", rules: [] });
        }
        if (url.includes("/outbound/gateways")) {
          return jsonResponse({ defaultAction: "Deny", allowedGateways: [] });
        }
        return jsonResponse({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Deny" } },
        });
      }),
    );

    const result = await adapter.plan(WORKSPACE_ID, desiredDenyOutboundWithRules());

    expect(result.outboundCloudConnectionRules).toMatchObject({ action: "update" });
    expect(result.outboundGatewayRules).toMatchObject({ action: "update" });
  });

  it("blocks planning when an explicit target workspace is not found", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ errorCode: "WorkspaceNotFound" }, 404),
      ),
    );

    const result = await adapter.plan(WORKSPACE_ID, {
      workspaceId: OTHER_WORKSPACE_ID,
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
    });

    expect(result.communicationPolicy.action).toBe("blocked");
    expect(result.workspaceId).toBe(OTHER_WORKSPACE_ID.toLowerCase());
  });
});

describe("network protection hashing", () => {
  it("produces stable hashes independent of input key order", () => {
    const canonical = normalizeNetworkProtection(desiredDenyOutboundWithRules());
    const hashA = hashCommunicationPolicy(canonical.communicationPolicy);
    const hashB = hashCommunicationPolicy({
      outbound: canonical.communicationPolicy.outbound,
      inbound: canonical.communicationPolicy.inbound,
    });
    expect(hashA).toBe(hashB);
    expect(canonical.outboundCloudConnectionRules).toBeDefined();
    expect(canonical.outboundGatewayRules).toBeDefined();
    if (canonical.outboundCloudConnectionRules) {
      expect(typeof hashOutboundCloudConnectionRules(canonical.outboundCloudConnectionRules)).toBe(
        "string",
      );
    }
    if (canonical.outboundGatewayRules) {
      expect(typeof hashOutboundGatewayRules(canonical.outboundGatewayRules)).toBe("string");
    }
  });

  it("produces a stable hash for inbound Azure resource rules independent of declaration order", () => {
    const resourceIdA =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/storageacct";
    const resourceIdB =
      "/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg/providers/Microsoft.Sql/servers/sqlserver";
    const first = normalizeInboundAzureResourceRules(
      {
        rules: [
          { displayName: "storage", resourceId: resourceIdA },
          { displayName: "sql", resourceId: resourceIdB },
        ],
      },
      "networkProtection.inboundAzureResourceRules",
    );
    const second = normalizeInboundAzureResourceRules(
      {
        rules: [
          { displayName: "sql", resourceId: resourceIdB },
          { displayName: "storage", resourceId: resourceIdA },
        ],
      },
      "networkProtection.inboundAzureResourceRules",
    );
    expect(hashInboundAzureResourceRules(first)).toBe(
      hashInboundAzureResourceRules(second),
    );
  });
});
