import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ONELAKE_SCOPE, type FetchLike } from "../src/fabric/auth";
import {
  buildOneLakeAbfssUri,
  buildOneLakeArtifactPath,
  MAX_ONELAKE_SINGLE_UPLOAD_BYTES,
  OneLakeArtifactStager,
  ONE_LAKE_STORAGE_API_VERSION,
  type OneLakeArtifactDescriptor,
} from "../src/fabric/onelake-artifacts";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const LAKEHOUSE_ID = "22222222-2222-2222-2222-222222222222";
const DFS_ENDPOINT = "https://onelake.dfs.fabric.microsoft.com";
const BLOB_ENDPOINT = "https://onelake.blob.fabric.microsoft.com";
const TEST_ROOT = path.join(
  process.cwd(),
  "tests",
  ".onelake-artifacts-runtime",
);
const FIXED_DATE = Date.parse("2026-07-18T00:00:00.000Z");
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

let sourceIndex = 0;

beforeEach(async () => {
  await mkdir(TEST_ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function descriptor(
  content = Buffer.from("approved artifact"),
  oneLakePath = `Files/staged/${hash(content)}/artifact.jar`,
): Promise<OneLakeArtifactDescriptor> {
  sourceIndex += 1;
  const sourcePath = path.join(TEST_ROOT, `source-${sourceIndex}.jar`);
  await writeFile(sourcePath, content);
  return {
    workspaceId: WORKSPACE_ID,
    lakehouseId: LAKEHOUSE_ID,
    oneLakePath,
    fileName: "artifact.jar",
    sourcePath,
    contentHash: hash(content),
    sizeBytes: content.byteLength,
    contentType: "application/java-archive",
  };
}

function stager(
  fetchImpl: FetchLike,
  token = "storage-secret",
  requestTimeoutMs = 1_000,
) {
  const getToken = vi.fn(async (_scope: string) => token);
  return {
    getToken,
    client: new OneLakeArtifactStager({
      dfsEndpoint: DFS_ENDPOINT,
      blobEndpoint: BLOB_ENDPOINT,
      tokenProvider: { getToken },
      fetchImpl,
      maxRetries: 0,
      retryBaseDelayMs: 1,
      requestTimeoutMs,
      sleep: async () => {},
      now: () => FIXED_DATE,
      randomUUID: () => REQUEST_ID,
    }),
  };
}

function headers(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

describe("OneLake artifact paths", () => {
  it("builds immutable paths and rejects unsafe segments or hashes", () => {
    const contentHash = "a".repeat(64);
    expect(
      buildOneLakeArtifactPath(
        "deployment",
        "prod",
        "spark-job",
        contentHash,
        "job.jar",
      ),
    ).toBe(
      `Files/.fabric-deploy/deployment/prod/spark-job/${contentHash}/job.jar`,
    );
    expect(() =>
      buildOneLakeArtifactPath(
        "../deployment",
        "prod",
        "spark-job",
        contentHash,
        "job.jar",
      ),
    ).toThrow(/unsafe/i);
    expect(() =>
      buildOneLakeArtifactPath(
        "deployment",
        "prod",
        "spark-job",
        "A".repeat(64),
        "job.jar",
      ),
    ).toThrow(/lowercase SHA-256/i);
  });

  it("builds an encoded ABFSS URI without changing the stored path", () => {
    const oneLakePath = "Files/folder name/a#b.jar";
    expect(
      buildOneLakeAbfssUri(
        DFS_ENDPOINT,
        WORKSPACE_ID,
        LAKEHOUSE_ID,
        oneLakePath,
      ),
    ).toBe(
      `abfss://${WORKSPACE_ID}@onelake.dfs.fabric.microsoft.com/${LAKEHOUSE_ID}/Files/folder%20name/a%23b.jar`,
    );
    expect(oneLakePath).toBe("Files/folder name/a#b.jar");
    expect(() =>
      buildOneLakeAbfssUri(
        "http://onelake.dfs.fabric.microsoft.com/path",
        WORKSPACE_ID,
        LAKEHOUSE_ID,
        oneLakePath,
      ),
    ).toThrow(/HTTPS root/i);
    expect(() =>
      buildOneLakeAbfssUri(
        DFS_ENDPOINT,
        "workspace",
        LAKEHOUSE_ID,
        oneLakePath,
      ),
    ).toThrow(/GUID/i);
  });
});

describe("OneLake artifact inspection", () => {
  it("recomputes content hashes for exact and mismatched objects", async () => {
    const approved = Buffer.from("approved");
    const desired = await descriptor(approved);
    const exactFetch = vi.fn(async () =>
      new Response(approved, {
        status: 200,
        headers: {
          etag: '"exact"',
          "x-ms-meta-sha256": "0".repeat(64),
        },
      }),
    );
    const exact = stager(exactFetch);
    await expect(exact.client.inspect(desired)).resolves.toEqual({
      exists: true,
      matches: true,
      observedHash: hash(approved),
      sizeBytes: approved.byteLength,
      etag: '"exact"',
    });
    expect(exact.getToken).toHaveBeenCalledWith(ONELAKE_SCOPE);

    const changed = Buffer.from("changed!");
    const mismatch = stager(
      vi.fn(async () => new Response(changed, { status: 200 })),
    );
    await expect(mismatch.client.inspect(desired)).resolves.toMatchObject({
      exists: true,
      matches: false,
      observedHash: hash(changed),
      sizeBytes: changed.byteLength,
    });
  });

  it("stops streaming when an object exceeds the approved size", async () => {
    const approved = Buffer.from("approved");
    const desired = await descriptor(approved);
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(approved);
        controller.enqueue(Buffer.from("extra"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Response(body, { status: 200 });
      },
    );
    const { client } = stager(fetchImpl);

    await expect(client.inspect(desired)).resolves.toMatchObject({
      exists: true,
      matches: false,
      observedHash: "size-mismatch",
      sizeBytes: approved.byteLength + 5,
    });
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("rejects declared oversized objects without buffering the body", async () => {
    const desired = await descriptor();
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from("must not be buffered"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Response(body, {
          status: 200,
          headers: {
            "content-length": String(
              MAX_ONELAKE_SINGLE_UPLOAD_BYTES + 1,
            ),
          },
        });
      },
    );
    const { client } = stager(fetchImpl);

    await expect(client.inspect(desired)).resolves.toMatchObject({
      exists: true,
      matches: false,
      observedHash: "oversized",
      sizeBytes: MAX_ONELAKE_SINGLE_UPLOAD_BYTES + 1,
    });
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("keeps the request abort signal active while streaming", async () => {
    const desired = await descriptor();
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Response(body, { status: 200 });
      },
    );
    const { client } = stager(fetchImpl, "storage-secret", 10);

    await expect(client.inspect(desired)).rejects.toThrow(
      /object download failed/i,
    );
    expect(cancelled).toBe(true);
    expect(requestSignal?.aborted).toBe(true);
  });

  it("returns absent only after the DFS Files root is accessible", async () => {
    const desired = await descriptor();
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(`${init?.method} ${String(input)}`);
      if (init?.method === "GET") {
        return new Response("not found", { status: 404 });
      }
      return new Response(undefined, { status: 200 });
    });
    const { client } = stager(fetchImpl);
    await expect(client.inspect(desired)).resolves.toEqual({
      exists: false,
      matches: false,
      observedHash: "",
    });
    expect(requests[1]).toBe(
      `HEAD ${DFS_ENDPOINT}/${WORKSPACE_ID}/${LAKEHOUSE_ID}/Files`,
    );
  });

  it("fails closed when a missing object's Files root is inaccessible", async () => {
    const desired = await descriptor();
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) =>
      init?.method === "GET"
        ? new Response("missing", { status: 404 })
        : new Response("tenant-secret-body", {
            status: 403,
            headers: {
              "x-ms-error-code": "AuthorizationFailure",
              "x-ms-request-id": "root-request",
            },
          }),
    );
    const { client } = stager(fetchImpl);
    const error = await client.inspect(desired).catch((value: unknown) => value);
    expect(String(error)).toContain("status 403");
    expect(String(error)).toContain("AuthorizationFailure");
    expect(String(error)).toContain("root-request");
    expect(String(error)).not.toContain("tenant-secret-body");
  });
});

describe("OneLake immutable uploads", () => {
  it("verifies a 412 directory as a directory before continuing", async () => {
    const content = Buffer.from("directory verification");
    const desired = await descriptor(
      content,
      "Files/existing/artifact.jar",
    );
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "PUT" && url.includes("resource=directory")) {
        return new Response("exists", { status: 412 });
      }
      if (method === "HEAD") {
        return new Response(undefined, {
          status: 200,
          headers: { "x-ms-resource-type": "directory" },
        });
      }
      if (method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      return new Response(content, { status: 200 });
    });
    const { client } = stager(fetchImpl);
    await expect(client.uploadImmutable(desired)).resolves.toMatchObject({
      matches: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "PUT",
      "HEAD",
      "PUT",
      "GET",
    ]);
  });

  it("verifies OneLake PathAlreadyExists conflicts before continuing", async () => {
    const content = Buffer.from("existing OneLake directory");
    const desired = await descriptor(
      content,
      "Files/existing/artifact.jar",
    );
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (method === "PUT" && url.includes("resource=directory")) {
        return new Response("exists", {
          status: 409,
          headers: { "x-ms-error-code": "PathAlreadyExists" },
        });
      }
      if (method === "HEAD") {
        return new Response(undefined, {
          status: 200,
          headers: { "x-ms-resource-type": "directory" },
        });
      }
      if (method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      return new Response(content, { status: 200 });
    });
    const { client } = stager(fetchImpl);

    await expect(client.uploadImmutable(desired)).resolves.toMatchObject({
      matches: true,
    });
    expect(calls.map((call) => call.method)).toEqual([
      "PUT",
      "HEAD",
      "PUT",
      "GET",
    ]);
  });

  it("sends one atomic Blob PUT with approved headers, body, and hooks", async () => {
    const content = Buffer.from("atomic upload");
    const desired = await descriptor(content);
    let blobPut:
      | { init: RequestInit; body: Buffer; url: string }
      | undefined;
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.startsWith(BLOB_ENDPOINT)) {
        events.push("dispatch");
        blobPut = {
          url,
          init,
          body: Buffer.from(init.body as Uint8Array),
        };
        return new Response(undefined, { status: 201 });
      }
      if (init?.method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      return new Response(content, {
        status: 200,
        headers: { etag: '"uploaded"' },
      });
    });
    const { client, getToken } = stager(fetchImpl);
    const inspection = await client.uploadImmutable(desired, {
      onUploadSubmitting: () => events.push("submitting"),
      onUploadVerified: () => events.push("verified"),
    });

    expect(inspection.matches).toBe(true);
    expect(events).toEqual(["submitting", "dispatch", "verified"]);
    expect(blobPut?.url).toBe(
      `${BLOB_ENDPOINT}/${WORKSPACE_ID}/${LAKEHOUSE_ID}/${desired.oneLakePath}`,
    );
    expect(blobPut?.body).toEqual(content);
    const requestHeaders = headers(blobPut?.init);
    expect(requestHeaders.get("authorization")).toBe(
      "Bearer storage-secret",
    );
    expect(requestHeaders.get("x-ms-version")).toBe(
      ONE_LAKE_STORAGE_API_VERSION,
    );
    expect(requestHeaders.get("x-ms-date")).toBe(
      "Sat, 18 Jul 2026 00:00:00 GMT",
    );
    expect(requestHeaders.get("x-ms-client-request-id")).toBe(REQUEST_ID);
    expect(requestHeaders.get("x-ms-blob-type")).toBe("BlockBlob");
    expect(requestHeaders.get("if-none-match")).toBe("*");
    expect(requestHeaders.get("content-length")).toBe(
      String(content.byteLength),
    );
    expect(requestHeaders.get("content-type")).toBe(
      "application/java-archive",
    );
    expect(requestHeaders.get("content-md5")).toBe(
      createHash("md5").update(content).digest("base64"),
    );
    expect(requestHeaders.get("x-ms-meta-sha256")).toBe(hash(content));
    expect(requestHeaders.get("x-ms-meta-size")).toBe(
      String(content.byteLength),
    );
    expect(getToken.mock.calls.every(([scope]) => scope === ONELAKE_SCOPE)).toBe(
      true,
    );
  });

  it("accepts a preexisting exact object after a conditional 412", async () => {
    const content = Buffer.from("already present");
    const desired = await descriptor(content);
    let objectGets = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.startsWith(BLOB_ENDPOINT)) {
        return new Response("condition failed", { status: 412 });
      }
      if (init?.method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      objectGets += 1;
      return new Response(content, { status: 200 });
    });
    const { client } = stager(fetchImpl);
    await expect(client.uploadImmutable(desired)).resolves.toMatchObject({
      exists: true,
      matches: true,
    });
    expect(objectGets).toBe(2);
  });

  it("rejects preexisting mismatched immutable content", async () => {
    const desired = await descriptor(Buffer.from("approved"));
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.startsWith(BLOB_ENDPOINT)) {
        return new Response(undefined, { status: 412 });
      }
      if (init?.method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      return new Response("different", { status: 200 });
    });
    const { client } = stager(fetchImpl);
    await expect(client.uploadImmutable(desired)).rejects.toThrow(
      /existing mismatched content/i,
    );
    expect(
      fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("recovers an ambiguous successful PUT by inspecting before retrying", async () => {
    const content = Buffer.from("committed despite disconnect");
    const desired = await descriptor(content);
    let blobPuts = 0;
    let objectGets = 0;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" && url.startsWith(BLOB_ENDPOINT)) {
        blobPuts += 1;
        throw new Error("socket closed with secret details");
      }
      if (init?.method === "PUT") {
        return new Response(undefined, { status: 201 });
      }
      objectGets += 1;
      return new Response(content, { status: 200 });
    });
    const { client } = stager(fetchImpl);
    await expect(client.uploadImmutable(desired)).resolves.toMatchObject({
      matches: true,
    });
    expect(blobPuts).toBe(1);
    expect(objectGets).toBe(2);
  });

  it("rejects local source drift before any network mutation", async () => {
    const desired = await descriptor(Buffer.from("approved"));
    await writeFile(desired.sourcePath, "changed!");
    const fetchImpl = vi.fn(async () => new Response(undefined, { status: 201 }));
    const { client } = stager(fetchImpl);
    await expect(client.uploadImmutable(desired)).rejects.toThrow(
      /changed after approval/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes storage errors and never includes response bodies or tokens", async () => {
    const desired = await descriptor();
    const fetchImpl = vi.fn(async () =>
      new Response(
        "body-secret storage-secret https://signed.example/?sig=secret",
        {
          status: 409,
          headers: {
            "x-ms-error-code": "PathConflict",
            "x-ms-request-id": "safe-request-id",
          },
        },
      ),
    );
    const { client } = stager(fetchImpl);
    const error = await client.inspect(desired).catch((value: unknown) => value);
    expect(String(error)).toContain("status 409");
    expect(String(error)).toContain("PathConflict");
    expect(String(error)).toContain("safe-request-id");
    expect(String(error)).not.toContain("body-secret");
    expect(String(error)).not.toContain("storage-secret");
    expect(String(error)).not.toContain("sig=secret");
  });
});
