import { describe, expect, it, vi } from "vitest";

import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "../src/fabric/client";

const tokenProvider = {
  getToken: async () => "token",
};

describe("Fabric API client", () => {
  it("retries throttled GET requests and honors Retry-After", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errorCode: "TooManyRequests" }), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: "ok" }), { status: 200 }),
      );
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    const response = await client.request<{ value: string }>("GET", "/v1/test");

    expect(response.body).toEqual({ value: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });

  it("does not retry a failed POST automatically", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    });

    await expect(
      client.request("POST", "/v1/test", {
        body: { displayName: "Test" },
      }),
    ).rejects.toBeInstanceOf(FabricApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows same-origin pagination", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: "1" }],
            continuationUri:
              "https://api.fabric.microsoft.com/v1/items?continuationToken=next",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [{ id: "2" }] }), {
          status: 200,
        }),
      );
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
    });

    await expect(client.listAll<{ id: string }>("/v1/items")).resolves.toEqual([
      { id: "1" },
      { id: "2" },
    ]);
  });

  it("rejects cross-origin continuation URIs", async () => {
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            value: [],
            continuationUri: "https://attacker.example/items",
          }),
          { status: 200 },
        ),
    });

    await expect(client.listAll("/v1/items")).rejects.toThrow(
      "unexpected origin",
    );
  });

  it("polls a long-running operation and retrieves its result", async () => {
    let now = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "Running" }), {
          status: 200,
          headers: { "retry-after": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "Succeeded" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "lakehouse-1" }), { status: 200 }),
      );
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      operationPollIntervalMs: 1,
    });
    const initial: FabricResponse<unknown> = {
      status: 202,
      headers: new Headers({
        location: "https://api.fabric.microsoft.com/v1/operations/op-1",
        "x-ms-operation-id": "op-1",
      }),
      body: undefined,
    };

    await expect(
      client.waitForOperation<{ id: string }>(initial),
    ).resolves.toEqual({ id: "lakehouse-1" });
  });

  it("aborts API requests that exceed the request timeout", async () => {
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      requestTimeoutMs: 1,
      maxRetries: 0,
      now: () => 0,
    });

    await expect(client.request("GET", "/v1/test")).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("times out while reading a stalled API response body", async () => {
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Intentionally leave the stream open.
            },
          }),
          { status: 200 },
        ),
      requestTimeoutMs: 5,
      maxRetries: 0,
    });

    await expect(client.request("GET", "/v1/test")).rejects.toThrow(
      "response body timed out",
    );
  });

  it("preserves a definitive HTTP status when its error body stalls", async () => {
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start() {
              // Intentionally leave the error stream open.
            },
          }),
          { status: 403 },
        ),
      requestTimeoutMs: 5,
      maxRetries: 0,
      now: () => 0,
    });

    await expect(client.request("POST", "/v1/test")).rejects.toMatchObject({
      name: "FabricApiError",
      status: 403,
    });
  });

  it("does not let Retry-After exceed the LRO deadline", async () => {
    let now = 0;
    const fetchImpl = vi.fn();
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      operationTimeoutMs: 5,
    });
    const initial: FabricResponse<unknown> = {
      status: 202,
      headers: new Headers({
        location: "https://api.fabric.microsoft.com/v1/operations/op-1",
        "retry-after": "10",
        "x-ms-operation-id": "op-1",
      }),
      body: undefined,
    };

    await expect(client.waitForOperation(initial)).rejects.toThrow(
      "timed out after 5 ms",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
