import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  hashObservedVirtualNetworkGateway,
  normalizeVirtualNetworkGatewayDefinition,
  VirtualNetworkGatewayAdapter,
  type VirtualNetworkGateway,
} from "../src/fabric/virtual-network-gateway";
import type { VirtualNetworkGatewayDefinition } from "../src/types";

const GATEWAY_ID = "11111111-1111-4111-8111-111111111111";
const CAPACITY_ID = "22222222-2222-4222-8222-222222222222";
const SUBSCRIPTION_ID = "33333333-3333-4333-8333-333333333333";

const tokenProvider = {
  getToken: async () => "token",
};

function definition(
  overrides: Partial<VirtualNetworkGatewayDefinition> = {},
): VirtualNetworkGatewayDefinition {
  return {
    logicalId: "managedGateway",
    displayName: "Managed Gateway",
    capacityId: CAPACITY_ID,
    virtualNetworkAzureResource: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroupName: "fabric-network",
      virtualNetworkName: "fabric-vnet",
      subnetName: "fabric-gateway",
    },
    inactivityMinutesBeforeSleep: 30,
    numberOfMemberGateways: 2,
    ...overrides,
  };
}

function gateway(
  overrides: Partial<VirtualNetworkGateway> = {},
): VirtualNetworkGateway {
  return {
    id: GATEWAY_ID,
    type: "VirtualNetwork",
    displayName: "Managed Gateway",
    capacityId: CAPACITY_ID,
    virtualNetworkAzureResource: {
      subscriptionId: SUBSCRIPTION_ID,
      resourceGroupName: "fabric-network",
      virtualNetworkName: "fabric-vnet",
      subnetName: "fabric-gateway",
    },
    inactivityMinutesBeforeSleep: 30,
    numberOfMemberGateways: 2,
    ...overrides,
  };
}

function adapter(fetchImpl: FetchLike): VirtualNetworkGatewayAdapter {
  return new VirtualNetworkGatewayAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("VirtualNetworkGatewayAdapter", () => {
  it("normalizes fixed and ranged scaling and rejects mixed modes", () => {
    expect(
      normalizeVirtualNetworkGatewayDefinition(
        definition({
          numberOfMemberGateways: undefined,
          minMemberGatewayCount: 2,
          maxMemberGatewayCount: 4,
        }),
      ),
    ).toMatchObject({
      minMemberGatewayCount: 2,
      maxMemberGatewayCount: 4,
    });

    expect(() =>
      normalizeVirtualNetworkGatewayDefinition(
        definition({
          minMemberGatewayCount: 1,
          maxMemberGatewayCount: 2,
        }),
      ),
    ).toThrow("cannot combine fixed and range");
    expect(() =>
      normalizeVirtualNetworkGatewayDefinition(
        definition({
          desiredState: "absent",
        }),
      ),
    ).toThrow("requires id");
  });

  it("does not treat the live autoscale member count as configuration drift", () => {
    const ranged = {
      ...gateway(),
      minMemberGatewayCount: 2,
      maxMemberGatewayCount: 4,
    };

    expect(
      hashObservedVirtualNetworkGateway({
        ...ranged,
        numberOfMemberGateways: 2,
      }),
    ).toBe(
      hashObservedVirtualNetworkGateway({
        ...ranged,
        numberOfMemberGateways: 4,
      }),
    );
    expect(
      hashObservedVirtualNetworkGateway(gateway()),
    ).not.toBe(
      hashObservedVirtualNetworkGateway({
        ...gateway(),
        numberOfMemberGateways: 3,
      }),
    );
  });

  it("updates an autoscaling gateway when fixed scaling is requested", async () => {
    const instance = adapter(
      vi.fn(async () =>
        jsonResponse({
          value: [
            gateway({
              minMemberGatewayCount: 1,
              maxMemberGatewayCount: 4,
              numberOfMemberGateways: 2,
            }),
          ],
        }),
      ),
    );

    const plan = await instance.plan(definition());

    expect(plan.action).toBe("update");
  });

  it("lists once when planning multiple name-bound gateways", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ value: [gateway()] }),
    );
    const instance = adapter(fetchImpl);

    const plans = await instance.planAll([
      definition(),
      definition({
        logicalId: "secondGateway",
        displayName: "Second Gateway",
      }),
    ]);

    expect(plans.map((plan) => plan.action)).toEqual([
      "no-op",
      "create",
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("blocks immutable virtual network placement drift", async () => {
    const instance = adapter(
      vi.fn(async () =>
        jsonResponse({
          value: [
            gateway({
              virtualNetworkAzureResource: {
                subscriptionId: SUBSCRIPTION_ID,
                resourceGroupName: "fabric-network",
                virtualNetworkName: "different-vnet",
                subnetName: "fabric-gateway",
              },
            }),
          ],
        }),
      ),
    );

    const plan = await instance.plan(definition());

    expect(plan.action).toBe("blocked");
    expect(plan.reason).toContain("does not support changing gateway placement");
  });

  it("blocks a name collision with a different gateway type", async () => {
    const instance = adapter(
      vi.fn(async () =>
        jsonResponse({
          value: [
            {
              id: GATEWAY_ID,
              type: "OnPremises",
              displayName: "Managed Gateway",
            },
          ],
        }),
      ),
    );

    const plan = await instance.plan(definition());

    expect(plan.action).toBe("blocked");
    expect(plan.reason).toContain(
      "type 'OnPremises', not VirtualNetwork",
    );
  });

  it("creates with the documented body and verifies canonical read-back", async () => {
    const requests: Array<{
      method: string | undefined;
      body: unknown;
    }> = [];
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method,
          body: init?.body
            ? JSON.parse(String(init.body))
            : undefined,
        });
        return init?.method === "POST"
          ? jsonResponse(gateway(), 201)
          : jsonResponse(gateway());
      },
    );
    const onSubmitting = vi.fn();
    const onAccepted = vi.fn();

    const created = await adapter(fetchImpl).create(definition(), {
      onSubmitting,
      onAccepted,
    });

    expect(created.id).toBe(GATEWAY_ID);
    expect(requests[0]).toEqual({
      method: "POST",
      body: {
        type: "VirtualNetwork",
        displayName: "Managed Gateway",
        capacityId: CAPACITY_ID,
        virtualNetworkAzureResource:
          definition().virtualNetworkAzureResource,
        inactivityMinutesBeforeSleep: 30,
        numberOfMemberGateways: 2,
      },
    });
    expect(requests[1]?.method).toBe("GET");
    expect(onSubmitting).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith(GATEWAY_ID);
  });

  it("never redispatches an ambiguous create recovery", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        jsonResponse({ value: [] }),
    );

    await expect(
      adapter(fetchImpl).resumeCreate(definition(), {
        phase: "submitting",
      }),
    ).rejects.toThrow("ambiguous recovery state");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(
      fetchImpl.mock.calls.some(
        ([, init]) => init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("deletes only the explicit gateway ID and verifies absence", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        urls.push(String(input));
        return init?.method === "DELETE"
          ? new Response(undefined, { status: 200 })
          : new Response(undefined, { status: 404 });
      },
    );

    await adapter(fetchImpl).delete(
      GATEWAY_ID,
      definition({
        id: GATEWAY_ID,
        desiredState: "absent",
      }),
    );

    expect(urls).toEqual([
      `https://api.fabric.microsoft.com/v1/gateways/${GATEWAY_ID}`,
      `https://api.fabric.microsoft.com/v1/gateways/${GATEWAY_ID}`,
    ]);
  });
});
