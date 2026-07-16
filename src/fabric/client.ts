import type { FetchLike, TokenProvider } from "./auth";

export interface FabricClientOptions {
  endpoint: string;
  scope: string;
  tokenProvider: TokenProvider;
  fetchImpl?: FetchLike;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  operationTimeoutMs?: number;
  operationPollIntervalMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface FabricResponse<T> {
  status: number;
  headers: Headers;
  body: T | undefined;
}

export interface FabricRequestOptions {
  body?: unknown;
  retryable?: boolean;
  acceptedStatuses?: number[];
  deadlineMs?: number;
}

interface FabricErrorBody {
  errorCode?: unknown;
  message?: unknown;
  moreDetails?: unknown;
  error?: {
    errorCode?: unknown;
    code?: unknown;
    message?: unknown;
  };
}

interface OperationState {
  status?: unknown;
  error?: unknown;
}

interface Page<T> {
  value?: unknown;
  continuationToken?: unknown;
  continuationUri?: unknown;
}

export class FabricApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "FabricApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export class FabricClient {
  private readonly options: Required<
    Pick<
      FabricClientOptions,
      | "maxRetries"
      | "retryBaseDelayMs"
      | "operationTimeoutMs"
      | "operationPollIntervalMs"
      | "requestTimeoutMs"
      | "sleep"
      | "now"
    >
  > &
    FabricClientOptions;
  private readonly endpointUrl: URL;

  constructor(options: FabricClientOptions) {
    this.endpointUrl = new URL(options.endpoint);
    this.options = {
      ...options,
      maxRetries: options.maxRetries ?? 4,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 1000,
      operationTimeoutMs: options.operationTimeoutMs ?? 20 * 60 * 1000,
      operationPollIntervalMs: options.operationPollIntervalMs ?? 5000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      sleep:
        options.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => {
            setTimeout(resolve, milliseconds);
          })),
      now: options.now ?? Date.now,
    };
  }

  async request<T>(
    method: string,
    pathOrUrl: string,
    requestOptions: FabricRequestOptions = {},
  ): Promise<FabricResponse<T>> {
    const url = this.resolveUrl(pathOrUrl);
    const retryable =
      requestOptions.retryable ?? ["GET", "HEAD"].includes(method.toUpperCase());
    const requestDeadline = Math.min(
      requestOptions.deadlineMs ?? Number.POSITIVE_INFINITY,
      this.options.now() + this.options.requestTimeoutMs,
    );
    let attempt = 0;

    while (true) {
      const token = await withTimeout(
        this.options.tokenProvider.getToken(this.options.scope),
        remainingTime(
          requestDeadline,
          this.options.now(),
          "Fabric API request timed out.",
        ),
        "Fabric API token acquisition timed out.",
      );
      let response: Response;
      let body: unknown;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        remainingTime(
          requestDeadline,
          this.options.now(),
          "Fabric API request timed out.",
        ),
      );
      try {
        response = await (this.options.fetchImpl ?? fetch)(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(requestOptions.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body:
            requestOptions.body === undefined
              ? undefined
              : JSON.stringify(requestOptions.body),
          signal: controller.signal,
        });
        if (
          !(
            retryable &&
            isTransientStatus(response.status) &&
            attempt < this.options.maxRetries
          )
        ) {
          body = await withTimeout(
            parseResponseBody(response),
            remainingTime(
              requestDeadline,
              this.options.now(),
              "Fabric API response body timed out.",
            ),
            "Fabric API response body timed out.",
          );
        }
      } catch (error) {
        if (!retryable || attempt >= this.options.maxRetries) {
          throw error;
        }
        await this.sleepWithinDeadline(
          this.backoffDelay(attempt),
          requestDeadline,
        );
        attempt += 1;
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (
        retryable &&
        isTransientStatus(response.status) &&
        attempt < this.options.maxRetries
      ) {
        await cancelResponseBody(response);
        await this.sleepWithinDeadline(
          retryAfterMilliseconds(response.headers, this.options.now()) ??
            this.backoffDelay(attempt),
          requestDeadline,
        );
        attempt += 1;
        continue;
      }

      const accepted =
        requestOptions.acceptedStatuses?.includes(response.status) ?? response.ok;
      if (!accepted) {
        throw createFabricApiError(response, body);
      }

      return {
        status: response.status,
        headers: response.headers,
        body: body as T | undefined,
      };
    }
  }

  async listAll<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    const visited = new Set<string>();
    let nextUrl: string | undefined = path;

    while (nextUrl) {
      const resolved = this.resolveUrl(nextUrl);
      if (visited.has(resolved)) {
        throw new Error("Fabric pagination returned a repeated continuation URI.");
      }
      visited.add(resolved);

      const response = await this.request<Page<T>>("GET", resolved);
      const page = response.body;
      if (!page || !Array.isArray(page.value)) {
        throw new Error("Fabric list response is missing the value array.");
      }
      values.push(...(page.value as T[]));

      if (typeof page.continuationUri === "string" && page.continuationUri) {
        nextUrl = page.continuationUri;
      } else if (
        typeof page.continuationToken === "string" &&
        page.continuationToken
      ) {
        const continuation = new URL(resolved);
        continuation.searchParams.set(
          "continuationToken",
          page.continuationToken,
        );
        nextUrl = continuation.toString();
      } else {
        nextUrl = undefined;
      }
    }

    return values;
  }

  async waitForOperation<T>(
    initialResponse: FabricResponse<unknown>,
  ): Promise<T> {
    if (initialResponse.status !== 202) {
      if (initialResponse.body === undefined) {
        throw new Error("Fabric response did not contain an operation result.");
      }
      return initialResponse.body as T;
    }

    const operationId = initialResponse.headers.get("x-ms-operation-id");
    const location = initialResponse.headers.get("location");
    if (!operationId && !location) {
      throw new Error(
        "Fabric long-running operation response is missing Location and x-ms-operation-id.",
      );
    }

    const pollUrl =
      location ?? `${this.options.endpoint}/v1/operations/${operationId}`;
    const startedAt = this.options.now();
    const deadline = startedAt + this.options.operationTimeoutMs;
    let delay =
      retryAfterMilliseconds(initialResponse.headers, this.options.now()) ??
      this.options.operationPollIntervalMs;

    while (this.options.now() < deadline) {
      const remaining = deadline - this.options.now();
      await this.options.sleep(Math.min(delay, remaining));
      if (this.options.now() >= deadline) {
        break;
      }
      const poll = await this.request<OperationState>("GET", pollUrl, {
        deadlineMs: deadline,
      });
      const status =
        typeof poll.body?.status === "string" ? poll.body.status : "Undefined";

      if (status === "Succeeded") {
        const returnedLocation = poll.headers.get("location");
        const resultUrl =
          returnedLocation && returnedLocation !== pollUrl
            ? returnedLocation
            : operationId
              ? `${this.options.endpoint}/v1/operations/${operationId}/result`
              : `${pollUrl.replace(/\/$/, "")}/result`;
        const result = await this.request<T>("GET", resultUrl, {
          deadlineMs: deadline,
        });
        if (result.body === undefined) {
          throw new Error("Fabric operation result response is empty.");
        }
        return result.body;
      }

      if (status === "Failed") {
        throw new Error(
          `Fabric long-running operation failed: ${safeOperationError(
            poll.body?.error,
          )}`,
        );
      }

      delay =
        retryAfterMilliseconds(poll.headers, this.options.now()) ??
        this.options.operationPollIntervalMs;
    }

    throw new Error(
      `Fabric long-running operation timed out after ${this.options.operationTimeoutMs} ms.`,
    );
  }

  private resolveUrl(pathOrUrl: string): string {
    const url = new URL(pathOrUrl, `${this.options.endpoint}/`);
    if (url.origin !== this.endpointUrl.origin) {
      throw new Error(
        `Fabric response attempted to access an unexpected origin: ${url.origin}`,
      );
    }
    return url.toString();
  }

  private backoffDelay(attempt: number): number {
    return this.options.retryBaseDelayMs * 2 ** attempt;
  }

  private async sleepWithinDeadline(
    requestedDelay: number,
    deadline: number,
  ): Promise<void> {
    const remaining = remainingTime(
      deadline,
      this.options.now(),
      "Fabric API request timed out.",
    );
    await this.options.sleep(Math.min(requestedDelay, remaining));
  }
}

function isTransientStatus(status: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function retryAfterMilliseconds(
  headers: Headers,
  now: number = Date.now(),
): number | undefined {
  const value = headers.get("retry-after");
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - now);
  }
  return undefined;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body might already be closed by a custom fetch implementation.
  }
}

function remainingTime(
  deadline: number,
  now: number,
  message: string,
): number {
  const remaining = deadline - now;
  if (remaining <= 0) {
    throw new Error(message);
  }
  return remaining;
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

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function createFabricApiError(
  response: Response,
  body: unknown,
): FabricApiError {
  const errorBody =
    body !== null && typeof body === "object"
      ? (body as FabricErrorBody)
      : undefined;
  const nested = errorBody?.error;
  const code = firstString(
    nested?.errorCode,
    nested?.code,
    errorBody?.errorCode,
  );
  const message =
    firstString(nested?.message, errorBody?.message) ??
    `Fabric API request failed with status ${response.status}.`;
  const requestId =
    response.headers.get("requestid") ??
    response.headers.get("x-ms-request-id") ??
    undefined;
  return new FabricApiError(
    `${message}${requestId ? ` (request ID: ${requestId})` : ""}`,
    response.status,
    code,
    requestId,
  );
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function safeOperationError(error: unknown): string {
  if (error === null || typeof error !== "object") {
    return "unknown error";
  }
  const value = error as Record<string, unknown>;
  return (
    firstString(value.message, value.errorCode, value.code) ?? "unknown error"
  );
}
