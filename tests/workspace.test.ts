import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  hashObservedWorkspace,
  WorkspaceAdapter,
  type WorkspaceInfo,
} from "../src/fabric/workspace";

const tokenProvider = {
  getToken: async () => "token",
};

function createAdapter(
  fetchImpl: FetchLike,
  options: ConstructorParameters<typeof WorkspaceAdapter>[1] = {},
): WorkspaceAdapter {
  return new WorkspaceAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
    options,
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("WorkspaceAdapter", () => {
  it("treats an explicit workspace ID as authoritative and does not list by name", async () => {
    const requested: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          description: "Current",
        });
      }),
    );

    const result = await adapter.plan({
      id: "workspace-1",
      displayName: "Managed",
    });

    expect(result).toMatchObject({
      action: "no-op",
      physicalId: "workspace-1",
      managedMetadataMatches: true,
      capacityAssignmentRequired: false,
    });
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatch(/\/v1\/workspaces\/workspace-1$/);
  });

  it("blocks a missing explicit ID rather than adopting or creating by name", async () => {
    const requested: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requested.push(String(input));
        return jsonResponse(
          { errorCode: "ItemNotFound", message: "Not found" },
          404,
        );
      }),
    );

    await expect(
      adapter.plan({
        id: "missing",
        displayName: "Managed",
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "missing",
    });
    expect(requested).toHaveLength(1);
  });

  it("paginates discovery and blocks case-insensitive name collisions", async () => {
    const requested: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("continuationToken=next")) {
          return jsonResponse({
            value: [
              {
                id: "workspace-2",
                type: "Workspace",
                displayName: "managed",
              },
            ],
          });
        }
        return jsonResponse({
          value: [
            {
              id: "workspace-1",
              type: "Workspace",
              displayName: "Managed",
            },
          ],
          continuationToken: "next",
          continuationUri:
            "https://api.fabric.microsoft.com/v1/workspaces?continuationToken=next",
        });
      }),
    );

    const result = await adapter.plan({ displayName: "Managed" });

    expect(result).toMatchObject({ action: "blocked" });
    expect(result.reason).toContain("case-insensitive");
    expect(requested).toHaveLength(2);
  });

  it.each(["Personal", "AdminWorkspace", "FutureWorkspaceType"])(
    "blocks an exact-name collision with unsupported type %s",
    async (type) => {
      const adapter = createAdapter(
        vi.fn(async () =>
          jsonResponse({
            value: [{ id: "collision", type, displayName: "Managed" }],
          }),
        ),
      );

      await expect(
        adapter.plan({ displayName: "Managed" }),
      ).resolves.toMatchObject({
        action: "blocked",
        physicalId: "collision",
      });
    },
  );

  it("creates without inline capacity, checkpoints lifecycle in dispatch order, and verifies assignment", async () => {
    let now = 0;
    let createBody: unknown;
    let assignmentBody: unknown;
    let capacityReads = 0;
    const lifecycle: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST" && url.endsWith("/v1/workspaces")) {
          lifecycle.push("CREATE_POST");
          createBody = JSON.parse(String(init.body));
          return jsonResponse(
            {
              id: "workspace-1",
              type: "Workspace",
              displayName: "Managed",
            },
            201,
          );
        }
        if (
          init?.method === "POST" &&
          url.endsWith("/workspace-1/assignToCapacity")
        ) {
          lifecycle.push("CAPACITY_POST");
          assignmentBody = JSON.parse(String(init.body));
          return new Response(undefined, { status: 202 });
        }
        if (url.endsWith("/v1/workspaces/workspace-1")) {
          capacityReads += 1;
          return jsonResponse({
            id: "workspace-1",
            type: "Workspace",
            displayName: "Managed",
            description: "Deployment workspace",
            capacityId:
              capacityReads === 1 ? "old-capacity" : "capacity-1",
            capacityAssignmentProgress:
              capacityReads === 1 ? "InProgress" : "Completed",
          });
        }
        return new Response("not found", { status: 404 });
      },
    );
    const adapter = createAdapter(fetchImpl, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      capacityAssignmentPollIntervalMs: 10,
      capacityAssignmentTimeoutMs: 100,
    });

    const result = await adapter.create(
      {
        displayName: "Managed",
        description: "Deployment workspace",
        capacityId: "capacity-1",
      },
      {
        onCreateSubmitting: () => lifecycle.push("CREATE_SUBMITTING"),
        onCreateAccepted: (id) =>
          lifecycle.push(`CREATE_ACCEPTED:${id}`),
        onCapacityAssignmentSubmitting: (_workspaceId, capacityId) =>
          lifecycle.push(`CAPACITY_SUBMITTING:${capacityId}`),
        onCapacityAssignmentAccepted: (_workspaceId, capacityId) =>
          lifecycle.push(`CAPACITY_ACCEPTED:${capacityId}`),
      },
    );

    expect(result.capacityId).toBe("capacity-1");
    expect(createBody).toEqual({
      displayName: "Managed",
      description: "Deployment workspace",
    });
    expect(assignmentBody).toEqual({ capacityId: "capacity-1" });
    expect(lifecycle).toEqual([
      "CREATE_SUBMITTING",
      "CREATE_POST",
      "CREATE_ACCEPTED:workspace-1",
      "CAPACITY_SUBMITTING:capacity-1",
      "CAPACITY_POST",
      "CAPACITY_ACCEPTED:capacity-1",
    ]);
  });

  it("invokes the definitive create rejection callback but does not retry the mutation", async () => {
    const lifecycle: string[] = [];
    const fetchImpl = vi.fn(
      async () =>
        jsonResponse(
          { errorCode: "Forbidden", message: "Access denied" },
          403,
        ),
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.create(
        { displayName: "Managed" },
        {
          onCreateSubmitting: () => lifecycle.push("SUBMITTING"),
          onCreateRejected: () => lifecycle.push("REJECTED"),
        },
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lifecycle).toEqual(["SUBMITTING", "REJECTED"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("patches only differing managed metadata and leaves omitted fields unmanaged", async () => {
    const lifecycle: string[] = [];
    let patchBody: unknown;
    let getCount = 0;
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          lifecycle.push("PATCH");
          patchBody = JSON.parse(String(init.body));
          return jsonResponse(
            {
              id: "workspace-1",
              type: "Workspace",
              displayName: "Managed",
            },
            200,
          );
        }
        getCount += 1;
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: getCount === 1 ? "Old name" : "Managed",
          description: "Keep unmanaged description",
        });
      }),
    );

    await adapter.update(
      "workspace-1",
      { displayName: "Managed" },
      {
        onMetadataUpdateSubmitting: () =>
          lifecycle.push("SUBMITTING"),
        onMetadataUpdateAccepted: () => lifecycle.push("ACCEPTED"),
      },
    );

    expect(patchBody).toEqual({ displayName: "Managed" });
    expect(lifecycle).toEqual(["SUBMITTING", "PATCH", "ACCEPTED"]);
  });

  it("rejects newly observed mutations outside the approved mask", async () => {
    const methods: string[] = [];
    const metadataAdapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Drifted",
        });
      }),
    );

    await expect(
      metadataAdapter.update(
        "workspace-1",
        { displayName: "Managed" },
        {},
        {
          metadataUpdate: false,
          capacityAssignment: false,
        },
      ),
    ).rejects.toThrow("not approved for update");
    expect(methods).toEqual(["GET"]);

    const capacityMethods: string[] = [];
    const capacityAdapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        capacityMethods.push(init?.method ?? "GET");
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          capacityId: "other-capacity",
          capacityAssignmentProgress: "Completed",
        });
      }),
    );
    await expect(
      capacityAdapter.update(
        "workspace-1",
        {
          displayName: "Managed",
          capacityId: "capacity-1",
        },
        {},
        {
          metadataUpdate: false,
          capacityAssignment: false,
        },
      ),
    ).rejects.toThrow("redispatch is not allowed");
    expect(capacityMethods).toEqual(["GET"]);
  });

  it("dispatches a fresh assignment after a failed assignment to a different capacity", async () => {
    let getCount = 0;
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        methods.push(init?.method ?? "GET");
        if (url.endsWith("/assignToCapacity")) {
          return new Response(undefined, { status: 202 });
        }
        getCount += 1;
        if (getCount === 1) {
          return jsonResponse({
            id: "workspace-1",
            type: "Workspace",
            displayName: "Managed",
            capacityId: "old-capacity",
            capacityAssignmentProgress: "Failed",
          });
        }
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          capacityId: "capacity-1",
          capacityAssignmentProgress: "Completed",
        });
      }),
    );

    await adapter.update("workspace-1", {
      displayName: "Managed",
      capacityId: "capacity-1",
    });

    expect(methods.filter((method) => method === "POST")).toHaveLength(1);
  });

  it("polls an existing in-progress desired assignment without redispatching it", async () => {
    let now = 0;
    let getCount = 0;
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        getCount += 1;
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          capacityId: "capacity-1",
          capacityAssignmentProgress:
            getCount < 3 ? "InProgress" : "Completed",
        });
      }),
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        capacityAssignmentPollIntervalMs: 5,
        capacityAssignmentTimeoutMs: 100,
      },
    );

    await adapter.update("workspace-1", {
      displayName: "Managed",
      capacityId: "capacity-1",
    });

    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("resumes an accepted in-progress assignment without redispatching", async () => {
    let now = 0;
    let getCount = 0;
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        getCount += 1;
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          capacityId:
            getCount < 3 ? "old-capacity" : "capacity-1",
          capacityAssignmentProgress:
            getCount < 3 ? "InProgress" : "Completed",
        });
      }),
      {
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        capacityAssignmentPollIntervalMs: 5,
        capacityAssignmentTimeoutMs: 100,
      },
    );

    const result = await adapter.resumeUpdate(
      "workspace-1",
      {
        displayName: "Managed",
        capacityId: "capacity-1",
      },
      { phase: "capacity-assignment-accepted" },
    );

    expect(result.capacityId).toBe("capacity-1");
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("does not redispatch an ambiguously recovered metadata update", async () => {
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Old name",
        });
      }),
    );

    await expect(
      adapter.resumeUpdate(
        "workspace-1",
        { displayName: "Managed" },
        { phase: "metadata-update-accepted" },
      ),
    ).rejects.toThrow("ambiguous recovery state");
    expect(methods).toEqual(["GET"]);
  });

  it.each(["Failed", "Queued"])(
    "fails closed for %s progress on the desired capacity",
    async (capacityAssignmentProgress) => {
      const workspace = {
        id: "workspace-1",
        type: "Workspace",
        displayName: "Managed",
        capacityId: "capacity-1",
        capacityAssignmentProgress,
      };
      const planAdapter = createAdapter(
        vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse({ value: [workspace] }),
          )
          .mockResolvedValueOnce(jsonResponse(workspace)),
      );

      await expect(
        planAdapter.plan({
          displayName: "Managed",
          capacityId: "capacity-1",
        }),
      ).resolves.toMatchObject({ action: "blocked" });

      const updateAdapter = createAdapter(
        vi.fn(async () => jsonResponse(workspace)),
      );
      await expect(
        updateAdapter.update("workspace-1", {
          displayName: "Managed",
          capacityId: "capacity-1",
        }),
      ).rejects.toThrow(/Failed|unknown/);
    },
  );

  it("plans no-op when all managed fields match and ignores unmanaged capacity state", async () => {
    const workspace = {
      id: "workspace-1",
      type: "Workspace",
      displayName: "Managed",
      description: "Unmanaged description",
      capacityId: "capacity-1",
      capacityAssignmentProgress: "Failed",
    };
    const adapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ value: [workspace] }))
        .mockResolvedValueOnce(jsonResponse(workspace)),
    );

    await expect(
      adapter.plan({ displayName: "Managed" }),
    ).resolves.toMatchObject({
      action: "no-op",
      managedMetadataMatches: true,
      capacityAssignmentRequired: false,
    });
  });

  it("fails verification for metadata drift and non-completed desired capacity", async () => {
    const metadataAdapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Drifted",
        }),
      ),
    );
    await expect(
      metadataAdapter.verify("workspace-1", {
        displayName: "Managed",
      }),
    ).rejects.toThrow("managed metadata");

    const capacityAdapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          id: "workspace-1",
          type: "Workspace",
          displayName: "Managed",
          capacityId: "capacity-1",
          capacityAssignmentProgress: "InProgress",
        }),
      ),
    );
    await expect(
      capacityAdapter.verify("workspace-1", {
        displayName: "Managed",
        capacityId: "capacity-1",
      }),
    ).rejects.toThrow("expected 'capacity-1' with progress 'Completed'");
  });

  it("hashes stable workspace state while excluding derived and progress fields", () => {
    const first: WorkspaceInfo = {
      id: "workspace-1",
      type: "Workspace",
      displayName: "Managed",
      description: undefined,
      capacityId: "capacity-1",
      domainId: "domain-1",
      capacityRegion: "East US",
      apiEndpoint: "https://first.example",
      capacityAssignmentProgress: "InProgress",
      workspaceIdentity: {
        applicationId: "application-1",
        servicePrincipalId: "principal-1",
      },
      oneLakeEndpoints: {
        blobEndpoint: "https://first.blob.example",
        dfsEndpoint: "https://first.dfs.example",
      },
      tags: [
        { id: "tag-2", displayName: "Second" },
        { id: "tag-1", displayName: "First" },
      ],
    };
    const second: WorkspaceInfo = {
      ...first,
      capacityRegion: "West US",
      apiEndpoint: "https://second.example",
      capacityAssignmentProgress: "Completed",
      workspaceIdentity: {
        applicationId: "application-2",
        servicePrincipalId: "principal-2",
      },
      oneLakeEndpoints: {
        blobEndpoint: "https://second.blob.example",
        dfsEndpoint: "https://second.dfs.example",
      },
      tags: [...(first.tags ?? [])].reverse(),
    };

    expect(hashObservedWorkspace(first)).toBe(
      hashObservedWorkspace(second),
    );
    expect(
      hashObservedWorkspace({ ...second, domainId: "domain-2" }),
    ).not.toBe(hashObservedWorkspace(first));
  });

  it("validates managed workspace input limits and nonblank IDs", async () => {
    const adapter = createAdapter(vi.fn());

    await expect(
      adapter.plan({ displayName: "   " }),
    ).rejects.toThrow("nonblank");
    await expect(
      adapter.plan({ displayName: "Admin monitoring" }),
    ).rejects.toThrow("reserved");
    await expect(
      adapter.plan({
        displayName: "Managed",
        description: "x".repeat(4001),
      }),
    ).rejects.toThrow("4000");
    await expect(
      adapter.plan({ id: " ", displayName: "Managed" }),
    ).rejects.toThrow("workspace ID must be nonblank");
    await expect(
      adapter.plan({
        displayName: "Managed",
        capacityId: " ",
      }),
    ).rejects.toThrow("capacity ID must be nonblank");
  });

  it("does not expose delete or unassign operations", () => {
    const adapter = createAdapter(vi.fn());
    expect("delete" in adapter).toBe(false);
    expect("unassign" in adapter).toBe(false);
    expect("unassignFromCapacity" in adapter).toBe(false);
  });
});
