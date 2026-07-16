import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import { LakehouseAdapter } from "../src/fabric/lakehouse";

const tokenProvider = {
  getToken: async () => "token",
};

function createAdapter(fetchImpl: FetchLike): LakehouseAdapter {
  return new LakehouseAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

describe("Lakehouse adapter", () => {
  it("plans create, update, and no-op from live metadata", async () => {
    const createAdapterInstance = createAdapter(
      vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 })),
    );
    await expect(
      createAdapterInstance.plan("workspace", { displayName: "Bronze" }),
    ).resolves.toMatchObject({ action: "create" });

    const updateAdapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                {
                  id: "lh-1",
                  displayName: "Bronze",
                  description: "Old",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      updateAdapter.plan("workspace", {
        displayName: "Bronze",
        description: "New",
      }),
    ).resolves.toMatchObject({ action: "update", physicalId: "lh-1" });

    const noopAdapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                {
                  id: "lh-1",
                  displayName: "Bronze",
                  description: "Same",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      noopAdapter.plan("workspace", {
        displayName: "Bronze",
        description: "Same",
      }),
    ).resolves.toMatchObject({ action: "no-op", physicalId: "lh-1" });
  });

  it("always scopes discovery to a non-recursive folder listing", async () => {
    let requestedUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }),
    );

    await adapter.plan("workspace", { displayName: "Bronze" });

    expect(new URL(requestedUrl).searchParams.get("recursive")).toBe("false");
  });

  it("blocks an existing Lakehouse when schema support cannot be verified", async () => {
    const adapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              value: [{ id: "lh-1", displayName: "Bronze" }],
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "lh-1",
              displayName: "Bronze",
              properties: {},
            }),
            { status: 200 },
          ),
        ),
    );

    await expect(
      adapter.plan("workspace", {
        displayName: "Bronze",
        enableSchemas: true,
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "lh-1",
    });
  });

  it("binds online plans to the observed Lakehouse state", async () => {
    const makeAdapter = (description: string) =>
      createAdapter(
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                value: [
                  {
                    id: "lh-1",
                    displayName: "Bronze",
                    description,
                  },
                ],
              }),
              { status: 200 },
            ),
        ),
      );

    const first = await makeAdapter("First").plan("workspace", {
      displayName: "Bronze",
      description: "Desired",
    });
    const second = await makeAdapter("Second").plan("workspace", {
      displayName: "Bronze",
      description: "Desired",
    });

    expect(first.observedStateHash).not.toBe(second.observedStateHash);
  });

  it("treats an omitted description as unmanaged", async () => {
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                {
                  id: "lh-1",
                  displayName: "Bronze",
                  description: "Keep this description",
                },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      adapter.plan("workspace", { displayName: "Bronze" }),
    ).resolves.toMatchObject({ action: "no-op" });
  });

  it("fails when display-name lookup is ambiguous", async () => {
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                { id: "1", displayName: "Bronze" },
                { id: "2", displayName: "Bronze" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      adapter.plan("workspace", { displayName: "Bronze" }),
    ).rejects.toThrow("Multiple Lakehouses");
  });

  it("creates a Lakehouse and verifies it with a read-back", async () => {
    let createBody: unknown;
    let acceptedId: string | undefined;
    const lifecycle: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        lifecycle.push("POST");
        createBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ id: "lh-1", displayName: "Bronze" }),
          { status: 201 },
        );
      }
      if (url.endsWith("/lakehouses/lh-1")) {
        return new Response(
          JSON.stringify({
            id: "lh-1",
            displayName: "Bronze",
            description: "Raw",
            properties: { defaultSchema: "dbo" },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.create(
      "workspace",
      {
        displayName: "Bronze",
        description: "Raw",
        enableSchemas: true,
      },
      (physicalId) => {
        acceptedId = physicalId;
        lifecycle.push("ACCEPTED");
      },
      undefined,
      () => lifecycle.push("SUBMITTING"),
    );

    expect(result.id).toBe("lh-1");
    expect(acceptedId).toBe("lh-1");
    expect(lifecycle).toEqual(["SUBMITTING", "POST", "ACCEPTED"]);
    expect(createBody).toEqual({
      displayName: "Bronze",
      description: "Raw",
      creationPayload: { enableSchemas: true },
    });
  });

  it("checkpoints a 202 operation reference before polling it", async () => {
    let now = 0;
    let acceptedOperation: unknown;
    const adapter = new LakehouseAdapter(
      new FabricClient({
        endpoint: "https://api.fabric.microsoft.com",
        scope: "scope",
        tokenProvider,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetchImpl: vi.fn(async (_input: string | URL, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Response(undefined, {
              status: 202,
              headers: { "x-ms-operation-id": "operation-1" },
            });
          }
          return new Response(
            JSON.stringify({
              status: "Failed",
              error: { message: "create failed" },
            }),
            { status: 200 },
          );
        }),
      }),
    );

    await expect(
      adapter.create(
        "workspace",
        { displayName: "Bronze" },
        undefined,
        (operation) => {
          acceptedOperation = operation;
        },
      ),
    ).rejects.toThrow("long-running operation failed");

    expect(acceptedOperation).toEqual({ operationId: "operation-1" });
  });

  it("clears a create intent after a definitive Fabric rejection", async () => {
    const lifecycle: string[] = [];
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errorCode: "Forbidden",
              message: "Access denied",
            }),
            { status: 403 },
          ),
      ),
    );

    await expect(
      adapter.create(
        "workspace",
        { displayName: "Bronze" },
        undefined,
        undefined,
        () => lifecycle.push("SUBMITTING"),
        () => lifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lifecycle).toEqual(["SUBMITTING", "REJECTED"]);
  });

  it("resumes an accepted create operation and verifies its result", async () => {
    let now = 0;
    let acceptedId: string | undefined;
    const adapter = new LakehouseAdapter(
      new FabricClient({
        endpoint: "https://api.fabric.microsoft.com",
        scope: "scope",
        tokenProvider,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetchImpl: vi.fn(async (input: string | URL) => {
          const url = String(input);
          if (url.endsWith("/v1/operations/operation-1")) {
            return new Response(JSON.stringify({ status: "Succeeded" }), {
              status: 200,
              headers: {
                location:
                  "https://api.fabric.microsoft.com/v1/operations/operation-1/result",
              },
            });
          }
          if (url.endsWith("/v1/operations/operation-1/result")) {
            return new Response(
              JSON.stringify({ id: "lh-1", displayName: "Bronze" }),
              { status: 200 },
            );
          }
          if (url.endsWith("/lakehouses/lh-1")) {
            return new Response(
              JSON.stringify({ id: "lh-1", displayName: "Bronze" }),
              { status: 200 },
            );
          }
          return new Response("not found", { status: 404 });
        }),
      }),
    );

    const result = await adapter.resumeCreate(
      "workspace",
      { displayName: "Bronze" },
      { operationId: "operation-1" },
      (physicalId) => {
        acceptedId = physicalId;
      },
    );

    expect(result.id).toBe("lh-1");
    expect(acceptedId).toBe("lh-1");
  });

  it("updates Lakehouse metadata and verifies it", async () => {
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        if (init?.method === "PATCH") {
          return new Response(
            JSON.stringify({
              id: "lh-1",
              displayName: "Bronze",
              description: "New",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "lh-1",
            displayName: "Bronze",
            description: "New",
          }),
          { status: 200 },
        );
      }),
    );

    await adapter.update(
      "workspace",
      "lh-1",
      {
        displayName: "Bronze",
        description: "New",
      },
      () => methods.push("ACCEPTED"),
      () => methods.push("SUBMITTING"),
    );

    expect(methods).toEqual(["SUBMITTING", "PATCH", "ACCEPTED", "GET"]);
  });

  it("clears an update intent after a definitive Fabric rejection", async () => {
    const lifecycle: string[] = [];
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errorCode: "Forbidden",
              message: "Access denied",
            }),
            { status: 403 },
          ),
      ),
    );

    await expect(
      adapter.update(
        "workspace",
        "lh-1",
        { displayName: "Bronze" },
        undefined,
        () => lifecycle.push("SUBMITTING"),
        () => lifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(lifecycle).toEqual(["SUBMITTING", "REJECTED"]);
  });

  it("fails verification when the Lakehouse is created in the wrong folder", async () => {
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "lh-1",
              displayName: "Bronze",
              folderId: "wrong-folder",
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      adapter.verify("workspace", "lh-1", {
        displayName: "Bronze",
        folderId: "expected-folder",
      }),
    ).rejects.toThrow("folder placement");
  });
});
