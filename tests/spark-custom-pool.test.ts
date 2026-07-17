import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  SparkCustomPoolAdapter,
  STARTER_POOL_ID,
  hashObservedSparkCustomPool,
  type SparkCustomPool,
} from "../src/fabric/spark-custom-pool";
import type { SparkCustomPoolDefinition } from "../src/fabric/spark-custom-pool-definition";

const tokenProvider = {
  getToken: async () => "token",
};

const desired = { displayName: "Batch Small" };
const desiredDefinition: SparkCustomPoolDefinition = {
  nodeFamily: "MemoryOptimized",
  nodeSize: "Small",
  autoScale: {
    enabled: true,
    minNodeCount: 1,
    maxNodeCount: 2,
  },
  dynamicExecutorAllocation: {
    enabled: true,
    minExecutors: 1,
    maxExecutors: 1,
  },
};

function pool(
  overrides: Partial<SparkCustomPool> = {},
): SparkCustomPool {
  return {
    id: "pool-1",
    name: "Batch Small",
    type: "Workspace",
    nodeFamily: "MemoryOptimized",
    nodeSize: "Small",
    autoScale: {
      enabled: true,
      minNodeCount: 1,
      maxNodeCount: 2,
    },
    dynamicExecutorAllocation: {
      enabled: true,
      minExecutors: 1,
      maxExecutors: 1,
    },
    ...overrides,
  };
}

function createAdapter(fetchImpl: FetchLike): SparkCustomPoolAdapter {
  return new SparkCustomPoolAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

describe("Spark custom pool adapter", () => {
  it("plans create, update, and no-op from workspace pool state", async () => {
    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(JSON.stringify({ value: [] }), { status: 200 }),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({ action: "create" });

    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              value: [pool({ nodeSize: "Medium" })],
            }),
            { status: 200 },
          ),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({
      action: "update",
      physicalId: "pool-1",
    });

    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(JSON.stringify({ value: [pool()] }), {
            status: 200,
          }),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "pool-1",
    });
  });

  it("binds plans to deterministic canonical observed state", () => {
    const first = pool();
    const second = {
      dynamicExecutorAllocation: first.dynamicExecutorAllocation,
      autoScale: first.autoScale,
      nodeSize: first.nodeSize,
      nodeFamily: first.nodeFamily,
      type: first.type,
      name: first.name,
      id: first.id,
    };

    expect(hashObservedSparkCustomPool(first)).toBe(
      hashObservedSparkCustomPool(second),
    );
    expect(
      hashObservedSparkCustomPool(
        pool({
          autoScale: {
            enabled: true,
            minNodeCount: 1,
            maxNodeCount: 3,
          },
        }),
      ),
    ).not.toBe(hashObservedSparkCustomPool(first));
  });

  it("blocks the Starter Pool, capacity pools, and case collisions", async () => {
    const starter = pool({
      id: STARTER_POOL_ID,
      name: "Starter Pool",
    });
    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(JSON.stringify({ value: [starter] }), {
            status: 200,
          }),
        ),
      ).plan(
        "workspace",
        { displayName: "Starter Pool" },
        desiredDefinition,
      ),
    ).resolves.toMatchObject({ action: "blocked" });

    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              value: [pool({ type: "Capacity" })],
            }),
            { status: 200 },
          ),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({ action: "blocked" });

    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              value: [
                pool(),
                pool({
                  id: "capacity-pool",
                  name: "batch small",
                  type: "Capacity",
                }),
              ],
            }),
            { status: 200 },
          ),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({ action: "blocked" });

    await expect(
      createAdapter(
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              value: [pool({ name: "batch small" })],
            }),
            { status: 200 },
          ),
        ),
      ).plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({ action: "blocked" });
  });

  it("blocks duplicate exact workspace names", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [pool(), pool({ id: "pool-2" })],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.plan("workspace", desired, desiredDefinition),
    ).resolves.toMatchObject({ action: "blocked" });
  });

  it("supports list pagination and get through stable workspace paths", async () => {
    const requested: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("continuationToken=next")) {
          return new Response(JSON.stringify({ value: [pool()] }), {
            status: 200,
          });
        }
        if (url.endsWith("/spark/pools/pool-1")) {
          return new Response(JSON.stringify(pool()), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            value: [],
            continuationToken: "next",
          }),
          { status: 200 },
        );
      }),
    );

    await expect(adapter.list("workspace")).resolves.toEqual([pool()]);
    await expect(adapter.get("workspace", "pool-1")).resolves.toEqual(
      pool(),
    );
    expect(requested.some((url) => url.includes("/spark/pools"))).toBe(
      true,
    );
  });

  it("creates synchronously, checkpoints the returned ID, and verifies", async () => {
    const lifecycle: string[] = [];
    let request: unknown;
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          lifecycle.push("POST");
          request = JSON.parse(String(init.body));
          return new Response(JSON.stringify(pool()), {
            status: 201,
            headers: {
              location:
                "https://api.fabric.microsoft.com/v1/workspaces/workspace/spark/pools/pool-1",
            },
          });
        }
        if (String(input).endsWith("/spark/pools/pool-1")) {
          lifecycle.push("GET");
          return new Response(JSON.stringify(pool()), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await adapter.create(
      "workspace",
      desired,
      desiredDefinition,
      (id) => lifecycle.push(`ACCEPTED:${id}`),
      () => lifecycle.push("OPERATION"),
      () => lifecycle.push("SUBMITTING"),
    );

    expect(result.id).toBe("pool-1");
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "POST",
      "ACCEPTED:pool-1",
      "GET",
    ]);
    expect(request).toEqual({
      name: "Batch Small",
      ...desiredDefinition,
    });
  });

  it("uses nonretryable create mutations and clears definitive rejections", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errorCode: "Forbidden",
            message: "Workspace Admin required",
          }),
          { status: 403 },
        ),
    );
    const lifecycle: string[] = [];

    await expect(
      createAdapter(fetchImpl).create(
        "workspace",
        desired,
        desiredDefinition,
        undefined,
        undefined,
        () => lifecycle.push("SUBMITTING"),
        () => lifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(["SUBMITTING", "REJECTED"]);
  });

  it("does not retry transient create or update mutations", async () => {
    const createFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errorCode: "ServiceUnavailable",
            message: "Try later",
          }),
          { status: 503 },
        ),
    );
    await expect(
      createAdapter(createFetch).create(
        "workspace",
        desired,
        desiredDefinition,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(createFetch).toHaveBeenCalledTimes(1);

    const updateFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errorCode: "ServiceUnavailable",
            message: "Try later",
          }),
          { status: 503 },
        ),
    );
    await expect(
      createAdapter(updateFetch).update(
        "workspace",
        "pool-1",
        desired,
        desiredDefinition,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(updateFetch).toHaveBeenCalledTimes(1);
  });

  it("clears definitive synchronous update rejections", async () => {
    const lifecycle: string[] = [];
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            errorCode: "Forbidden",
            message: "Workspace Admin required",
          }),
          { status: 403 },
        ),
    );

    await expect(
      createAdapter(fetchImpl).update(
        "workspace",
        "pool-1",
        desired,
        desiredDefinition,
        undefined,
        () => lifecycle.push("SUBMITTING"),
        () => lifecycle.push("REJECTED"),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(["SUBMITTING", "REJECTED"]);
  });

  it("updates synchronously with a full body and verifies", async () => {
    const lifecycle: string[] = [];
    let request: unknown;
    const adapter = createAdapter(
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          lifecycle.push("PATCH");
          request = JSON.parse(String(init.body));
          return new Response(JSON.stringify(pool()), { status: 200 });
        }
        lifecycle.push("GET");
        return new Response(JSON.stringify(pool()), { status: 200 });
      }),
    );

    await adapter.update(
      "workspace",
      "pool-1",
      desired,
      desiredDefinition,
      (id) => lifecycle.push(`ACCEPTED:${id}`),
      () => lifecycle.push("SUBMITTING"),
    );

    expect(lifecycle).toEqual([
      "SUBMITTING",
      "PATCH",
      "ACCEPTED:pool-1",
      "GET",
    ]);
    expect(request).toEqual({
      name: "Batch Small",
      ...desiredDefinition,
    });
  });

  it("rejects unsupported metadata and verification drift", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify(pool({ nodeSize: "Medium" })),
          { status: 200 },
        ),
      ),
    );

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Batch Small", description: "unsupported" },
        desiredDefinition,
      ),
    ).rejects.toThrow("do not support description");

    await expect(
      adapter.plan(
        "workspace",
        {
          displayName: "Batch Small",
          references: { unsupported: "other" },
        },
        desiredDefinition,
      ),
    ).rejects.toThrow("do not support references");

    await expect(
      adapter.verify(
        "workspace",
        "pool-1",
        desired,
        desiredDefinition,
      ),
    ).rejects.toThrow("verification failed");
  });

  it("does not expose delete behavior", () => {
    expect("delete" in createAdapter(vi.fn())).toBe(false);
  });
});
