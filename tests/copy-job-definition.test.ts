/**
 * Tests for Copy Job definition loader, validator, and hasher.
 *
 * Tests cover:
 * - loadCopyJobDefinition: file presence, extra fields, jobMode validation
 * - hashCopyJobDefinition: stable hash, platform normalization, include/exclude
 * - hashServerCopyJobDefinition: tolerant projection of portal-managed fields
 * - copyJobIncludesPlatformPart
 * - readCopyJobMode
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyJobIncludesPlatformPart,
  hashCopyJobDefinition,
  hashServerCopyJobDefinition,
  loadCopyJobDefinition,
  readCopyJobMode,
} from "../src/fabric/copy-job-definition";
import type { FabricDefinition } from "../src/fabric/definition";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function base64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const batchContent = {
  properties: { jobMode: "Batch" },
};
const cdcContent = {
  properties: { jobMode: "CDC" },
};
const validPlatform = {
  metadata: {
    type: "CopyJob",
    displayName: "test",
  },
  config: {
    logicalId: "00000000-0000-0000-0000-000000000000",
    version: "2.0",
  },
};

function makeDefinition(
  contentObj: object = batchContent,
  includePlatform = false,
  platformObj: object = validPlatform,
): FabricDefinition {
  const parts: FabricDefinition["parts"] = [
    {
      path: "copyjob-content.json",
      payload: base64(contentObj),
      payloadType: "InlineBase64",
    },
  ];
  if (includePlatform) {
    parts.push({
      path: ".platform",
      payload: base64(platformObj),
      payloadType: "InlineBase64",
    });
  }
  return { parts };
}

function makeTempItemDir(
  contentObj: object = batchContent,
  platformObj?: object,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "copyjob-def-"));
  const defDir = path.join(root, "definition");
  mkdirSync(defDir, { recursive: true });
  writeFileSync(
    path.join(defDir, "copyjob-content.json"),
    JSON.stringify(contentObj),
  );
  if (platformObj) {
    writeFileSync(
      path.join(defDir, ".platform"),
      JSON.stringify(platformObj),
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// loadCopyJobDefinition
// ---------------------------------------------------------------------------

describe("loadCopyJobDefinition", () => {
  it("loads a valid Batch definition", () => {
    const dir = makeTempItemDir({ properties: { jobMode: "Batch" } });
    const def = loadCopyJobDefinition(dir);
    expect(def.parts).toHaveLength(1);
    expect(def.parts[0]!.path).toBe("copyjob-content.json");
  });

  it("loads a valid CDC definition with .platform", () => {
    const dir = makeTempItemDir(
      { properties: { jobMode: "CDC" } },
      validPlatform,
    );
    const def = loadCopyJobDefinition(dir);
    expect(def.parts).toHaveLength(2);
    const paths = def.parts.map((p) => p.path).sort();
    expect(paths).toContain("copyjob-content.json");
    expect(paths).toContain(".platform");
  });

  it("throws when copyjob-content.json is missing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "copyjob-def-"));
    mkdirSync(path.join(root, "definition"), { recursive: true });
    expect(() => loadCopyJobDefinition(root)).toThrow(
      "Copy Job definition must include definition/copyjob-content.json",
    );
  });

  it("throws on extra files in definition directory", () => {
    const dir = makeTempItemDir({ properties: { jobMode: "Batch" } });
    writeFileSync(
      path.join(dir, "definition", "extra.json"),
      "{}",
    );
    expect(() => loadCopyJobDefinition(dir)).toThrow(
      "Unsupported Copy Job definition path",
    );
  });

  it("throws when copyjob-content.json has extra top-level fields", () => {
    expect(() =>
      loadCopyJobDefinition(
        makeTempItemDir({
          properties: { jobMode: "Batch" },
          activities: [],
        }),
      ),
    ).toThrow("unsupported top-level field");
  });

  it("throws when properties has extra fields (activities)", () => {
    expect(() =>
      loadCopyJobDefinition(
        makeTempItemDir({
          properties: { jobMode: "Batch", activities: [] },
        }),
      ),
    ).toThrow("unsupported field");
  });

  it("throws when jobMode is invalid", () => {
    expect(() =>
      loadCopyJobDefinition(
        makeTempItemDir({
          properties: { jobMode: "Streaming" },
        }),
      ),
    ).toThrow("jobMode");
  });

  it("throws when .platform contains sensitivityLabelId", () => {
    expect(() =>
      loadCopyJobDefinition(
        makeTempItemDir(
          { properties: { jobMode: "Batch" } },
          {
            metadata: { type: "CopyJob", displayName: "x" },
            config: { logicalId: "00000000-0000-0000-0000-000000000000" },
            sensitivityLabelId: "some-id",
          },
        ),
      ),
    ).toThrow("sensitivity label");
  });
});

// ---------------------------------------------------------------------------
// hashCopyJobDefinition
// ---------------------------------------------------------------------------

describe("hashCopyJobDefinition", () => {
  it("returns a stable hash for the same definition", () => {
    const def = makeDefinition();
    const h1 = hashCopyJobDefinition(def, false);
    const h2 = hashCopyJobDefinition(def, false);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different hash when jobMode differs", () => {
    const defBatch = makeDefinition(batchContent);
    const defCdc = makeDefinition(cdcContent);
    expect(hashCopyJobDefinition(defBatch, false)).not.toBe(
      hashCopyJobDefinition(defCdc, false),
    );
  });

  it("excludes .platform when includePlatform is false", () => {
    const defNoPlatform = makeDefinition(batchContent, false);
    const defWithPlatform = makeDefinition(batchContent, true);
    expect(hashCopyJobDefinition(defNoPlatform, false)).toBe(
      hashCopyJobDefinition(defWithPlatform, false),
    );
  });

  it("includes .platform when includePlatform is true", () => {
    const defNoPlatform = makeDefinition(batchContent, false);
    const defWithPlatform = makeDefinition(batchContent, true);
    expect(hashCopyJobDefinition(defWithPlatform, true)).not.toBe(
      hashCopyJobDefinition(defNoPlatform, false),
    );
  });

  it("strips config.logicalId from .platform before hashing", () => {
    // Both the zero-sentinel value and an absent logicalId should produce
    // the same hash: normalizePlatform strips logicalId before hashing so
    // the field does not cause spurious drift between items that include
    // the zero GUID and those that omit the field entirely.
    const platformWithZeroId = {
      metadata: { type: "CopyJob", displayName: "t" },
      config: {
        logicalId: "00000000-0000-0000-0000-000000000000",
        version: "2.0",
      },
    };
    const platformWithoutId = {
      metadata: { type: "CopyJob", displayName: "t" },
      config: {
        version: "2.0",
      },
    };
    const def1 = makeDefinition(batchContent, true, platformWithZeroId);
    const def2 = makeDefinition(
      batchContent,
      true,
      platformWithoutId,
    );
    expect(hashCopyJobDefinition(def1, true)).toBe(
      hashCopyJobDefinition(def2, true),
    );
  });

  it("produces different hashes for different .platform displayName", () => {
    const platform1 = {
      metadata: { type: "CopyJob", displayName: "alpha" },
      config: { logicalId: "00000000-0000-0000-0000-000000000000" },
    };
    const platform2 = {
      metadata: { type: "CopyJob", displayName: "beta" },
      config: { logicalId: "00000000-0000-0000-0000-000000000000" },
    };
    const def1 = makeDefinition(batchContent, true, platform1);
    const def2 = makeDefinition(batchContent, true, platform2);
    expect(hashCopyJobDefinition(def1, true)).not.toBe(
      hashCopyJobDefinition(def2, true),
    );
  });
});

// ---------------------------------------------------------------------------
// copyJobIncludesPlatformPart
// ---------------------------------------------------------------------------

describe("copyJobIncludesPlatformPart", () => {
  it("returns false when no .platform part", () => {
    expect(copyJobIncludesPlatformPart(makeDefinition(batchContent, false))).toBe(
      false,
    );
  });

  it("returns true when .platform part is present", () => {
    expect(
      copyJobIncludesPlatformPart(makeDefinition(batchContent, true)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readCopyJobMode
// ---------------------------------------------------------------------------

describe("readCopyJobMode", () => {
  it("returns Batch for a Batch definition", () => {
    expect(readCopyJobMode(makeDefinition(batchContent))).toBe("Batch");
  });

  it("returns CDC for a CDC definition", () => {
    expect(readCopyJobMode(makeDefinition(cdcContent))).toBe("CDC");
  });

  it("throws on missing copyjob-content.json part", () => {
    const badDef: FabricDefinition = {
      parts: [
        {
          path: ".platform",
          payload: base64(validPlatform),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(() => readCopyJobMode(badDef)).toThrow(
      "missing copyjob-content.json",
    );
  });
});

// ---------------------------------------------------------------------------
// .platform config.logicalId sentinel validation (Finding 3)
// ---------------------------------------------------------------------------

describe("loadCopyJobDefinition — .platform config.logicalId sentinel", () => {
  it("rejects .platform with a non-zero config.logicalId", () => {
    // Non-zero logicalId values belong to Git-integrated items and are
    // server-managed; clients cannot set them.  Fail closed to prevent
    // silent hash suppression or accidental Git-integration wiring.
    const badPlatform = {
      metadata: { type: "CopyJob", displayName: "test" },
      config: {
        logicalId: "11111111-1111-1111-1111-111111111111",
        version: "2.0",
      },
    };
    expect(() =>
      loadCopyJobDefinition(makeTempItemDir(batchContent, badPlatform)),
    ).toThrow(/logicalId/i);
  });

  it("accepts .platform without config.logicalId", () => {
    const platformNoId = {
      metadata: { type: "CopyJob", displayName: "test" },
      config: { version: "2.0" },
    };
    const dir = makeTempItemDir(batchContent, platformNoId);
    const def = loadCopyJobDefinition(dir);
    expect(def.parts).toHaveLength(2);
  });

  it("accepts .platform with the zero-sentinel config.logicalId", () => {
    // The zero GUID is the sentinel for non-Git-integrated items;
    // the Fabric service always returns this value.
    const platformZeroId = {
      metadata: { type: "CopyJob", displayName: "test" },
      config: {
        logicalId: "00000000-0000-0000-0000-000000000000",
        version: "2.0",
      },
    };
    const dir = makeTempItemDir(batchContent, platformZeroId);
    const def = loadCopyJobDefinition(dir);
    expect(def.parts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// hashServerCopyJobDefinition — tolerant projection of portal-managed fields
// ---------------------------------------------------------------------------
// Authoritative source: microsoft/fabric-rest-api-specs:copyJob/swagger.json +
// https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/copyjob-definition
//
// A fully-configured server definition includes:
//   - top-level "activities" array (always present, empty for unconfigured jobs)
//   - properties.source / properties.destination — connector config
//   - properties.policy — timeout/retry settings
// These are portal-managed; the adapter projects them away before hashing.

function configuredBatchServerDefinition(): FabricDefinition {
  // Realistic server readback: Batch Copy Job with Lakehouse → Lakehouse
  // transfer, one activity, source/destination/policy at job level.
  const content = {
    properties: {
      jobMode: "Batch",
      source: {
        type: "LakehouseTable",
        connectionSettings: {
          type: "Lakehouse",
          typeProperties: {
            workspaceId: "00000000-0000-0000-0000-000000000000",
            artifactId: "aaaaaaaa-6666-7777-8888-bbbbbbbbbbbb",
            rootFolder: "Tables",
          },
        },
      },
      destination: {
        type: "LakehouseTable",
        connectionSettings: {
          type: "Lakehouse",
          typeProperties: {
            workspaceId: "00000000-0000-0000-0000-000000000000",
            artifactId: "aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb",
            rootFolder: "Tables",
          },
        },
      },
      policy: { timeout: "0.12:00:00" },
    },
    activities: [
      {
        id: "eeeeeeee-4444-5555-6666-ffffffffffff",
        properties: {
          source: {
            datasetSettings: { table: "publicholidays", firstRowAsHeader: true },
          },
          destination: {
            writeBehavior: "Append",
            datasetSettings: { table: "publicholidays", firstRowAsHeader: false },
          },
          translator: { type: "TabularTranslator" },
          typeConversionSettings: {
            typeConversion: {
              allowDataTruncation: true,
              treatBooleanAsNumber: false,
            },
          },
        },
      },
    ],
  };
  return {
    parts: [
      {
        path: "copyjob-content.json",
        payload: base64(content),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function minimalBatchServerDefinition(): FabricDefinition {
  // Minimal: just jobMode + empty activities (as returned for unconfigured jobs)
  return {
    parts: [
      {
        path: "copyjob-content.json",
        payload: base64({ properties: { jobMode: "Batch" }, activities: [] }),
        payloadType: "InlineBase64",
      },
    ],
  };
}

describe("hashServerCopyJobDefinition", () => {
  it("returns a stable hash for the same definition", () => {
    const def = configuredBatchServerDefinition();
    const h1 = hashServerCopyJobDefinition(def, false);
    const h2 = hashServerCopyJobDefinition(def, false);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tolerates top-level activities array without throwing", () => {
    // Official spec: copyjob-content.json always includes "activities" array.
    // hashServerCopyJobDefinition must not reject it.
    expect(() =>
      hashServerCopyJobDefinition(minimalBatchServerDefinition(), false),
    ).not.toThrow();
  });

  it("tolerates properties.source, destination, and policy without throwing", () => {
    // Fully configured server definition with portal-managed connection fields.
    expect(() =>
      hashServerCopyJobDefinition(configuredBatchServerDefinition(), false),
    ).not.toThrow();
  });

  it("projects portal-managed fields away — configured and minimal produce the same hash", () => {
    // A configured job and an unconfigured job with the same jobMode must hash
    // identically on the managed surface so that plan()/verify() produce no-op
    // rather than blocked when only portal-managed content differs.
    const h1 = hashServerCopyJobDefinition(configuredBatchServerDefinition(), false);
    const h2 = hashServerCopyJobDefinition(minimalBatchServerDefinition(), false);
    expect(h1).toBe(h2);
  });

  it("produces the same hash as hashCopyJobDefinition for the same managed surface", () => {
    // Critical equivalence: hashServerCopyJobDefinition(serverDef) must equal
    // hashCopyJobDefinition(desiredDef) when both project to the same jobMode.
    // This is what makes plan() correctly produce no-op when jobMode matches.
    const desiredDef = makeDefinition(batchContent); // minimal desired
    const serverDef = configuredBatchServerDefinition();  // fully configured server
    expect(hashServerCopyJobDefinition(serverDef, false)).toBe(
      hashCopyJobDefinition(desiredDef, false),
    );
  });

  it("produces different hashes for different jobMode values", () => {
    const serverBatch = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: base64({ properties: { jobMode: "Batch" }, activities: [] }),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const serverCdc = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: base64({ properties: { jobMode: "CDC" }, activities: [] }),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    expect(hashServerCopyJobDefinition(serverBatch, false)).not.toBe(
      hashServerCopyJobDefinition(serverCdc, false),
    );
  });

  it("throws when copyjob-content.json part is missing", () => {
    const badDef: FabricDefinition = {
      parts: [
        {
          path: ".platform",
          payload: base64(validPlatform),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(() => hashServerCopyJobDefinition(badDef, false)).toThrow(
      "copyjob-content.json",
    );
  });

  it("throws when server definition contains an invalid jobMode", () => {
    const badDef: FabricDefinition = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: base64({ properties: { jobMode: "Streaming" }, activities: [] }),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(() => hashServerCopyJobDefinition(badDef, false)).toThrow(
      /jobMode/i,
    );
  });

  it("includes .platform when includePlatform is true", () => {
    const serverPlatform = {
      metadata: { type: "CopyJob", displayName: "test" },
      config: { version: "2.0", logicalId: "00000000-0000-0000-0000-000000000000" },
    };
    const serverDefNoPlatform = minimalBatchServerDefinition();
    const serverDefWithPlatform: FabricDefinition = {
      parts: [
        ...minimalBatchServerDefinition().parts,
        {
          path: ".platform",
          payload: base64(serverPlatform),
          payloadType: "InlineBase64",
        },
      ],
    };
    // With platform excluded: hashes match
    expect(hashServerCopyJobDefinition(serverDefWithPlatform, false)).toBe(
      hashServerCopyJobDefinition(serverDefNoPlatform, false),
    );
    // With platform included: hashes differ from no-platform version
    expect(hashServerCopyJobDefinition(serverDefWithPlatform, true)).not.toBe(
      hashServerCopyJobDefinition(serverDefNoPlatform, false),
    );
  });

  it("strips config.logicalId from .platform before hashing — matches desired hash", () => {
    // Server returns .platform with zero logicalId; desired omits logicalId.
    // Both must hash identically after normalization.
    const desiredPlatform = {
      metadata: { type: "CopyJob", displayName: "t" },
      config: { version: "2.0" },
    };
    const serverPlatform = {
      metadata: { type: "CopyJob", displayName: "t" },
      config: { version: "2.0", logicalId: "00000000-0000-0000-0000-000000000000" },
    };
    const desiredDef = makeDefinition(batchContent, true, desiredPlatform);
    const serverDef: FabricDefinition = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: base64({ properties: { jobMode: "Batch" }, activities: [] }),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: base64(serverPlatform),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(hashServerCopyJobDefinition(serverDef, true)).toBe(
      hashCopyJobDefinition(desiredDef, true),
    );
  });
});
