import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  buildCreateBody,
  buildUpdateBody,
  EventhouseAdapter,
} from "../src/fabric/eventhouse";

const tokenProvider = {
  getToken: async () => "token",
};

function createAdapter(fetchImpl: FetchLike): EventhouseAdapter {
  return new EventhouseAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

describe("Eventhouse adapter", () => {
  it("builds creation and metadata update bodies", () => {
    expect(
      buildCreateBody({
        displayName: "Telemetry",
        description: "Events",
        folderId: "folder-1",
        minimumConsumptionUnits: 2.25,
      }),
    ).toEqual({
      displayName: "Telemetry",
      description: "Events",
      folderId: "folder-1",
      creationPayload: { minimumConsumptionUnits: 2.25 },
    });
    expect(buildCreateBody({ displayName: "Telemetry" })).toEqual({
      displayName: "Telemetry",
      creationPayload: { minimumConsumptionUnits: 0 },
    });
    expect(
      buildUpdateBody({
        displayName: "Telemetry",
        minimumConsumptionUnits: 4.25,
      }),
    ).toEqual({ displayName: "Telemetry" });
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
      adapter.plan("workspace", {
        displayName: "Telemetry",
        folderId: "folder-1",
      }),
    ).resolves.toMatchObject({ action: "create" });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe(
      "/v1/workspaces/workspace/eventhouses",
    );
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("rootFolderId")).toBe("folder-1");
  });

  it("plans update and no-op while treating omitted descriptions as unmanaged", async () => {
    const response = {
      id: "eh-1",
      displayName: "Telemetry",
      description: "Existing",
      properties: { minimumConsumptionUnits: 2.25 },
    };
    const updateAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ value: [response] }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    );
    await expect(
      updateAdapter.plan("workspace", {
        displayName: "Telemetry",
        description: "Desired",
        minimumConsumptionUnits: 2.25,
      }),
    ).resolves.toMatchObject({
      action: "update",
      physicalId: "eh-1",
    });

    const noopAdapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ value: [response] }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(response), { status: 200 }),
        ),
    );
    await expect(
      noopAdapter.plan("workspace", {
        displayName: "Telemetry",
        minimumConsumptionUnits: 2.25,
      }),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "eh-1",
    });
  });

  it("blocks immutable minimum consumption drift", async () => {
    const current = {
      id: "eh-1",
      displayName: "Telemetry",
      properties: { minimumConsumptionUnits: 2.25 },
    };
    const adapter = createAdapter(
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ value: [current] }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(current), { status: 200 }),
        ),
    );

    await expect(
      adapter.plan("workspace", {
        displayName: "Telemetry",
        minimumConsumptionUnits: 4.25,
      }),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "eh-1",
      reason: expect.stringContaining(
        "does not support updating this property after creation",
      ),
    });
  });

  it("binds plans to managed observed state but ignores computed properties", async () => {
    const plan = async (
      minimumConsumptionUnits: number,
      queryServiceUri: string,
    ) => {
      const current = {
        id: "eh-1",
        displayName: "Telemetry",
        properties: {
          minimumConsumptionUnits,
          queryServiceUri,
          databasesItemIds: [queryServiceUri],
        },
      };
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
      ).plan("workspace", {
        displayName: "Telemetry",
        minimumConsumptionUnits,
      });
    };

    const first = await plan(2.25, "https://query-1");
    const computedChange = await plan(2.25, "https://query-2");
    const managedChange = await plan(4.25, "https://query-2");

    expect(first.observedStateHash).toBe(
      computedChange.observedStateHash,
    );
    expect(first.observedStateHash).not.toBe(
      managedChange.observedStateHash,
    );
  });

  it("rejects ambiguous display-name discovery", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [
              {
                id: "eh-1",
                displayName: "Telemetry",
                properties: { minimumConsumptionUnits: 0 },
              },
              {
                id: "eh-2",
                displayName: "Telemetry",
                properties: { minimumConsumptionUnits: 0 },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.plan("workspace", { displayName: "Telemetry" }),
    ).rejects.toThrow("Multiple Eventhouses");
  });

  it("creates an Eventhouse and verifies it with a read-back", async () => {
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
              id: "eh-1",
              displayName: "Telemetry",
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/eventhouses/eh-1")) {
          return new Response(
            JSON.stringify({
              id: "eh-1",
              displayName: "Telemetry",
              description: "Events",
              properties: { minimumConsumptionUnits: 2.25 },
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
        displayName: "Telemetry",
        description: "Events",
        minimumConsumptionUnits: 2.25,
      },
      (physicalId) => lifecycle.push(`ACCEPTED:${physicalId}`),
      undefined,
      () => lifecycle.push("SUBMITTING"),
    );

    expect(result.id).toBe("eh-1");
    expect(createBody).toEqual({
      displayName: "Telemetry",
      description: "Events",
      creationPayload: { minimumConsumptionUnits: 2.25 },
    });
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "POST",
      "ACCEPTED:eh-1",
    ]);
  });

  it("checkpoints a 202 operation before polling and resumes it", async () => {
    let now = 0;
    let acceptedOperation: unknown;
    const adapter = new EventhouseAdapter(
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
                  id: "eh-1",
                  displayName: "Telemetry",
                }),
                { status: 200 },
              );
            }
            if (url.endsWith("/eventhouses/eh-1")) {
              return new Response(
                JSON.stringify({
                  id: "eh-1",
                  displayName: "Telemetry",
                  properties: {
                    minimumConsumptionUnits: 0,
                  },
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
      { displayName: "Telemetry" },
      undefined,
      (operation) => {
        acceptedOperation = operation;
      },
    );
    expect(created.id).toBe("eh-1");
    expect(acceptedOperation).toEqual({
      operationId: "operation-1",
    });

    const resumed = await adapter.resumeCreate(
      "workspace",
      { displayName: "Telemetry" },
      { operationId: "operation-1" },
    );
    expect(resumed.id).toBe("eh-1");
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
            JSON.stringify({
              id: "eh-1",
              displayName: "Telemetry",
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "eh-1",
            displayName: "Telemetry",
            description: "Updated",
            properties: { minimumConsumptionUnits: 2.25 },
          }),
          { status: 200 },
        );
      }),
    );

    await adapter.update(
      "workspace",
      "eh-1",
      {
        displayName: "Telemetry",
        description: "Updated",
        minimumConsumptionUnits: 2.25,
      },
      () => lifecycle.push("ACCEPTED"),
      () => lifecycle.push("SUBMITTING"),
    );

    expect(updateBody).toEqual({
      displayName: "Telemetry",
      description: "Updated",
    });
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "PATCH",
      "ACCEPTED",
    ]);
  });

  it("clears create and update intents after definitive rejections", async () => {
    const createLifecycle: string[] = [];
    const createAdapterInstance = createAdapter(
      vi.fn(async () =>
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
      createAdapterInstance.create(
        "workspace",
        { displayName: "Telemetry" },
        undefined,
        undefined,
        () => createLifecycle.push("SUBMITTING"),
        () => createLifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(createLifecycle).toEqual([
      "SUBMITTING",
      "REJECTED",
    ]);

    const updateLifecycle: string[] = [];
    const updateAdapterInstance = createAdapter(
      vi.fn(async () =>
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
      updateAdapterInstance.update(
        "workspace",
        "eh-1",
        { displayName: "Telemetry" },
        undefined,
        () => updateLifecycle.push("SUBMITTING"),
        () => updateLifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateLifecycle).toEqual([
      "SUBMITTING",
      "REJECTED",
    ]);
  });

  it("fails verification for folder or minimum consumption drift", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "eh-1",
            displayName: "Telemetry",
            folderId: "wrong-folder",
            properties: { minimumConsumptionUnits: 4.25 },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.verify("workspace", "eh-1", {
        displayName: "Telemetry",
        folderId: "expected-folder",
        minimumConsumptionUnits: 2.25,
      }),
    ).rejects.toThrow("read-back verification failed");
  });
});
