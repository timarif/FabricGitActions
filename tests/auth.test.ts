import { describe, expect, it, vi } from "vitest";

import {
  EntraTokenProvider,
  GITHUB_OIDC_AUDIENCE,
} from "../src/fabric/auth";

describe("Microsoft Entra token provider", () => {
  it("exchanges a GitHub OIDC assertion and caches the access token", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_assertion")).toBe("github-assertion");
      expect(form.get("scope")).toBe("fabric-scope");
      return new Response(
        JSON.stringify({ access_token: "fabric-token", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const getOidcToken = vi.fn(async (audience: string) => {
      expect(audience).toBe(GITHUB_OIDC_AUDIENCE);
      return "github-assertion";
    });
    const masked: string[] = [];
    const provider = new EntraTokenProvider({
      mode: "oidc",
      tenantId: "tenant",
      clientId: "client",
      getOidcToken,
      fetchImpl,
      maskSecret: (value) => masked.push(value),
      now: () => 1000,
    });

    await expect(provider.getToken("fabric-scope")).resolves.toBe("fabric-token");
    await expect(provider.getToken("fabric-scope")).resolves.toBe("fabric-token");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getOidcToken).toHaveBeenCalledTimes(1);
    expect(masked).toEqual(["github-assertion", "fabric-token"]);
  });

  it("uses a client secret only for service-principal-secret mode", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBe("secret");
      expect(form.has("client_assertion")).toBe(false);
      return new Response(
        JSON.stringify({ access_token: "token", expires_in: 3600 }),
        { status: 200 },
      );
    });
    const provider = new EntraTokenProvider({
      mode: "service-principal-secret",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
    });

    await expect(provider.getToken("scope")).resolves.toBe("token");
  });

  it("rejects insecure authority hosts", () => {
    expect(
      () =>
        new EntraTokenProvider({
          mode: "service-principal-secret",
          tenantId: "tenant",
          clientId: "client",
          clientSecret: "secret",
          authorityHost: "http://login.example.test",
        }),
    ).toThrow("authority-host must use HTTPS");
  });

  it("times out a GitHub OIDC assertion that never resolves", async () => {
    const provider = new EntraTokenProvider({
      mode: "oidc",
      tenantId: "tenant",
      clientId: "client",
      getOidcToken: async () => new Promise<string>(() => undefined),
      requestTimeoutMs: 5,
    });

    await expect(provider.getToken("scope")).rejects.toThrow(
      "GitHub OIDC token acquisition timed out",
    );
  });

  it("times out while reading a stalled token response body", async () => {
    const provider = new EntraTokenProvider({
      mode: "service-principal-secret",
      tenantId: "tenant",
      clientId: "client",
      clientSecret: "secret",
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
    });

    await expect(provider.getToken("scope")).rejects.toThrow("timed out");
  });
});
