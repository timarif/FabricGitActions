export const FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";
export const ONELAKE_SCOPE = "https://storage.azure.com/.default";
export const GITHUB_OIDC_AUDIENCE = "api://AzureADTokenExchange";

export type AuthMode = "oidc" | "service-principal-secret";
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface TokenProvider {
  getToken(scope: string): Promise<string>;
}

export interface EntraTokenProviderOptions {
  mode: AuthMode;
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  authorityHost?: string;
  getOidcToken?: (audience: string) => Promise<string>;
  fetchImpl?: FetchLike;
  maskSecret?: (value: string) => void;
  now?: () => number;
  requestTimeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export class EntraTokenProvider implements TokenProvider {
  private readonly options: EntraTokenProviderOptions;
  private readonly cache = new Map<string, CachedToken>();

  constructor(options: EntraTokenProviderOptions) {
    this.options = options;
    validateAuthOptions(options);
    if (options.clientSecret) {
      options.maskSecret?.(options.clientSecret);
    }
  }

  async getToken(scope: string): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(scope);
    if (cached && cached.expiresAt - now > 5 * 60 * 1000) {
      return cached.accessToken;
    }

    const accessToken = await this.requestToken(scope);
    this.cache.set(scope, accessToken);
    return accessToken.accessToken;
  }

  private async requestToken(scope: string): Promise<CachedToken> {
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 30_000;
    const deadline = Date.now() + requestTimeoutMs;
    const authorityHost = normalizeAuthorityHost(
      this.options.authorityHost ?? "https://login.microsoftonline.com",
    );
    const tokenUrl = `${authorityHost}/${encodeURIComponent(
      this.options.tenantId,
    )}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: this.options.clientId,
      grant_type: "client_credentials",
      scope,
    });

    if (this.options.mode === "oidc") {
      const assertion = await withTimeout(
        this.options.getOidcToken?.(GITHUB_OIDC_AUDIENCE) ??
          Promise.resolve(""),
        remainingMilliseconds(deadline),
        "GitHub OIDC token acquisition timed out.",
      );
      if (!assertion) {
        throw new Error("GitHub OIDC did not return a client assertion.");
      }
      this.options.maskSecret?.(assertion);
      form.set(
        "client_assertion_type",
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      );
      form.set("client_assertion", assertion);
    } else {
      form.set("client_secret", this.options.clientSecret ?? "");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      remainingMilliseconds(deadline),
    );
    let response: Response;
    let body: TokenResponse;
    try {
      response = await (this.options.fetchImpl ?? fetch)(tokenUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: controller.signal,
      });
      body = (await withTimeout(
        safeJson(response),
        remainingMilliseconds(deadline),
        "Microsoft Entra token response body timed out.",
      )) as TokenResponse;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const code = typeof body.error === "string" ? body.error : "token_error";
      const description =
        typeof body.error_description === "string"
          ? sanitizeIdentityError(body.error_description)
          : "Microsoft Entra token request failed.";
      throw new Error(`Microsoft Entra token request failed (${code}): ${description}`);
    }

    function remainingMilliseconds(deadline: number): number {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("Microsoft Entra token request timed out.");
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

    if (
      typeof body.access_token !== "string" ||
      typeof body.expires_in !== "number"
    ) {
      throw new Error("Microsoft Entra token response is missing required fields.");
    }

    this.options.maskSecret?.(body.access_token);
    const now = (this.options.now ?? Date.now)();
    return {
      accessToken: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
  }
}

function validateAuthOptions(options: EntraTokenProviderOptions): void {
  normalizeAuthorityHost(
    options.authorityHost ?? "https://login.microsoftonline.com",
  );
  if (!options.tenantId) {
    throw new Error("tenant-id is required when Fabric authentication is enabled.");
  }
  if (!options.clientId) {
    throw new Error("client-id is required when Fabric authentication is enabled.");
  }
  if (options.mode === "oidc" && !options.getOidcToken) {
    throw new Error("GitHub OIDC token acquisition is not configured.");
  }
  if (options.mode === "service-principal-secret" && !options.clientSecret) {
    throw new Error(
      "client-secret is required when auth-mode is service-principal-secret.",
    );
  }
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isFinite(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
  ) {
    throw new Error("Authentication request timeout must be greater than zero.");
  }
}

function normalizeAuthorityHost(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error("authority-host must use HTTPS.");
  }
  if (url.search || url.hash) {
    throw new Error("authority-host must not contain a query string or fragment.");
  }
  return url.toString().replace(/\/$/, "");
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sanitizeIdentityError(value: string): string {
  return value.replace(
    /(client_secret|client_assertion|access_token)=([^&\s]+)/gi,
    "$1=***",
  );
}
