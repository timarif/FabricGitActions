import { describe, expect, it } from "vitest";

import { parseFabricEndpoints } from "../src/fabric/config";

describe("Fabric endpoint configuration", () => {
  it("normalizes endpoint trailing slashes", () => {
    expect(
      parseFabricEndpoints(
        "https://api.fabric.microsoft.com/",
        "https://onelake.dfs.fabric.microsoft.com/",
      ),
    ).toEqual({
      fabricApiEndpoint: "https://api.fabric.microsoft.com",
      oneLakeEndpoint: "https://onelake.dfs.fabric.microsoft.com",
    });
  });

  it("rejects endpoint credentials and insecure remote endpoints", () => {
    expect(() =>
      parseFabricEndpoints(
        "https://user:password@example.test",
        "https://onelake.example.test",
      ),
    ).toThrow("must not contain credentials");
    expect(() =>
      parseFabricEndpoints(
        "http://api.example.test",
        "https://onelake.example.test",
      ),
    ).toThrow("must use HTTPS");
  });
});
