import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  buildCreateBody,
  buildUpdateBody,
  DEFAULT_COLLATION_TYPE,
  hashObservedWarehouse,
  WarehouseAdapter,
} from "../src/fabric/warehouse";

const tokenProvider = {
  getToken: async () => "token",
};

function createAdapter(fetchImpl: FetchLike): WarehouseAdapter {
  return new WarehouseAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

describe("Warehouse adapter", () => {
  it("builds creation body with and without optional fields", () => {
    expect(
      buildCreateBody({
        displayName: "Sales",
        description: "Sales data warehouse",
        folderId: "folder-1",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      }),
    ).toEqual({
      displayName: "Sales",
      description: "Sales data warehouse",
      folderId: "folder-1",
      creationPayload: {
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      },
    });

    // omitting collationType → no creationPayload sent (server picks default)
    expect(buildCreateBody({ displayName: "Sales" })).toEqual({
      displayName: "Sales",
    });

    // omitting description and folderId
    expect(
      buildCreateBody({
        displayName: "Sales",
        collationType: "Latin1_General_100_BIN2_UTF8",
      }),
    ).toEqual({
      displayName: "Sales",
      creationPayload: { collationType: "Latin1_General_100_BIN2_UTF8" },
    });
  });

  it("builds metadata update body excluding immutable fields", () => {
    expect(
      buildUpdateBody({
        displayName: "Sales",
        description: "Updated",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      }),
    ).toEqual({
      displayName: "Sales",
      description: "Updated",
    });
    expect(
      buildUpdateBody({
        displayName: "Sales",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      }),
    ).toEqual({ displayName: "Sales" });
  });

  it("plans create from a non-recursive folder-scoped listing", async () => {
    let requestedUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }),
    );

    await expect(
      adapter.plan("workspace", { displayName: "Sales", folderId: "folder-1" }),
    ).resolves.toMatchObject({ action: "create" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/v1/workspaces/workspace/warehouses");
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("rootFolderId")).toBe("folder-1");
  });

  it("plans update and no-op while treating omitted descriptions as unmanaged", async () => {
    const response = {
      id: "wh-1",
      displayName: "Sales",
      description: "Existing",
      properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
    };

    const updateAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [response] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    );
    await expect(
      updateAdapter.plan("workspace", {
        displayName: "Sales",
        description: "Desired",
      }),
    ).resolves.toMatchObject({ action: "update", physicalId: "wh-1" });

    const noopAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [response] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    );
    // omitted description → unmanaged → no-op
    await expect(
      noopAdapter.plan("workspace", { displayName: "Sales" }),
    ).resolves.toMatchObject({ action: "no-op", physicalId: "wh-1" });
  });

  it("blocks immutable collationType drift", async () => {
    const current = {
      id: "wh-1",
      displayName: "Sales",
      properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
    };
    const adapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [current] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );

    await expect(
      adapter.plan("workspace", {
        displayName: "Sales",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "wh-1",
      reason: expect.stringContaining(
        "Fabric does not support changing collationType after creation",
      ),
    });
  });

  it("treats absent API collationType as equivalent to the documented default", async () => {
    // Warehouse created without specifying collationType; GET may omit the field.
    const current = {
      id: "wh-1",
      displayName: "Sales",
      properties: {},
    };
    const adapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [current] }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );

    // Desired omits collationType — should normalise to default and match
    await expect(
      adapter.plan("workspace", { displayName: "Sales" }),
    ).resolves.toMatchObject({ action: "no-op" });
  });

  it("binds the observed hash to managed fields and ignores volatile properties", async () => {
    const planHash = async (
      collationType: string | undefined,
      connectionString: string,
      createdDate: string,
    ) => {
      const current = {
        id: "wh-1",
        displayName: "Sales",
        properties: {
          collationType,
          connectionString,
          createdDate,
          lastUpdatedTime: new Date().toISOString(),
        },
      };
      return createAdapter(
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ value: [current] }), { status: 200 }),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify(current), { status: 200 }),
          ),
      ).plan("workspace", { displayName: "Sales" });
    };

    const base = await planHash(
      "Latin1_General_100_BIN2_UTF8",
      "conn-1.datawarehouse.fabric.microsoft.com",
      "2024-01-01",
    );
    const connChanged = await planHash(
      "Latin1_General_100_BIN2_UTF8",
      "conn-2.datawarehouse.fabric.microsoft.com",
      "2024-01-01",
    );
    const dateChanged = await planHash(
      "Latin1_General_100_BIN2_UTF8",
      "conn-1.datawarehouse.fabric.microsoft.com",
      "2024-06-01",
    );
    const collationChanged = await planHash(
      "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      "conn-1.datawarehouse.fabric.microsoft.com",
      "2024-01-01",
    );

    // connectionString and createdDate are volatile — hash must not change
    expect(base.observedStateHash).toBe(connChanged.observedStateHash);
    expect(base.observedStateHash).toBe(dateChanged.observedStateHash);
    // collationType is managed — hash must change when it differs
    expect(base.observedStateHash).not.toBe(collationChanged.observedStateHash);
  });

  it("rejects ambiguous display-name discovery", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [
              {
                id: "wh-1",
                displayName: "Sales",
                properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
              },
              {
                id: "wh-2",
                displayName: "Sales",
                properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.plan("workspace", { displayName: "Sales" }),
    ).rejects.toThrow("Multiple Warehouses");
  });

  it("creates a Warehouse synchronously (201) and verifies with read-back", async () => {
    const lifecycle: string[] = [];
    let createBody: unknown;
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          lifecycle.push("POST");
          createBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({ id: "wh-1", displayName: "Sales" }),
            { status: 201 },
          );
        }
        if (url.endsWith("/warehouses/wh-1")) {
          return new Response(
            JSON.stringify({
              id: "wh-1",
              displayName: "Sales",
              description: "Sales DW",
              properties: {
                collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
                connectionString:
                  "abc123.datawarehouse.fabric.microsoft.com",
              },
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await adapter.create(
      "workspace",
      {
        displayName: "Sales",
        description: "Sales DW",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      },
      (physicalId) => lifecycle.push(`ACCEPTED:${physicalId}`),
      undefined,
      () => lifecycle.push("SUBMITTING"),
    );

    expect(result.id).toBe("wh-1");
    expect(createBody).toEqual({
      displayName: "Sales",
      description: "Sales DW",
      creationPayload: {
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      },
    });
    expect(lifecycle).toEqual(["SUBMITTING", "POST", "ACCEPTED:wh-1"]);
  });

  it("checkpoints a 202 LRO before polling and resumes it", async () => {
    let now = 0;
    let acceptedOperation: unknown;
    const adapter = new WarehouseAdapter(
      new FabricClient({
        endpoint: "https://api.fabric.microsoft.com",
        scope: "scope",
        tokenProvider,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        fetchImpl: vi.fn(
          async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (init?.method === "POST") {
              return new Response(undefined, {
                status: 202,
                headers: { "x-ms-operation-id": "op-wh-1" },
              });
            }
            if (url.endsWith("/v1/operations/op-wh-1")) {
              return new Response(
                JSON.stringify({ status: "Succeeded" }),
                {
                  status: 200,
                  headers: {
                    location:
                      "https://api.fabric.microsoft.com/v1/operations/op-wh-1/result",
                  },
                },
              );
            }
            if (url.endsWith("/v1/operations/op-wh-1/result")) {
              return new Response(
                JSON.stringify({ id: "wh-1", displayName: "Sales" }),
                { status: 200 },
              );
            }
            if (url.endsWith("/warehouses/wh-1")) {
              return new Response(
                JSON.stringify({
                  id: "wh-1",
                  displayName: "Sales",
                  properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
                }),
                { status: 200 },
              );
            }
            return new Response("not found", { status: 404 });
          },
        ),
      }),
    );

    const created = await adapter.create(
      "workspace",
      { displayName: "Sales" },
      undefined,
      (operation) => {
        acceptedOperation = operation;
      },
    );
    expect(created.id).toBe("wh-1");
    expect(acceptedOperation).toEqual({ operationId: "op-wh-1" });

    const resumed = await adapter.resumeCreate(
      "workspace",
      { displayName: "Sales" },
      { operationId: "op-wh-1" },
    );
    expect(resumed.id).toBe("wh-1");
  });

  it("updates metadata with mutation checkpoint callbacks", async () => {
    const lifecycle: string[] = [];
    let updateBody: unknown;
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          lifecycle.push("PATCH");
          updateBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({ id: "wh-1", displayName: "Sales" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "wh-1",
            displayName: "Sales",
            description: "Updated",
            properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
          }),
          { status: 200 },
        );
      }),
    );

    await adapter.update(
      "workspace",
      "wh-1",
      {
        displayName: "Sales",
        description: "Updated",
        collationType: "Latin1_General_100_BIN2_UTF8",
      },
      () => lifecycle.push("ACCEPTED"),
      () => lifecycle.push("SUBMITTING"),
    );

    expect(updateBody).toEqual({
      displayName: "Sales",
      description: "Updated",
    });
    expect(lifecycle).toEqual(["SUBMITTING", "PATCH", "ACCEPTED"]);
  });

  it("clears create and update intents after definitive rejections", async () => {
    const createLifecycle: string[] = [];
    const createAdapterInstance = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({ errorCode: "Forbidden", message: "Access denied" }),
          { status: 403 },
        ),
      ),
    );
    await expect(
      createAdapterInstance.create(
        "workspace",
        { displayName: "Sales" },
        undefined,
        undefined,
        () => createLifecycle.push("SUBMITTING"),
        () => createLifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(createLifecycle).toEqual(["SUBMITTING", "REJECTED"]);

    const updateLifecycle: string[] = [];
    const updateAdapterInstance = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({ errorCode: "Forbidden", message: "Access denied" }),
          { status: 403 },
        ),
      ),
    );
    await expect(
      updateAdapterInstance.update(
        "workspace",
        "wh-1",
        { displayName: "Sales" },
        undefined,
        () => updateLifecycle.push("SUBMITTING"),
        () => updateLifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateLifecycle).toEqual(["SUBMITTING", "REJECTED"]);
  });

  it("fails verification for folder or collationType drift after create", async () => {
    // Verify that folder placement is checked
    const folderAdapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "wh-1",
            displayName: "Sales",
            folderId: "wrong-folder",
            properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      folderAdapter.verify("workspace", "wh-1", {
        displayName: "Sales",
        folderId: "expected-folder",
      }),
    ).rejects.toThrow("read-back verification failed for folder placement");

    // Verify that collationType is checked (covers creation race)
    const collationAdapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "wh-1",
            displayName: "Sales",
            properties: { collationType: "Latin1_General_100_BIN2_UTF8" },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      collationAdapter.verify("workspace", "wh-1", {
        displayName: "Sales",
        collationType: "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      }),
    ).rejects.toThrow("read-back verification failed");
  });

  it("exposes DEFAULT_COLLATION_TYPE as the documented BIN2 value", () => {
    expect(DEFAULT_COLLATION_TYPE).toBe("Latin1_General_100_BIN2_UTF8");
  });

  it("does not fire onUpdateSubmitting when token acquisition fails before dispatch", async () => {
    // With onDispatch the callback is invoked inside FabricClient.request(),
    // *after* getToken() succeeds and *immediately before* the HTTP call.
    // A token acquisition failure must therefore leave onUpdateSubmitting
    // uncalled so that no ambiguous pending-update entry is written to the
    // checkpoint.
    const lifecycle: string[] = [];
    const adapter = new WarehouseAdapter(
      new FabricClient({
        endpoint: "https://api.fabric.microsoft.com",
        scope: "scope",
        tokenProvider: {
          getToken: async () => {
            throw new Error("Token acquisition failed");
          },
        },
        fetchImpl: vi.fn(), // never reached
        sleep: async () => undefined,
      }),
    );

    await expect(
      adapter.update(
        "workspace",
        "wh-1",
        { displayName: "Sales" },
        () => lifecycle.push("ACCEPTED"),
        () => lifecycle.push("SUBMITTING"),
        () => lifecycle.push("REJECTED"),
      ),
    ).rejects.toThrow("Token acquisition failed");

    // Neither SUBMITTING nor any other callback must have fired
    expect(lifecycle).toEqual([]);
  });

  it("hashObservedWarehouse excludes connectionString and createdDate", () => {
    const base = hashObservedWarehouse({
      id: "wh-1",
      displayName: "Sales",
      properties: {
        connectionString:
          "abc.datawarehouse.fabric.microsoft.com",
        createdDate: "2024-01-01",
        lastUpdatedTime: "2024-06-01",
        collationType: "Latin1_General_100_BIN2_UTF8",
      },
    });
    const changed = hashObservedWarehouse({
      id: "wh-1",
      displayName: "Sales",
      properties: {
        connectionString:
          "xyz.datawarehouse.fabric.microsoft.com",
        createdDate: "2025-01-01",
        lastUpdatedTime: "2025-06-01",
        collationType: "Latin1_General_100_BIN2_UTF8",
      },
    });
    expect(base).toBe(changed);
  });
});
