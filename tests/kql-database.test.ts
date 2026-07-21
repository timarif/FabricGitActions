import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  buildCreateBody,
  buildUpdateBody,
  type FabricKqlDatabase,
  hashObservedKqlDatabase,
  KqlDatabaseAdapter,
} from "../src/fabric/kql-database";
import type { KqlDatabaseLogicalReferenceMaterialization } from "../src/fabric/logical-references";

const tokenProvider = {
  getToken: async () => "token",
};

const materialized: KqlDatabaseLogicalReferenceMaterialization = {
  creationPayload: {
    databaseType: "ReadWrite",
    parentEventhouseItemId: "eventhouse-1",
  },
  materializedDefinitionHash: "a".repeat(64),
  resolvedBindingsHash: "b".repeat(64),
};

function createAdapter(fetchImpl: FetchLike): KqlDatabaseAdapter {
  return new KqlDatabaseAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

function database(
  overrides: Partial<FabricKqlDatabase> = {},
): FabricKqlDatabase {
  return {
    id: "database-1",
    displayName: "TelemetryDB",
    description: "Existing",
    properties: {
      parentEventhouseItemId: "eventhouse-1",
      databaseType: "ReadWrite",
      queryServiceUri: "https://query",
      ingestionServiceUri: "https://ingest",
    },
    ...overrides,
  };
}

describe("KQL Database adapter", () => {
  it("builds ReadWrite creation and metadata update bodies", () => {
    expect(
      buildCreateBody(
        {
          displayName: "TelemetryDB",
          description: "Events",
          folderId: "folder-1",
          databaseType: "ReadWrite",
        },
        materialized,
      ),
    ).toEqual({
      displayName: "TelemetryDB",
      description: "Events",
      folderId: "folder-1",
      creationPayload: {
        databaseType: "ReadWrite",
        parentEventhouseItemId: "eventhouse-1",
      },
    });
    expect(
      buildUpdateBody({
        displayName: "TelemetryDB",
        description: "Updated",
        databaseType: "ReadWrite",
      }),
    ).toEqual({
      displayName: "TelemetryDB",
      description: "Updated",
    });
  });

  it("plans create from a non-recursive folder-scoped listing", async () => {
    let requestedUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
        });
      }),
    );

    await expect(
      adapter.plan(
        "workspace",
        {
          displayName: "TelemetryDB",
          folderId: "folder-1",
        },
        materialized,
      ),
    ).resolves.toMatchObject({ action: "create" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe(
      "/v1/workspaces/workspace/kqlDatabases",
    );
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("rootFolderId")).toBe("folder-1");
  });

  it("plans update and no-op while omitted descriptions remain unmanaged", async () => {
    const current = database();
    const updateAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [current] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );
    await expect(
      updateAdapter.plan(
        "workspace",
        {
          displayName: "TelemetryDB",
          description: "Desired",
        },
        materialized,
      ),
    ).resolves.toMatchObject({
      action: "update",
      physicalId: "database-1",
    });

    const noopAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [current] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );
    await expect(
      noopAdapter.plan(
        "workspace",
        { displayName: "TelemetryDB" },
        materialized,
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "database-1",
    });
  });

  it("blocks immutable Eventhouse and database type drift", async () => {
    const plan = async (
      properties: FabricKqlDatabase["properties"],
    ) => {
      const current = database({ properties });
      return createAdapter(
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({ value: [current] }),
              { status: 200 },
            ),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify(current), {
              status: 200,
            }),
          ),
      ).plan(
        "workspace",
        { displayName: "TelemetryDB" },
        materialized,
      );
    };

    await expect(
      plan({
        parentEventhouseItemId: "other-eventhouse",
        databaseType: "ReadWrite",
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("does not support re-parenting"),
    });
    await expect(
      plan({
        parentEventhouseItemId: "eventhouse-1",
        databaseType: "Shortcut",
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      reason: expect.stringContaining(
        "does not support changing databaseType",
      ),
    });
  });

  it("binds observed state to managed properties but ignores computed URIs", () => {
    const first = hashObservedKqlDatabase(database());
    const computedChange = hashObservedKqlDatabase(
      database({
        properties: {
          ...database().properties,
          queryServiceUri: "https://query-2",
          ingestionServiceUri: "https://ingest-2",
        },
      }),
    );
    const parentChange = hashObservedKqlDatabase(
      database({
        properties: {
          ...database().properties,
          parentEventhouseItemId: "eventhouse-2",
        },
      }),
    );

    expect(computedChange).toBe(first);
    expect(parentChange).not.toBe(first);
  });

  it("keeps a new database symbolic and blocks an existing one when the parent ID is unavailable", async () => {
    const createAdapterInstance = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
        }),
      ),
    );
    await expect(
      createAdapterInstance.planUnresolvedParent(
        "workspace",
        { displayName: "TelemetryDB" },
        ["eventhouse"],
      ),
    ).resolves.toMatchObject({ action: "create" });

    const current = database();
    const blockedAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ value: [current] }), {
            status: 200,
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );
    await expect(
      blockedAdapter.planUnresolvedParent(
        "workspace",
        { displayName: "TelemetryDB" },
        ["eventhouse"],
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "database-1",
    });
  });

  it("creates a database and verifies the exact parent binding", async () => {
    const lifecycle: string[] = [];
    let createBody: unknown;
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          lifecycle.push("POST");
          createBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "database-1",
              displayName: "TelemetryDB",
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/kqlDatabases/database-1")) {
          return new Response(
            JSON.stringify(
              database({ description: "Events" }),
            ),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const created = await adapter.create(
      "workspace",
      {
        displayName: "TelemetryDB",
        description: "Events",
      },
      materialized,
      (physicalId) => lifecycle.push(`ACCEPTED:${physicalId}`),
      undefined,
      () => lifecycle.push("SUBMITTING"),
    );

    expect(created.id).toBe("database-1");
    expect(createBody).toEqual({
      displayName: "TelemetryDB",
      description: "Events",
      creationPayload: materialized.creationPayload,
    });
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "POST",
      "ACCEPTED:database-1",
    ]);
  });

  it("checkpoints a 202 operation before polling and can resume it", async () => {
    let now = 0;
    let acceptedOperation: unknown;
    const adapter = new KqlDatabaseAdapter(
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
                headers: {
                  "x-ms-operation-id": "operation-1",
                },
              });
            }
            if (url.endsWith("/v1/operations/operation-1")) {
              return new Response(
                JSON.stringify({ status: "Succeeded" }),
                {
                  status: 200,
                  headers: {
                    location:
                      "https://api.fabric.microsoft.com/v1/operations/operation-1/result",
                  },
                },
              );
            }
            if (
              url.endsWith(
                "/v1/operations/operation-1/result",
              )
            ) {
              return new Response(
                JSON.stringify({
                  id: "database-1",
                  displayName: "TelemetryDB",
                }),
                { status: 200 },
              );
            }
            if (url.endsWith("/kqlDatabases/database-1")) {
              return new Response(
                JSON.stringify(database()),
                { status: 200 },
              );
            }
            return new Response("not found", { status: 404 });
          },
        ),
      }),
    );

    await expect(
      adapter.create(
        "workspace",
        { displayName: "TelemetryDB" },
        materialized,
        undefined,
        (operation) => {
          acceptedOperation = operation;
        },
      ),
    ).resolves.toMatchObject({ id: "database-1" });
    expect(acceptedOperation).toEqual({
      operationId: "operation-1",
    });

    await expect(
      adapter.resumeCreate(
        "workspace",
        { displayName: "TelemetryDB" },
        materialized,
        { operationId: "operation-1" },
      ),
    ).resolves.toMatchObject({ id: "database-1" });
  });

  it("updates metadata with checkpoint callbacks and read-back verification", async () => {
    const lifecycle: string[] = [];
    let updateBody: unknown;
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          lifecycle.push("PATCH");
          updateBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "database-1",
              displayName: "TelemetryDB",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify(database({ description: "Updated" })),
          { status: 200 },
        );
      }),
    );

    await adapter.update(
      "workspace",
      "database-1",
      {
        displayName: "TelemetryDB",
        description: "Updated",
      },
      materialized,
      () => lifecycle.push("ACCEPTED"),
      () => lifecycle.push("SUBMITTING"),
    );

    expect(updateBody).toEqual({
      displayName: "TelemetryDB",
      description: "Updated",
    });
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "PATCH",
      "ACCEPTED",
    ]);
  });

  it("rejects ambiguous discovery and incorrect read-back state", async () => {
    const ambiguous = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [
              database(),
              database({ id: "database-2" }),
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      ambiguous.plan(
        "workspace",
        { displayName: "TelemetryDB" },
        materialized,
      ),
    ).rejects.toThrow("Multiple KQL Databases");

    const invalid = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify(
            database({
              properties: {
                parentEventhouseItemId: "wrong-eventhouse",
                databaseType: "ReadWrite",
              },
            }),
          ),
          { status: 200 },
        ),
      ),
    );
    await expect(
      invalid.verify(
        "workspace",
        "database-1",
        { displayName: "TelemetryDB" },
        materialized,
      ),
    ).rejects.toThrow("read-back verification failed");
  });
});
