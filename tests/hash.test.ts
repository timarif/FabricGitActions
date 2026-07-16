import { describe, expect, it } from "vitest";

import { compareCanonicalStrings, stableJson } from "../src/hash";

describe("canonical hashing helpers", () => {
  it("uses UTF-8 byte order instead of runner locale", () => {
    expect(["ä", "z"].sort(compareCanonicalStrings)).toEqual(["z", "ä"]);
  });

  it("canonicalizes object keys independently of insertion order", () => {
    expect(stableJson({ ä: 1, z: 2 })).toBe(stableJson({ z: 2, ä: 1 }));
  });

  it("matches JSON semantics for undefined optional properties", () => {
    expect(stableJson({ kept: 1, omitted: undefined })).toBe(
      stableJson(JSON.parse(JSON.stringify({ kept: 1, omitted: undefined }))),
    );
  });
});
