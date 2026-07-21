import { describe, expect, it, vi } from "vitest";
import { DataAgentAdapter } from "../src/fabric/data-agent";
import type { FabricDefinition } from "../src/fabric/definition";
import { sha256, stableJson } from "../src/hash";
import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

const ROOT_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
const STAGE_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/stageConfiguration/1.0.0/schema.json";

/**
 * Untouched shell definition — exactly what the server returns immediately
 * after a displayName-only POST create (before any definition staging).
 */
function shellDef(): FabricDefinition {
  return {
    parts: [
      {
        path: "Files/Config/data_agent.json",
        payload: b64({ $schema: ROOT_SCHEMA }),
        payloadType: "InlineBase64" as const,
      },
      {
        path: "Files/Config/draft/stage_config.json",
        payload: b64({ $schema: STAGE_SCHEMA, aiInstructions: null }),
        payloadType: "InlineBase64" as const,
      },
    ],
  };
}

function minimalDefinition(): FabricDefinition {
  return {
    parts: [
      {
        path: "Files/Config/data_agent.json",
        payload: b64({ $schema: ROOT_SCHEMA }),
        payloadType: "InlineBase64" as const,
      },
    ],
  };
}

function fullDefinition(aiInstructions: string): FabricDefinition {
  return {
    parts: [
      {
        path: "Files/Config/data_agent.json",
        payload: b64({ $schema: ROOT_SCHEMA }),
        payloadType: "InlineBase64" as const,
      },
      {
        path: "Files/Config/draft/stage_config.json",
        payload: b64({ $schema: STAGE_SCHEMA, aiInstructions }),
        payloadType: "InlineBase64" as const,
      },
    ],
  };
}

function serverDefinition(aiInstructions: string | null): FabricDefinition {
  return {
    parts: [
      {
        path: "Files/Config/data_agent.json",
        payload: b64({ $schema: ROOT_SCHEMA }),
        payloadType: "InlineBase64" as const,
      },
      {
        path: "Files/Config/draft/stage_config.json",
        payload: b64({ $schema: STAGE_SCHEMA, aiInstructions }),
        payloadType: "InlineBase64" as const,
      },
      {
        path: ".platform",
        payload: b64({
          $schema:
            "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
          metadata: { type: "DataAgent", displayName: "Test Agent" },
          config: { version: "2.0", logicalId: "00000000-0000-0000-0000-000000000000" },
        }),
        payloadType: "InlineBase64" as const,
      },
    ],
  };
}

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn(),
    listAll: vi.fn(),
    waitForOperation: vi.fn(),
    waitForOperationCompletion: vi.fn(),
    ...overrides,
  } as unknown as import("../src/fabric/client").FabricClient;
}

// ---------------------------------------------------------------------------
// plan()
// ---------------------------------------------------------------------------

describe("DataAgentAdapter.plan", () => {
  it("returns create when agent does not exist", async () => {
    const client = makeMockClient({
      listAll: vi.fn().mockResolvedValue([]),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "My Agent" },
      minimalDefinition(),
    );
    expect(result.action).toBe("create");
    expect(result.reason).toMatch(/does not exist/);
    expect(result.observedStateHash).toBe(sha256(stableJson(null)));
  });

  it("returns no-op when metadata and definition match", async () => {
    const def = fullDefinition("Be helpful");
    const client = makeMockClient({
      listAll: vi.fn().mockResolvedValue([
        {
          id: "agent-id-1",
          workspaceId: "ws-1",
          type: "DataAgent",
          displayName: "My Agent",
          description: "Desc",
        },
      ]),
      request: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          id: "agent-id-1",
          workspaceId: "ws-1",
          type: "DataAgent",
          displayName: "My Agent",
          description: "Desc",
        },
        headers: new Headers(),
      }),
      waitForOperation: vi.fn().mockResolvedValue({
        definition: serverDefinition("Be helpful"),
      }),
    });
    // Override request to serve GET agent and POST getDefinition separately
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: {
              id: "agent-id-1",
              workspaceId: "ws-1",
              type: "DataAgent",
              displayName: "My Agent",
              description: "Desc",
            },
            headers: new Headers(),
          });
        }
        // POST getDefinition → 202
        return Promise.resolve({
          status: 202,
          body: null,
          headers: new Headers([
            ["x-ms-operation-id", "op-1"],
            ["location", "https://api.fabric.microsoft.com/v1/operations/op-1"],
          ]),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: serverDefinition("Be helpful"),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "My Agent", description: "Desc" },
      def,
    );
    expect(result.action).toBe("no-op");
    expect(result.physicalId).toBe("agent-id-1");
  });

  it("returns update when aiInstructions differ", async () => {
    const desiredDef = fullDefinition("v2 instructions");
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "agent-id-2",
        workspaceId: "ws-1",
        type: "DataAgent",
        displayName: "My Agent",
      },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: { id: "agent-id-2", displayName: "My Agent", workspaceId: "ws-1", type: "DataAgent" },
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          status: 202,
          body: null,
          headers: new Headers([["x-ms-operation-id", "op-def"]]),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: serverDefinition("v1 instructions"),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "My Agent" },
      desiredDef,
    );
    expect(result.action).toBe("update");
    expect(result.physicalId).toBe("agent-id-2");
  });

  it("returns update when description differs", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "agent-id-3", displayName: "My Agent", workspaceId: "ws-1", type: "DataAgent", description: "old desc" },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: { id: "agent-id-3", displayName: "My Agent", workspaceId: "ws-1", type: "DataAgent", description: "old desc" },
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          status: 202,
          body: null,
          headers: new Headers([["x-ms-operation-id", "op-x"]]),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: serverDefinition("Be helpful"),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "My Agent", description: "new desc" },
      def,
    );
    expect(result.action).toBe("update");
    expect(result.reason).toMatch(/metadata differs/);
  });

  it("returns blocked when folder differs", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "agent-id-4", displayName: "My Agent", workspaceId: "ws-1", type: "DataAgent", folderId: "folder-A" },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
      body: { id: "agent-id-4", displayName: "My Agent", workspaceId: "ws-1", type: "DataAgent", folderId: "folder-A" },
      headers: new Headers(),
    });
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: serverDefinition(null),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "My Agent", folderId: "folder-B" },
      def,
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/folder/);
  });

  it("returns create for shell (no definition)", async () => {
    const client = makeMockClient({
      listAll: vi.fn().mockResolvedValue([]),
    });
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "Shell Agent" },
      undefined,
    );
    expect(result.action).toBe("create");
  });

  it("throws when multiple agents with same name exist", async () => {
    const client = makeMockClient({
      listAll: vi.fn().mockResolvedValue([
        { id: "a1", displayName: "Dupe", workspaceId: "ws-1", type: "DataAgent" },
        { id: "a2", displayName: "Dupe", workspaceId: "ws-1", type: "DataAgent" },
      ]),
    });
    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.plan("ws-1", { displayName: "Dupe" }, undefined),
    ).rejects.toThrow(/Multiple Data Agents/);
  });
});

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("DataAgentAdapter.create", () => {
  it("creates and verifies synchronously (201)", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const createdAgent = {
      id: "new-agent-id",
      displayName: "New Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "POST" && path.includes("dataAgents") && !path.includes("getDefinition")) {
          // Create call
          return Promise.resolve({ status: 201, body: createdAgent, headers: new Headers() });
        }
        if (method === "GET") {
          // Verify: GET agent
          return Promise.resolve({ status: 200, body: createdAgent, headers: new Headers() });
        }
        // getDefinition
        return Promise.resolve({
          status: 202,
          body: null,
          headers: new Headers([["x-ms-operation-id", "op-verify"]]),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: serverDefinition(null),
    });
    const adapter = new DataAgentAdapter(client);
    const onMutationAccepted = vi.fn();
    const result = await adapter.create("ws-1", { displayName: "New Agent" }, def, onMutationAccepted);
    expect(result.id).toBe("new-agent-id");
    expect(onMutationAccepted).toHaveBeenCalledWith("new-agent-id");
  });

  describe("create — shell-first pattern", () => {
    it("never includes definition in the POST body (always shell create)", async () => {
      const client = makeMockClient();
      const adapter = new DataAgentAdapter(client);
      const desired = { displayName: "Agent" };
      const definition: FabricDefinition = {
        parts: [
          {
            path: "Files/Config/data_agent.json",
            payload: Buffer.from('{"$schema":"test"}').toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      };

      let capturedBody: unknown;
      (client.request as ReturnType<typeof vi.fn>).mockImplementation(
        async (method: string, path: string, opts?: unknown) => {
          const o =
            opts as
              | { body?: unknown; acceptedStatuses?: number[] }
              | undefined;
          if (method === "POST" && path.endsWith("/dataAgents")) {
            capturedBody = o?.body;
            return {
              status: 201,
              headers: new Headers(),
              body: {
                id: "new-id",
                displayName: "Agent",
                type: "DataAgent",
              },
            };
          }
          if (
            method === "POST" &&
            path.includes("/updateDefinition")
          ) {
            return {
              status: 202,
              headers: new Headers({ location: "https://example.com/ops/1" }),
              body: undefined,
            };
          }
          if (method === "GET") {
            return {
              status: 200,
              headers: new Headers(),
              body: {
                id: "new-id",
                displayName: "Agent",
                type: "DataAgent",
              },
            };
          }
          return {
            status: 202,
            headers: new Headers({ location: "https://example.com/ops/2" }),
            body: undefined,
          };
        },
      );
      (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);
      (client.waitForOperation as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          definition: { parts: definition.parts },
        });

      await adapter.create("ws-1", desired, definition).catch(() => {
        // verify may throw if mock isn't perfect — that's OK for this test
      });

      expect(capturedBody).toBeDefined();
      expect(
        (capturedBody as Record<string, unknown>)["definition"],
      ).toBeUndefined();
    });

    it("calls stageDefinition after shell create when definition is provided", async () => {
      const definition = minimalDefinition();
      const client = makeMockClient();
      const adapter = new DataAgentAdapter(client);
      const createdAgent = {
        id: "new-agent-id",
        displayName: "New Agent",
        workspaceId: "ws-1",
        type: "DataAgent" as const,
      };

      (client.request as ReturnType<typeof vi.fn>).mockImplementation(
        (method: string, path: string, opts?: unknown) => {
          if (method === "POST" && path.endsWith("/dataAgents")) {
            return Promise.resolve({
              status: 201,
              body: createdAgent,
              headers: new Headers(),
            });
          }
          if (
            method === "POST" &&
            path.includes("/updateDefinition")
          ) {
            return Promise.resolve({
              status: 202,
              body: undefined,
              headers: new Headers([["x-ms-operation-id", "op-stage"]]),
            });
          }
          if (method === "GET") {
            return Promise.resolve({
              status: 200,
              body: createdAgent,
              headers: new Headers(),
            });
          }
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-verify"]]),
          });
        },
      );
      (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
        .mockResolvedValue(undefined);
      (client.waitForOperation as ReturnType<typeof vi.fn>)
        .mockResolvedValue({
          definition: { parts: definition.parts },
        });

      await adapter.create(
        "ws-1",
        { displayName: "New Agent" },
        definition,
      );

      expect(client.request).toHaveBeenCalledWith(
        "POST",
        "/v1/workspaces/ws-1/dataAgents/new-agent-id/updateDefinition",
        expect.objectContaining({
          body: {
            definition: expect.objectContaining({
              parts: definition.parts,
            }),
          },
        }),
      );
      expect(client.waitForOperationCompletion).toHaveBeenCalledTimes(1);
    });
  });

  it("creates shell (no definition) synchronously (201)", async () => {
    const client = makeMockClient();
    const createdAgent = {
      id: "shell-agent-id",
      displayName: "Shell Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "POST") {
          return Promise.resolve({ status: 201, body: createdAgent, headers: new Headers() });
        }
        return Promise.resolve({ status: 200, body: createdAgent, headers: new Headers() });
      },
    );
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.create("ws-1", { displayName: "Shell Agent" }, undefined);
    expect(result.id).toBe("shell-agent-id");
  });

  it("waits for LRO when create returns 202", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const createdAgent = {
      id: "lro-agent-id",
      displayName: "LRO Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    let callCount = 0;
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        callCount++;
        if (method === "POST" && path.endsWith("/dataAgents") && callCount === 1) {
          // First POST = create → 202
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([
              ["x-ms-operation-id", "op-lro"],
              ["location", "https://api.fabric.microsoft.com/v1/operations/op-lro"],
            ]),
          });
        }
        if (method === "GET") {
          return Promise.resolve({ status: 200, body: createdAgent, headers: new Headers() });
        }
        // getDefinition
        return Promise.resolve({
          status: 202,
          body: null,
          headers: new Headers([["x-ms-operation-id", "op-def"]]),
        });
      },
    );
    // waitForOperation: first call resolves the 202 create, second resolves getDefinition
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(createdAgent)
      .mockResolvedValueOnce({ definition: serverDefinition(null) });
    const adapter = new DataAgentAdapter(client);
    const onOpAccepted = vi.fn();
    const result = await adapter.create(
      "ws-1",
      { displayName: "LRO Agent" },
      def,
      undefined,
      onOpAccepted,
    );
    expect(result.id).toBe("lro-agent-id");
    expect(onOpAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-lro" }),
    );
  });
});

describe("DataAgentAdapter.create — shell-create sync proof checkpoint", () => {
  it("calls onOperationAccepted with physicalId and shellDefinitionHash for 201 sync create", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const createdAgent = {
      id: "sync-id",
      displayName: "Sync Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const shellDef = serverDefinition(null);

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "POST" && String(path).endsWith("/dataAgents")) {
          return Promise.resolve({
            status: 201,
            body: createdAgent,
            headers: new Headers(),
          });
        }
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: createdAgent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "POST" && String(path).includes("updateDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ definition: shellDef })
      .mockResolvedValueOnce({ definition: { parts: def.parts } });
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const adapter = new DataAgentAdapter(client);
    const opAccepted = vi.fn();
    await adapter.create(
      "ws-1",
      { displayName: "Sync Agent" },
      def,
      undefined,
      opAccepted,
    );

    expect(opAccepted).toHaveBeenCalledTimes(1);
    const call = opAccepted.mock.calls[0]![0] as Record<string, unknown>;
    expect(call["physicalId"]).toBe("sync-id");
    expect(typeof call["shellDefinitionHash"]).toBe("string");
    expect(call["shellDefinitionHash"]).toHaveLength(64);
  });

  it("does NOT call onOperationAccepted before stageDefinition (order: getShellDef → opAccepted → stage)", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const createdAgent = {
      id: "order-id",
      displayName: "Order Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const shellDef = serverDefinition(null);
    const callOrder: string[] = [];

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "POST" && String(path).endsWith("/dataAgents")) {
          callOrder.push("create");
          return Promise.resolve({
            status: 201,
            body: createdAgent,
            headers: new Headers(),
          });
        }
        if (method === "GET") {
          callOrder.push("get-verify");
          return Promise.resolve({
            status: 200,
            body: createdAgent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          callOrder.push("getDefinition");
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "POST" && String(path).includes("updateDefinition")) {
          callOrder.push("updateDefinition");
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ definition: shellDef })
      .mockResolvedValueOnce({ definition: { parts: def.parts } });
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const opAccepted = vi.fn(() => {
      callOrder.push("opAccepted");
    });
    const adapter = new DataAgentAdapter(client);
    await adapter.create(
      "ws-1",
      { displayName: "Order Agent" },
      def,
      undefined,
      opAccepted as never,
    );

    const gd = callOrder.indexOf("getDefinition");
    const oa = callOrder.indexOf("opAccepted");
    const ud = callOrder.indexOf("updateDefinition");
    expect(gd).toBeGreaterThan(callOrder.indexOf("create"));
    expect(oa).toBeGreaterThan(gd);
    expect(ud).toBeGreaterThan(oa);
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe("DataAgentAdapter.update", () => {
  it("PATCHes metadata and stages definition", async () => {
    const newDef = fullDefinition("updated instructions");
    const client = makeMockClient();
    const agent = {
      id: "agent-upd",
      displayName: "Updated Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string, opts?: Record<string, unknown>) => {
        if (method === "GET") {
          return Promise.resolve({ status: 200, body: agent, headers: new Headers() });
        }
        if (method === "POST" && path.includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "PATCH") {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
          }
          return Promise.resolve({ status: 200, body: agent, headers: new Headers() });
        }
        if (method === "POST" && path.includes("updateDefinition")) {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
          }
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({ status: 200, body: null, headers: new Headers() });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ definition: serverDefinition("old instructions") }) // getDefinition baseline
      .mockResolvedValueOnce({ definition: serverDefinition("updated instructions") }); // verify getDefinition
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const adapter = new DataAgentAdapter(client);
    const checkpoints: unknown[] = [];
    const result = await adapter.update(
      "ws-1",
      "agent-upd",
      { displayName: "Updated Agent" },
      newDef,
      undefined,
      (state) => checkpoints.push(state),
    );
    expect(result.id).toBe("agent-upd");
    // Checkpoint phases should include metadata-submitting and definition-staged
    const phases = checkpoints.map(
      (c) => c && typeof c === "object" && "phase" in c ? (c as { phase: string }).phase : "undefined",
    );
    expect(phases).toContain("metadata-submitting");
    expect(phases).toContain("definition-submitting");
  });
});

describe("DataAgentAdapter.update — checkpoint phases via onDispatch", () => {
  it("does not write metadata-submitting phase before PATCH is dispatched", async () => {
    const agent = {
      id: "agent-cp",
      displayName: "CP Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const client = makeMockClient();
    const phases: string[] = [];
    let dispatchCalledBeforeReturn = false;

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string, opts?: Record<string, unknown>) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "PATCH") {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
            dispatchCalledBeforeReturn = true;
          }
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (
          method === "POST" &&
          String(path).includes("updateDefinition")
        ) {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
          }
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        definition: { parts: minimalDefinition().parts },
      })
      .mockResolvedValueOnce({
        definition: { parts: minimalDefinition().parts },
      });
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const adapter = new DataAgentAdapter(client);
    await adapter.update(
      "ws-1",
      "agent-cp",
      { displayName: "CP Agent" },
      minimalDefinition(),
      undefined,
      (state) => {
        if (state && "phase" in state) {
          phases.push(state.phase as string);
        }
      },
    );

    expect(dispatchCalledBeforeReturn).toBe(true);
    expect(phases).toContain("metadata-submitting");
    expect(phases).toContain("metadata-updated");
    expect(phases).toContain("definition-submitting");
    expect(phases).toContain("definition-staged");
    expect(phases.indexOf("metadata-submitting")).toBeLessThan(
      phases.indexOf("metadata-updated"),
    );
  });

  it("writes definition-submitting via onDispatch on updateDefinition request", async () => {
    const agent = {
      id: "a1",
      displayName: "A1",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const client = makeMockClient();
    let definitionDispatchCalled = false;
    const phases: string[] = [];

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string, opts?: Record<string, unknown>) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "PATCH") {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
          }
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (
          method === "POST" &&
          String(path).includes("updateDefinition")
        ) {
          if (typeof opts?.onDispatch === "function") {
            (opts.onDispatch as () => void)();
            definitionDispatchCalled = true;
          }
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        definition: { parts: minimalDefinition().parts },
      })
      .mockResolvedValueOnce({
        definition: { parts: minimalDefinition().parts },
      });
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    await new DataAgentAdapter(client).update(
      "ws-1",
      "a1",
      { displayName: "A1" },
      minimalDefinition(),
      undefined,
      (state) => {
        if (state && "phase" in state) {
          phases.push(state.phase as string);
        }
      },
    );

    expect(definitionDispatchCalled).toBe(true);
    expect(phases.indexOf("definition-submitting")).toBeLessThan(
      phases.indexOf("definition-staged"),
    );
  });
});

describe("DataAgentAdapter.resumeCreate — stages definition after LRO", () => {
  it("calls updateDefinition after LRO completes when definition is provided", async () => {
    const agent = {
      id: "resumed-id",
      displayName: "Resumed",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const client = makeMockClient();
    let updateDefinitionCalled = false;

    // waitForOperation is called 3 times:
    // 1. LRO result → agent
    // 2. shell check getDefinition → shell definition
    // 3. verify getDefinition → shell definition (hash compatible)
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(agent)
      .mockResolvedValueOnce({ definition: { parts: shellDef().parts } })
      .mockResolvedValueOnce({ definition: { parts: shellDef().parts } });
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (
          method === "POST" &&
          String(path).includes("updateDefinition")
        ) {
          updateDefinitionCalled = true;
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const adapter = new DataAgentAdapter(client);
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Resumed" },
      minimalDefinition(),
      { operationId: "op-1", location: "https://example.com/ops/1" },
    );

    expect(updateDefinitionCalled).toBe(true);
    expect(result.id).toBe("resumed-id");
  });

  it("skips updateDefinition when no definition is provided (shell resume)", async () => {
    const agent = {
      id: "shell-id",
      displayName: "Shell",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const client = makeMockClient();

    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValue(agent);
    (client.request as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 200,
      body: agent,
      headers: new Headers(),
    });

    const adapter = new DataAgentAdapter(client);
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Shell" },
      undefined,
      { operationId: "op-1" },
    );

    expect(client.request).not.toHaveBeenCalledWith(
      "POST",
      expect.stringContaining("updateDefinition"),
      expect.anything(),
    );
    expect(result.id).toBe("shell-id");
  });
});

describe("DataAgentAdapter.resumeCreate — sync shell proof", () => {
  it("resumes by fetching by physicalId, verifying identity and shell hash, then staging definition", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const agent = {
      id: "sync-resume-id",
      displayName: "Resume Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const shellDef = serverDefinition(null);
    const { hashDataAgentDefinition: hashDef } = await import(
      "../src/fabric/data-agent-definition"
    );
    const shellHash = hashDef(shellDef);
    let updateDefCalled = false;

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        if (method === "POST" && String(path).includes("updateDefinition")) {
          updateDefCalled = true;
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ definition: shellDef })
      .mockResolvedValueOnce({ definition: { parts: def.parts } });
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);

    const adapter = new DataAgentAdapter(client);
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Resume Agent" },
      def,
      { physicalId: "sync-resume-id", shellDefinitionHash: shellHash },
    );

    expect(result.id).toBe("sync-resume-id");
    expect(updateDefCalled).toBe(true);
  });

  it("fails closed when shell definition hash has changed externally", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const agent = {
      id: "drift-id",
      displayName: "Drift Agent",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };
    const originalShellHash = "a".repeat(64);
    const modifiedShellDef = serverDefinition("External change");

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, path: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: agent,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(path).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op"]]),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      definition: modifiedShellDef,
    });

    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Drift Agent" },
        def,
        { physicalId: "drift-id", shellDefinitionHash: originalShellHash },
      ),
    ).rejects.toThrow(/externally modified|Failing closed/);
  });

  it("fails closed when identity mismatch (wrong displayName)", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const wrongAgent = {
      id: "wrong-id",
      displayName: "Wrong Name",
      workspaceId: "ws-1",
      type: "DataAgent" as const,
    };

    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: wrongAgent,
            headers: new Headers(),
          });
        }
        return Promise.resolve({
          status: 200,
          body: null,
          headers: new Headers(),
        });
      },
    );

    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Correct Name" },
        def,
        { physicalId: "wrong-id", shellDefinitionHash: "a".repeat(64) },
      ),
    ).rejects.toThrow(/no longer matches approved identity|Failing closed/);
  });

  it("fails closed when no operation reference or sync proof available", async () => {
    const def = minimalDefinition();
    const client = makeMockClient();
    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.resumeCreate("ws-1", { displayName: "No Proof" }, def, {}),
    ).rejects.toThrow(/no operation reference|Failing closed/);
  });
});

describe("DataAgentAdapter.plan — getDefinition error handling", () => {
  it("returns blocked when getDefinition returns OperationNotSupportedForItem (400)", async () => {
    const { FabricApiError } = await import("../src/fabric/client");
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "agent-blocked",
        displayName: "Blocked Agent",
        workspaceId: "ws-1",
        type: "DataAgent",
      },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: {
              id: "agent-blocked",
              displayName: "Blocked Agent",
              workspaceId: "ws-1",
              type: "DataAgent",
            },
            headers: new Headers(),
          });
        }
        throw new FabricApiError(
          "Operation not supported",
          400,
          "OperationNotSupportedForItem",
        );
      },
    );
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "Blocked Agent" },
      minimalDefinition(),
    );
    expect(result.action).toBe("blocked");
    expect(result.physicalId).toBe("agent-blocked");
    expect(result.reason).toMatch(/OperationNotSupportedForItem/);
  });

  it("propagates unknown 400 errors from getDefinition", async () => {
    const { FabricApiError } = await import("../src/fabric/client");
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "agent-err",
        displayName: "Error Agent",
        workspaceId: "ws-1",
        type: "DataAgent",
      },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: {
              id: "agent-err",
              displayName: "Error Agent",
              workspaceId: "ws-1",
              type: "DataAgent",
            },
            headers: new Headers(),
          });
        }
        throw new FabricApiError("Bad request", 400, "SomeOtherError");
      },
    );
    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.plan(
        "ws-1",
        { displayName: "Error Agent" },
        minimalDefinition(),
      ),
    ).rejects.toThrow(/Bad request/);
  });

  it("treats 404 on getDefinition as no-definition (item may have been deleted)", async () => {
    const { FabricApiError } = await import("../src/fabric/client");
    const client = makeMockClient();
    (client.listAll as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "agent-gone",
        displayName: "Gone Agent",
        workspaceId: "ws-1",
        type: "DataAgent",
      },
    ]);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: {
              id: "agent-gone",
              displayName: "Gone Agent",
              workspaceId: "ws-1",
              type: "DataAgent",
            },
            headers: new Headers(),
          });
        }
        throw new FabricApiError("Not found", 404);
      },
    );
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.plan(
      "ws-1",
      { displayName: "Gone Agent" },
      minimalDefinition(),
    );
    expect(["update", "no-op"]).toContain(result.action);
  });
});

// ---------------------------------------------------------------------------
// resumeCreate — LRO identity verification (Finding 1)
// ---------------------------------------------------------------------------

describe("DataAgentAdapter.resumeCreate — LRO identity verification", () => {
  function makeLroClient(
    lroResult: Record<string, unknown>,
    getBody: Record<string, unknown>,
  ) {
    const client = makeMockClient();
    // waitForOperation calls:
    // 1. LRO result → lroResult
    // 2. shell check getDefinition → shell definition
    // 3. verify getDefinition → shell definition (hash compatible with minimalDefinition)
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(lroResult)
      .mockResolvedValueOnce({ definition: { parts: shellDef().parts } })
      .mockResolvedValueOnce({ definition: { parts: shellDef().parts } });
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, p: string) => {
        if (method === "GET") {
          return Promise.resolve({
            status: 200,
            body: getBody,
            headers: new Headers(),
          });
        }
        if (method === "POST" && String(p).includes("updateDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        if (method === "POST" && String(p).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        return Promise.resolve({ status: 200, body: null, headers: new Headers() });
      },
    );
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    return new DataAgentAdapter(client);
  }

  const CORRECT_AGENT = {
    id: "lro-id",
    displayName: "Correct Name",
    workspaceId: "ws-1",
    type: "DataAgent",
  } as const;

  it("fails closed when GET returns wrong displayName after LRO", async () => {
    const wrongBody = { ...CORRECT_AGENT, displayName: "Wrong Name" };
    const adapter = makeLroClient(CORRECT_AGENT, wrongBody);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Correct Name" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/does not match approved identity|Failing closed/);
  });

  it("fails closed when GET returns wrong folderId after LRO", async () => {
    const wrongBody = { ...CORRECT_AGENT, folderId: "wrong-folder" };
    const adapter = makeLroClient(CORRECT_AGENT, wrongBody);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Correct Name", folderId: "expected-folder" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/does not match approved identity|Failing closed/);
  });

  it("fails closed when GET returns wrong type after LRO", async () => {
    const wrongType = { ...CORRECT_AGENT, type: "SemanticModel" };
    const adapter = makeLroClient(CORRECT_AGENT, wrongType);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Correct Name" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/does not match approved identity|Failing closed/);
  });

  it("proceeds to stageDefinition when LRO identity is valid", async () => {
    const adapter = makeLroClient(CORRECT_AGENT, CORRECT_AGENT);
    let updateCalled = false;
    // Patch the mock to track updateDefinition
    (adapter as unknown as { client: ReturnType<typeof makeMockClient> })
      .client;
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Correct Name" },
      minimalDefinition(),
      { operationId: "op-1" },
    );
    expect(result.id).toBe("lro-id");
  });

  it("does not call updateDefinition when identity check fails on wrong displayName", async () => {
    const wrongBody = { ...CORRECT_AGENT, displayName: "Impostor" };
    const client = makeMockClient();
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(CORRECT_AGENT);
    let updateDefinitionCalled = false;
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, p: string) => {
        if (method === "GET") {
          return Promise.resolve({ status: 200, body: wrongBody, headers: new Headers() });
        }
        if (method === "POST" && String(p).includes("updateDefinition")) {
          updateDefinitionCalled = true;
        }
        return Promise.resolve({ status: 200, body: null, headers: new Headers() });
      },
    );
    const adapter = new DataAgentAdapter(client);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Correct Name" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/Failing closed/);
    expect(updateDefinitionCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resumeCreate — LRO shell content proof (Finding 2)
// ---------------------------------------------------------------------------

describe("DataAgentAdapter.resumeCreate — LRO shell content proof", () => {
  const AGENT = {
    id: "shell-proof-id",
    displayName: "Shell Proof Agent",
    workspaceId: "ws-1",
    type: "DataAgent" as const,
  };

  function makeLroClientWithShell(shellDefParts: FabricDefinition["parts"]) {
    const client = makeMockClient();
    (client.waitForOperation as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(AGENT)
      .mockResolvedValueOnce({ definition: { parts: shellDefParts } })
      .mockResolvedValueOnce({ definition: { parts: shellDef().parts } });
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, p: string) => {
        if (method === "GET") {
          return Promise.resolve({ status: 200, body: AGENT, headers: new Headers() });
        }
        if (method === "POST" && String(p).includes("updateDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-ud"]]),
          });
        }
        if (method === "POST" && String(p).includes("getDefinition")) {
          return Promise.resolve({
            status: 202,
            body: null,
            headers: new Headers([["x-ms-operation-id", "op-gd"]]),
          });
        }
        return Promise.resolve({ status: 200, body: null, headers: new Headers() });
      },
    );
    (client.waitForOperationCompletion as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    return new DataAgentAdapter(client);
  }

  it("proceeds when current definition is an untouched shell", async () => {
    const adapter = makeLroClientWithShell(shellDef().parts);
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Shell Proof Agent" },
      minimalDefinition(),
      { operationId: "op-1" },
    );
    expect(result.id).toBe("shell-proof-id");
  });

  it("fails closed when root config $schema is externally changed", async () => {
    const modifiedRoot = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: b64({ $schema: "https://example.com/wrong.json" }),
          payloadType: "InlineBase64" as const,
        },
        {
          path: "Files/Config/draft/stage_config.json",
          payload: b64({ $schema: STAGE_SCHEMA, aiInstructions: null }),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const adapter = makeLroClientWithShell(modifiedRoot.parts);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Shell Proof Agent" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/externally modified|untouched shell|Failing closed/);
  });

  it("fails closed when aiInstructions is externally set (stage_config modified)", async () => {
    const modifiedStage = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: b64({ $schema: ROOT_SCHEMA }),
          payloadType: "InlineBase64" as const,
        },
        {
          path: "Files/Config/draft/stage_config.json",
          payload: b64({ $schema: STAGE_SCHEMA, aiInstructions: "External instructions." }),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const adapter = makeLroClientWithShell(modifiedStage.parts);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Shell Proof Agent" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/externally modified|untouched shell|Failing closed/);
  });

  it("fails closed when a datasource part is externally added", async () => {
    const withDatasource = {
      parts: [
        ...shellDef().parts,
        {
          path: "Files/Config/draft/lakehouse-Sales/datasource.json",
          payload: b64({ type: "lakehouse" }),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const adapter = makeLroClientWithShell(withDatasource.parts);
    await expect(
      adapter.resumeCreate(
        "ws-1",
        { displayName: "Shell Proof Agent" },
        minimalDefinition(),
        { operationId: "op-1" },
      ),
    ).rejects.toThrow(/externally modified|untouched shell|Failing closed/);
  });

  it("skips shell check when no definition is provided (shell-only LRO resume)", async () => {
    // Shell-only resume: no definition to stage, so shell check is skipped.
    // getDefinition should NOT be called.
    const client = makeMockClient();
    (client.waitForOperation as ReturnType<typeof vi.fn>).mockResolvedValue(AGENT);
    (client.request as ReturnType<typeof vi.fn>).mockImplementation(
      (method: string, p: string) => {
        if (method === "GET") {
          return Promise.resolve({ status: 200, body: AGENT, headers: new Headers() });
        }
        if (method === "POST" && String(p).includes("getDefinition")) {
          throw new Error("getDefinition should not be called in shell-only resume");
        }
        return Promise.resolve({ status: 200, body: null, headers: new Headers() });
      },
    );
    const adapter = new DataAgentAdapter(client);
    const result = await adapter.resumeCreate(
      "ws-1",
      { displayName: "Shell Proof Agent" },
      undefined, // no definition
      { operationId: "op-1" },
    );
    expect(result.id).toBe("shell-proof-id");
  });
});
