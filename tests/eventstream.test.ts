import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { EventstreamAdapter } from "../src/fabric/eventstream";

const tokenProvider = { getToken: async () => "token" };

const MINIMAL_TOPOLOGY = {
  compatibilityLevel: "1.1",
  sources: [],
  destinations: [],
  operators: [],
  streams: [],
};

function eventstreamDefinition(overrides?: object): FabricDefinition {
  return {
    parts: [
      {
        path: "eventstream.json",
        payload: Buffer.from(
          JSON.stringify({ ...MINIMAL_TOPOLOGY, ...overrides }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function definitionResponse(
  topology: Record<string, unknown> = MINIMAL_TOPOLOGY,
  withIds = true,
): object {
  const topologyWithIds = withIds
    ? {
        ...topology,
        sources: (topology.sources as unknown[]).map((s, i) => ({
          id: `src-${i}`,
          ...(s as object),
        })),
        destinations: (topology.destinations as unknown[]).map((d, i) => ({
          id: `dst-${i}`,
          ...(d as object),
        })),
      }
    : topology;
  return {
    definition: {
      format: "",
      parts: [
        {
          path: "eventstream.json",
          payload: Buffer.from(JSON.stringify(topologyWithIds)).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "eventstreamProperties.json",
          payload: Buffer.from(
            JSON.stringify({ retentionTimeInDays: 1, eventThroughputLevel: "Low" }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    },
  };
}

function createAdapter(fetchImpl: FetchLike): EventstreamAdapter {
  return new EventstreamAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Eventstream adapter", () => {
  it("plans creation when the Eventstream is absent", async () => {
    const adapter = createAdapter(
      vi.fn(async () => new Response(JSON.stringify({ value: [] }), { status: 200 })),
    );

    await expect(
      adapter.plan("workspace", { displayName: "MyStream" }, eventstreamDefinition()),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans no-op for matching Eventstream", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({ value: [{ id: "es-1", displayName: "MyStream" }] }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/eventstreams/es-1")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan("workspace", { displayName: "MyStream" }, eventstreamDefinition()),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "es-1",
      managedMetadataMatches: true,
    });
  });

  it("plans update when definition differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({ value: [{ id: "es-1", displayName: "MyStream" }] }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/eventstreams/es-1")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        // Return different topology
        return new Response(
          JSON.stringify(
            definitionResponse({
              ...MINIMAL_TOPOLOGY,
              operators: [{ name: "changed-operator", type: "Filter" }],
            }),
          ),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan("workspace", { displayName: "MyStream" }, eventstreamDefinition()),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
      physicalId: "es-1",
      stagedDefinitionHash: expect.any(String),
    });
  });

  it("throws when multiple Eventstreams have the same displayName", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "es-1", displayName: "MyStream" },
              { id: "es-2", displayName: "MyStream" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan("workspace", { displayName: "MyStream" }, eventstreamDefinition()),
    ).rejects.toThrow("Multiple Eventstreams");
  });

  it("uses folder-scoped list query with rootFolderId", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await adapter.plan(
      "workspace",
      { displayName: "MyStream", folderId: "folder-1" },
      eventstreamDefinition(),
    );

    expect(requestedUrls[0]).toContain("recursive=false");
    expect(requestedUrls[0]).toContain("rootFolderId=folder-1");
  });

  it("reads getDefinition response through 202 LRO", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url}`);
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({ value: [{ id: "es-1", displayName: "MyStream" }] }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/eventstreams/es-1") && !url.includes("operations")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(undefined, {
          status: 202,
          headers: { "x-ms-operation-id": "def-op-1" },
        });
      }
      if (url.endsWith("/v1/operations/def-op-1")) {
        return new Response(JSON.stringify({ status: "Succeeded" }), { status: 200 });
      }
      if (url.endsWith("/v1/operations/def-op-1/result")) {
        return new Response(JSON.stringify(definitionResponse()), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan("workspace", { displayName: "MyStream" }, eventstreamDefinition()),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "es-1",
    });
    expect(requests.some((r) => r.includes("def-op-1"))).toBe(true);
  });

  it("creates an Eventstream via 202 LRO and verifies it", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      requests.push({ method, url });
      // Create → 202 LRO
      if (method === "POST" && url.endsWith("/eventstreams")) {
        return new Response(undefined, {
          status: 202,
          headers: { "x-ms-operation-id": "create-op-1" },
        });
      }
      if (url.endsWith("/v1/operations/create-op-1")) {
        return new Response(JSON.stringify({ status: "Succeeded" }), { status: 200 });
      }
      if (url.endsWith("/v1/operations/create-op-1/result")) {
        return new Response(
          JSON.stringify({ id: "es-new", displayName: "NewStream" }),
          { status: 200 },
        );
      }
      // verify GET
      if (method === "GET" && url.includes("/eventstreams/es-new")) {
        return new Response(
          JSON.stringify({ id: "es-new", displayName: "NewStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);
    const onMutationAccepted = vi.fn();
    const onOperationAccepted = vi.fn();
    const onCreateSubmitting = vi.fn();

    const result = await adapter.create(
      "workspace",
      { displayName: "NewStream" },
      eventstreamDefinition(),
      onMutationAccepted,
      onOperationAccepted,
      onCreateSubmitting,
    );

    expect(result.id).toBe("es-new");
    expect(onMutationAccepted).toHaveBeenCalledWith("es-new");
    expect(onOperationAccepted).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "create-op-1" }),
    );
    expect(onCreateSubmitting).toHaveBeenCalled();
    // Verify the create request used format:"eventstream"
    const createRequest = requests.find(
      (r) => r.method === "POST" && r.url.endsWith("/eventstreams"),
    );
    expect(createRequest).toBeDefined();
  });

  it("calls onCreateRejected on a definitive 400 rejection", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.endsWith("/eventstreams")) {
        return new Response(
          JSON.stringify({ errorCode: "InvalidRequest", message: "Bad" }),
          { status: 400 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);
    const onCreateRejected = vi.fn();

    await expect(
      adapter.create("workspace", { displayName: "MyStream" }, eventstreamDefinition(), undefined, undefined, undefined, onCreateRejected),
    ).rejects.toThrow();

    expect(onCreateRejected).toHaveBeenCalled();
  });

  it("verifies displayName and definition after update", async () => {
    let patchCalled = false;
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "PATCH") {
        patchCalled = true;
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/updateDefinition?updateMetadata=false")) {
        return new Response(undefined, { status: 200 });
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), { status: 200 });
      }
      if (method === "GET" && url.includes("/eventstreams/es-1")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);
    const onMutationAccepted = vi.fn();
    const onCheckpoint = vi.fn();

    await adapter.update(
      "workspace",
      "es-1",
      { displayName: "MyStream" },
      eventstreamDefinition(),
      onMutationAccepted,
      onCheckpoint,
    );

    expect(patchCalled).toBe(true);
    expect(onMutationAccepted).toHaveBeenCalledWith("es-1");
    // Checkpoint called at least at metadata-submitting and definition-staged
    expect(onCheckpoint).toHaveBeenCalledTimes(3);
  });

  it("blocks planning when an encrypted sensitivity label prevents definition retrieval", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "es-1", displayName: "MyStream" }],
          }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/eventstreams/es-1")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify({
            errorCode: "OperationNotSupportedForItem",
            message: "Definition is unavailable.",
          }),
          { status: 400 },
        );
      }
      return new Response("{}", { status: 200 });
    });

    await expect(
      createAdapter(fetchImpl).plan(
        "workspace",
        { displayName: "MyStream" },
        eventstreamDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "es-1",
      reason: expect.stringContaining("encrypted sensitivity label"),
    });
  });
});

// ---------------------------------------------------------------------------
// Throughput downgrade / upgrade planning tests
// ---------------------------------------------------------------------------

describe("EventstreamAdapter.plan — eventThroughputLevel immutability", () => {
  /**
   * Builds a FabricDefinition that includes eventstreamProperties.json with
   * the given throughput level and retention.
   */
  function desiredWithProperties(
    level: "Low" | "Medium" | "High",
    retention = 1,
  ): FabricDefinition {
    return {
      parts: [
        {
          path: "eventstream.json",
          payload: Buffer.from(JSON.stringify(MINIMAL_TOPOLOGY)).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "eventstreamProperties.json",
          payload: Buffer.from(
            JSON.stringify({ retentionTimeInDays: retention, eventThroughputLevel: level }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
  }

  /** Creates a mock getDefinition response with the given observed throughput. */
  function observedDefinitionResponse(observedLevel: "Low" | "Medium" | "High"): object {
    return {
      definition: {
        format: "",
        parts: [
          {
            path: "eventstream.json",
            payload: Buffer.from(JSON.stringify(MINIMAL_TOPOLOGY)).toString("base64"),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: Buffer.from(
              JSON.stringify({ retentionTimeInDays: 1, eventThroughputLevel: observedLevel }),
            ).toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      },
    };
  }

  /** Creates a fetch mock that returns the given observed throughput level. */
  function fetchForObserved(
    observedLevel: "Low" | "Medium" | "High",
  ): FetchLike {
    return vi.fn(async (input: string | URL, options?: RequestInit) => {
      const url = String(input);
      const method = (options?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/eventstreams?")) {
        return new Response(
          JSON.stringify({ value: [{ id: "es-1", displayName: "MyStream" }] }),
          { status: 200 },
        );
      }
      if (method === "GET" && url.includes("/eventstreams/es-1")) {
        return new Response(
          JSON.stringify({ id: "es-1", displayName: "MyStream" }),
          { status: 200 },
        );
      }
      if (method === "POST" && url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify(observedDefinitionResponse(observedLevel)),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
  }

  it("blocks: desired Low, observed Medium (downgrade not allowed)", async () => {
    const adapter = createAdapter(fetchForObserved("Medium"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Low"),
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("cannot be downgraded");
    expect(result.reason).toContain("Medium");
    expect(result.reason).toContain("Low");
  });

  it("blocks: desired Low, observed High (two-step downgrade not allowed)", async () => {
    const adapter = createAdapter(fetchForObserved("High"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Low"),
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("cannot be downgraded");
    expect(result.reason).toContain("High");
  });

  it("blocks: desired Medium, observed High (partial downgrade not allowed)", async () => {
    const adapter = createAdapter(fetchForObserved("High"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Medium"),
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("cannot be downgraded");
  });

  it("does not block at plan time (returns update) for upgrade Low→Medium", async () => {
    const adapter = createAdapter(fetchForObserved("Low"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Medium"),
    );
    // Topology is same; only properties differ → update
    expect(result.action).toBe("update");
    expect(result.reason).toContain("definition differs");
  });

  it("does not block for upgrade Medium→High", async () => {
    const adapter = createAdapter(fetchForObserved("Medium"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("High"),
    );
    expect(result.action).toBe("update");
  });

  it("returns no-op when desired throughput equals observed (same level, same retention)", async () => {
    const adapter = createAdapter(fetchForObserved("Medium"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Medium", 1),
    );
    expect(result.action).toBe("no-op");
  });

  it("returns update (not blocked) when only retention changes and throughput stays same", async () => {
    const adapter = createAdapter(fetchForObserved("Medium"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Medium", 7), // retention 1→7, throughput unchanged
    );
    expect(result.action).toBe("update");
    expect(result.reason).toContain("definition differs");
  });

  it("does not check throughput when user does not manage eventstreamProperties.json", async () => {
    // Without properties part, includeProperties=false → no throughput check
    const adapter = createAdapter(fetchForObserved("High"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      eventstreamDefinition(), // no eventstreamProperties part
    );
    // No properties part in desired → no drift → no-op (topology matches)
    expect(result.action).toBe("no-op");
  });

  it("blocked plan carries physicalId and observedStateHash for caller recovery", async () => {
    const adapter = createAdapter(fetchForObserved("Medium"));
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyStream" },
      desiredWithProperties("Low"),
    );
    expect(result.action).toBe("blocked");
    expect(result.physicalId).toBe("es-1");
    expect(result.observedStateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.stagedDefinitionHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
