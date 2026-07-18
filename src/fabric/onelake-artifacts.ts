import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  ONELAKE_SCOPE,
  type FetchLike,
  type TokenProvider,
} from "./auth";

export const ONE_LAKE_STORAGE_API_VERSION = "2023-08-03";
export const MAX_ONELAKE_SINGLE_UPLOAD_BYTES = 512 * 1024 * 1024;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT_STATUSES = new Set([429, 500, 503]);
const MAX_RETRY_AFTER_MS = 60_000;

export interface OneLakeArtifactDescriptor {
  workspaceId: string;
  lakehouseId: string;
  oneLakePath: string;
  fileName: string;
  sourcePath: string;
  contentHash: string;
  sizeBytes: number;
  contentType?: string;
}

export interface OneLakeArtifactInspection {
  exists: boolean;
  matches: boolean;
  observedHash: string;
  sizeBytes?: number;
  etag?: string;
}

export interface OneLakeArtifactUploadHooks {
  onUploadSubmitting?: () => void;
  onUploadVerified?: () => void;
}

export interface OneLakeArtifactStagerOptions {
  dfsEndpoint: string;
  blobEndpoint: string;
  tokenProvider: TokenProvider;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  randomUUID?: () => string;
}

interface ResolvedOptions {
  dfsEndpoint: string;
  blobEndpoint: string;
  tokenProvider: TokenProvider;
  fetchImpl: FetchLike;
  maxRetries: number;
  retryBaseDelayMs: number;
  requestTimeoutMs: number;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => number;
  randomUUID: () => string;
}

interface ResponseLease {
  response: Response;
  signal: AbortSignal;
  abort: () => void;
  release: () => void;
}

interface HashedResponseBody {
  observedHash: string;
  sizeBytes: number;
  exceededLimit: boolean;
}

export class OneLakeArtifactStager {
  private readonly options: ResolvedOptions;

  constructor(options: OneLakeArtifactStagerOptions) {
    this.options = {
      ...options,
      dfsEndpoint: normalizeOneLakeRootEndpoint(
        options.dfsEndpoint,
        "DFS",
      ),
      blobEndpoint: normalizeOneLakeRootEndpoint(
        options.blobEndpoint,
        "Blob",
      ),
      fetchImpl: options.fetchImpl ?? fetch,
      maxRetries: validateNonNegativeInteger(
        options.maxRetries ?? 4,
        "maxRetries",
      ),
      retryBaseDelayMs: validateNonNegativeNumber(
        options.retryBaseDelayMs ?? 1_000,
        "retryBaseDelayMs",
      ),
      requestTimeoutMs: validatePositiveNumber(
        options.requestTimeoutMs ?? 30_000,
        "requestTimeoutMs",
      ),
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
          })),
      now: options.now ?? Date.now,
      randomUUID: options.randomUUID ?? nodeRandomUUID,
    };
  }

  getEndpointIdentity(): {
    dfsEndpoint: string;
    blobEndpoint: string;
  } {
    return {
      dfsEndpoint: this.options.dfsEndpoint,
      blobEndpoint: this.options.blobEndpoint,
    };
  }

  async inspect(
    descriptor: OneLakeArtifactDescriptor,
  ): Promise<OneLakeArtifactInspection> {
    validateDescriptor(descriptor);
    const objectUrl = buildObjectUrl(
      this.options.blobEndpoint,
      descriptor.workspaceId,
      descriptor.lakehouseId,
      descriptor.oneLakePath,
    );
    const lease = await this.requestWithRetriesRetained("GET", objectUrl);
    const response = lease.response;

    if (response.status === 200) {
      try {
        const declaredSize = contentLength(response.headers);
        if (
          declaredSize !== undefined &&
          declaredSize > MAX_ONELAKE_SINGLE_UPLOAD_BYTES
        ) {
          lease.abort();
          await cancelResponseBody(response);
          return mismatchedInspection(
            response,
            "oversized",
            declaredSize,
          );
        }
        if (
          declaredSize !== undefined &&
          declaredSize !== descriptor.sizeBytes
        ) {
          lease.abort();
          await cancelResponseBody(response);
          return mismatchedInspection(
            response,
            "size-mismatch",
            declaredSize,
          );
        }

        const body = await hashResponseBody(
          response,
          Math.min(
            descriptor.sizeBytes,
            MAX_ONELAKE_SINGLE_UPLOAD_BYTES,
          ),
          this.options.requestTimeoutMs,
          lease.signal,
          lease.abort,
        );
        if (body.exceededLimit) {
          return mismatchedInspection(
            response,
            "size-mismatch",
            body.sizeBytes,
          );
        }
        return {
          exists: true,
          matches:
            body.sizeBytes === descriptor.sizeBytes &&
            body.observedHash === descriptor.contentHash,
          observedHash: body.observedHash,
          sizeBytes: body.sizeBytes,
          ...(response.headers.get("etag")
            ? { etag: response.headers.get("etag")! }
            : {}),
        };
      } finally {
        lease.release();
      }
    }

    if (response.status !== 404) {
      try {
        await throwStorageError("inspect object", response);
      } finally {
        lease.release();
      }
    }
    await cancelResponseBody(response);
    lease.release();

    const filesRootUrl = buildObjectUrl(
      this.options.dfsEndpoint,
      descriptor.workspaceId,
      descriptor.lakehouseId,
      "Files",
    );
    const rootResponse = await this.requestWithRetries("HEAD", filesRootUrl);
    if (rootResponse.status !== 200) {
      await throwStorageError("check Files root", rootResponse);
    }
    await cancelResponseBody(rootResponse);
    return {
      exists: false,
      matches: false,
      observedHash: "",
    };
  }

  async verify(
    descriptor: OneLakeArtifactDescriptor,
  ): Promise<OneLakeArtifactInspection> {
    const inspection = await this.inspect(descriptor);
    if (!inspection.matches) {
      throw new Error(
        inspection.exists
          ? "OneLake artifact content does not match the approved artifact."
          : "OneLake artifact does not exist.",
      );
    }
    return inspection;
  }

  async uploadImmutable(
    descriptor: OneLakeArtifactDescriptor,
    hooks: OneLakeArtifactUploadHooks = {},
  ): Promise<OneLakeArtifactInspection> {
    validateDescriptor(descriptor);
    const source = await this.readApprovedSource(descriptor);
    await this.createDirectories(descriptor);
    await this.putImmutableObject(descriptor, source, hooks);
    const verified = await this.verify(descriptor);
    hooks.onUploadVerified?.();
    return verified;
  }

  private async readApprovedSource(
    descriptor: OneLakeArtifactDescriptor,
  ): Promise<Buffer> {
    let sourceStat;
    try {
      sourceStat = await stat(descriptor.sourcePath);
    } catch {
      throw new Error("Local artifact source could not be read.");
    }
    if (!sourceStat.isFile()) {
      throw new Error("Local artifact source is not a file.");
    }
    if (
      sourceStat.size > MAX_ONELAKE_SINGLE_UPLOAD_BYTES ||
      descriptor.sizeBytes > MAX_ONELAKE_SINGLE_UPLOAD_BYTES
    ) {
      throw new Error(
        "OneLake immutable single-upload artifacts are limited to 512 MiB.",
      );
    }
    if (sourceStat.size !== descriptor.sizeBytes) {
      throw new Error("Local artifact source size changed after approval.");
    }

    let source: Buffer;
    try {
      source = await readFile(descriptor.sourcePath);
    } catch {
      throw new Error("Local artifact source could not be read.");
    }
    if (
      source.byteLength !== descriptor.sizeBytes ||
      sha256(source) !== descriptor.contentHash
    ) {
      throw new Error("Local artifact source changed after approval.");
    }
    return source;
  }

  private async createDirectories(
    descriptor: OneLakeArtifactDescriptor,
  ): Promise<void> {
    const pathSegments = splitOneLakePath(descriptor.oneLakePath);
    const directorySegments = pathSegments.slice(1, -1);
    for (let index = 0; index < directorySegments.length; index += 1) {
      const directoryPath = [
        "Files",
        ...directorySegments.slice(0, index + 1),
      ].join("/");
      const directoryUrl = new URL(
        buildObjectUrl(
          this.options.dfsEndpoint,
          descriptor.workspaceId,
          descriptor.lakehouseId,
          directoryPath,
        ),
      );
      directoryUrl.searchParams.set("resource", "directory");
      const response = await this.requestWithRetries(
        "PUT",
        directoryUrl.toString(),
        {
          "if-none-match": "*",
          "content-length": "0",
        },
      );
      if (response.status === 201) {
        await cancelResponseBody(response);
        continue;
      }
      const errorCode = response.headers
        .get("x-ms-error-code")
        ?.toLowerCase();
      if (
        response.status !== 412 &&
        !(response.status === 409 && errorCode === "pathalreadyexists")
      ) {
        await throwStorageError("create directory", response);
      }
      await cancelResponseBody(response);

      const headResponse = await this.requestWithRetries(
        "HEAD",
        buildObjectUrl(
          this.options.dfsEndpoint,
          descriptor.workspaceId,
          descriptor.lakehouseId,
          directoryPath,
        ),
      );
      if (
        headResponse.status !== 200 ||
        headResponse.headers.get("x-ms-resource-type")?.toLowerCase() !==
          "directory"
      ) {
        if (headResponse.status !== 200) {
          await throwStorageError("verify directory", headResponse);
        }
        await cancelResponseBody(headResponse);
        throw new Error(
          "OneLake path conflict: an existing path component is not a directory.",
        );
      }
      await cancelResponseBody(headResponse);
    }
  }

  private async putImmutableObject(
    descriptor: OneLakeArtifactDescriptor,
    source: Buffer,
    hooks: OneLakeArtifactUploadHooks,
  ): Promise<void> {
    const objectUrl = buildObjectUrl(
      this.options.blobEndpoint,
      descriptor.workspaceId,
      descriptor.lakehouseId,
      descriptor.oneLakePath,
    );
    const headers: Record<string, string> = {
      "x-ms-blob-type": "BlockBlob",
      "if-none-match": "*",
      "content-length": String(source.byteLength),
      "content-type": descriptor.contentType ?? "application/octet-stream",
      "content-md5": createHash("md5").update(source).digest("base64"),
      "x-ms-meta-sha256": descriptor.contentHash,
      "x-ms-meta-size": String(descriptor.sizeBytes),
    };

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.dispatch("PUT", objectUrl, headers, source, () => {
          hooks.onUploadSubmitting?.();
        });
      } catch {
        const recovered = await this.inspectAfterAmbiguousPut(descriptor);
        if (recovered) {
          return;
        }
        if (attempt >= this.options.maxRetries) {
          throw new Error(
            "OneLake immutable upload remained ambiguous after verification.",
          );
        }
        await this.options.sleep(this.backoffDelay(attempt));
        continue;
      }

      if (response.status === 201) {
        await cancelResponseBody(response);
        return;
      }
      if (response.status === 412) {
        await cancelResponseBody(response);
        const inspection = await this.inspect(descriptor);
        if (inspection.matches) {
          return;
        }
        throw new Error(
          "OneLake immutable upload found existing mismatched content.",
        );
      }
      if (TRANSIENT_STATUSES.has(response.status)) {
        const retryDelay =
          retryAfterMilliseconds(response.headers, this.options.now()) ??
          this.backoffDelay(attempt);
        await cancelResponseBody(response);
        const recovered = await this.inspectAfterAmbiguousPut(descriptor);
        if (recovered) {
          return;
        }
        if (attempt >= this.options.maxRetries) {
          throw storageError("upload object", response);
        }
        await this.options.sleep(retryDelay);
        continue;
      }
      await throwStorageError("upload object", response);
    }
  }

  private async inspectAfterAmbiguousPut(
    descriptor: OneLakeArtifactDescriptor,
  ): Promise<boolean> {
    const inspection = await this.inspect(descriptor);
    if (inspection.matches) {
      return true;
    }
    if (inspection.exists) {
      throw new Error(
        "OneLake immutable upload found existing mismatched content.",
      );
    }
    return false;
  }

  private async requestWithRetries(
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const lease = await this.requestWithRetriesRetained(
      method,
      url,
      headers,
    );
    lease.release();
    return lease.response;
  }

  private async requestWithRetriesRetained(
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ): Promise<ResponseLease> {
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      let lease: ResponseLease;
      try {
        lease = await this.dispatchRetained(method, url, headers);
      } catch {
        if (attempt >= this.options.maxRetries) {
          throw new Error(`OneLake ${method} request failed.`);
        }
        await this.options.sleep(this.backoffDelay(attempt));
        continue;
      }
      const response = lease.response;
      if (
        TRANSIENT_STATUSES.has(response.status) &&
        attempt < this.options.maxRetries
      ) {
        const delay =
          retryAfterMilliseconds(response.headers, this.options.now()) ??
          this.backoffDelay(attempt);
        await cancelResponseBody(response);
        lease.release();
        await this.options.sleep(delay);
        continue;
      }
      return lease;
    }
    throw new Error(`OneLake ${method} request failed.`);
  }

  private async dispatch(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: Buffer,
    onDispatch?: () => void,
  ): Promise<Response> {
    const lease = await this.dispatchRetained(
      method,
      url,
      headers,
      body,
      onDispatch,
    );
    lease.release();
    return lease.response;
  }

  private async dispatchRetained(
    method: string,
    url: string,
    headers: Record<string, string> = {},
    body?: Buffer,
    onDispatch?: () => void,
  ): Promise<ResponseLease> {
    const token = await withTimeout(
      this.options.tokenProvider.getToken(ONELAKE_SCOPE),
      this.options.requestTimeoutMs,
      "OneLake token acquisition timed out.",
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.requestTimeoutMs,
    );
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        clearTimeout(timeout);
      }
    };
    const abort = () => {
      controller.abort();
      release();
    };
    try {
      onDispatch?.();
      const response = await withTimeout(
        this.options.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "x-ms-version": ONE_LAKE_STORAGE_API_VERSION,
            "x-ms-date": new Date(this.options.now()).toUTCString(),
            "x-ms-client-request-id": this.options.randomUUID(),
            ...headers,
          },
          ...(body === undefined
            ? {}
            : { body: body as unknown as BodyInit }),
          signal: controller.signal,
        }),
        this.options.requestTimeoutMs,
        "OneLake request timed out.",
      );
      return {
        response,
        signal: controller.signal,
        abort,
        release,
      };
    } catch (error) {
      abort();
      throw error;
    }
  }

  private backoffDelay(attempt: number): number {
    return this.options.retryBaseDelayMs * 2 ** attempt;
  }
}

export function buildOneLakeArtifactPath(
  deploymentId: string,
  environment: string,
  logicalId: string,
  contentHash: string,
  fileName: string,
): string {
  validatePathSegment(deploymentId, "deploymentId");
  validatePathSegment(environment, "environment");
  validatePathSegment(logicalId, "logicalId");
  validatePathSegment(fileName, "fileName");
  validateHash(contentHash);
  return [
    "Files",
    ".fabric-deploy",
    deploymentId,
    environment,
    logicalId,
    contentHash,
    fileName,
  ].join("/");
}

export function buildOneLakeAbfssUri(
  dfsEndpoint: string,
  workspaceId: string,
  lakehouseId: string,
  oneLakePath: string,
): string {
  const endpoint = new URL(
    normalizeOneLakeRootEndpoint(dfsEndpoint, "DFS"),
  );
  validateGuid(workspaceId, "workspaceId");
  validateGuid(lakehouseId, "lakehouseId");
  const encodedPath = splitOneLakePath(oneLakePath)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `abfss://${workspaceId}@${endpoint.host}/${lakehouseId}/${encodedPath}`;
}

function validateDescriptor(descriptor: OneLakeArtifactDescriptor): void {
  validateGuid(descriptor.workspaceId, "workspaceId");
  validateGuid(descriptor.lakehouseId, "lakehouseId");
  validateHash(descriptor.contentHash);
  validatePathSegment(descriptor.fileName, "fileName");
  const segments = splitOneLakePath(descriptor.oneLakePath);
  if (segments[0] !== "Files") {
    throw new Error("oneLakePath must be rooted below Files.");
  }
  if (segments.length < 2 || segments.at(-1) !== descriptor.fileName) {
    throw new Error("oneLakePath must end with fileName.");
  }
  if (!descriptor.sourcePath) {
    throw new Error("sourcePath must not be empty.");
  }
  if (
    !Number.isSafeInteger(descriptor.sizeBytes) ||
    descriptor.sizeBytes < 0
  ) {
    throw new Error("sizeBytes must be a non-negative safe integer.");
  }
}

function splitOneLakePath(value: string): string[] {
  if (!value || value.startsWith("/") || value.endsWith("\\")) {
    throw new Error("OneLake path must be a non-empty relative path.");
  }
  if (value.includes("\\")) {
    throw new Error("OneLake paths must use forward slashes.");
  }
  const segments = value.split("/");
  for (const segment of segments) {
    validatePathSegment(segment, "OneLake path");
  }
  return segments;
}

function validatePathSegment(value: string, name: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} contains an unsafe path segment.`);
  }
}

function validateHash(value: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new Error("contentHash must be a lowercase SHA-256 hash.");
  }
}

function validateGuid(value: string, name: string): void {
  if (!GUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a GUID.`);
  }
}

export function normalizeOneLakeRootEndpoint(
  value: string,
  name: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} endpoint must be a valid HTTPS root URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} endpoint must be an HTTPS root URL.`);
  }
  return url.origin;
}

function buildObjectUrl(
  endpoint: string,
  workspaceId: string,
  lakehouseId: string,
  oneLakePath: string,
): string {
  validateGuid(workspaceId, "workspaceId");
  validateGuid(lakehouseId, "lakehouseId");
  const path = [workspaceId, lakehouseId, ...splitOneLakePath(oneLakePath)]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${endpoint}/${path}`;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

function mismatchedInspection(
  response: Response,
  observedHash: string,
  sizeBytes: number,
): OneLakeArtifactInspection {
  return {
    exists: true,
    matches: false,
    observedHash,
    sizeBytes,
    ...(response.headers.get("etag")
      ? { etag: response.headers.get("etag")! }
      : {}),
  };
}

async function hashResponseBody(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  signal: AbortSignal,
  abort: () => void,
): Promise<HashedResponseBody> {
  if (!response.body) {
    if (signal.aborted) {
      throw new Error("OneLake object download failed.");
    }
    return {
      observedHash: sha256(new Uint8Array()),
      sizeBytes: 0,
      exceededLimit: false,
    };
  }

  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abort();
      void reader.cancel().catch(() => {});
      reject(new Error("OneLake object download timed out."));
    }, timeoutMs);
  });

  try {
    if (signal.aborted) {
      throw new Error("OneLake object download aborted.");
    }
    while (true) {
      const result = await Promise.race([
        reader.read(),
        timeoutPromise,
      ]);
      if (signal.aborted) {
        throw new Error("OneLake object download aborted.");
      }
      if (result.done) {
        break;
      }
      if (!result.value) {
        continue;
      }
      const nextSize = sizeBytes + result.value.byteLength;
      if (nextSize > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Aborting the retained request below also closes the body.
        }
        abort();
        return {
          observedHash: "size-mismatch",
          sizeBytes: nextSize,
          exceededLimit: true,
        };
      }
      hash.update(result.value);
      sizeBytes = nextSize;
    }
    return {
      observedHash: hash.digest("hex"),
      sizeBytes,
      exceededLimit: false,
    };
  } catch {
    abort();
    try {
      await reader.cancel();
    } catch {
      // The abort may already have closed the response body.
    }
    throw new Error("OneLake object download failed.");
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader can remain locked briefly after a transport abort.
    }
  }
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function validatePositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than zero.`);
  }
  return value;
}

function validateNonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be zero or greater.`);
  }
  return value;
}

function retryAfterMilliseconds(
  headers: Headers,
  now: number,
): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay) || delay < 0) {
    return undefined;
  }
  return Math.min(delay, MAX_RETRY_AFTER_MS);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Custom fetch implementations may return an already-consumed body.
  }
}

async function throwStorageError(
  operation: string,
  response: Response,
): Promise<never> {
  await cancelResponseBody(response);
  throw storageError(operation, response);
}

function storageError(operation: string, response: Response): Error {
  const code = response.headers.get("x-ms-error-code");
  const requestId =
    response.headers.get("x-ms-request-id") ??
    response.headers.get("request-id");
  const details = [
    `status ${response.status}`,
    ...(code ? [`code ${sanitizeHeaderValue(code)}`] : []),
    ...(requestId
      ? [`request ID ${sanitizeHeaderValue(requestId)}`]
      : []),
  ].join(", ");
  return new Error(`OneLake ${operation} failed (${details}).`);
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 200);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
