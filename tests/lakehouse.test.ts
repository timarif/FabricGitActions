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
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
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

    const result = await adapter.create("workspace", {
      displayName: "Bronze",
      description: "Raw",
      enableSchemas: true,
    });

    expect(result.id).toBe("lh-1");
    expect(createBody).toEqual({
      displayName: "Bronze",
      description: "Raw",
      creationPayload: { enableSchemas: true },
    });
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

    await adapter.update("workspace", "lh-1", {
      displayName: "Bronze",
      description: "New",
    });

    expect(methods).toEqual(["PATCH", "GET"]);
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
