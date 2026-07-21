import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import {
  loadDataAgentDefinition,
  hashDataAgentDefinition,
  buildDataAgentCurrentHash,
  buildEffectiveDataAgentDefinition,
  dataAgentHasDefinition,
  isServiceGeneratedDefault,
  isUntouchedDataAgentShellDefinition,
  validateDataAgentDefinitionResponse,
} from "../src/fabric/data-agent-definition";
import type { FabricDefinition } from "../src/fabric/definition";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(value: object | string): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(s).toString("base64");
}

function part(partPath: string, value: object | string) {
  return {
    path: partPath,
    payload: b64(value),
    payloadType: "InlineBase64" as const,
  };
}

const ROOT_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
const STAGE_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/stageConfiguration/1.0.0/schema.json";
const FEWSHOTS_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/fewShots/1.0.0/schema.json";
const DATASOURCE_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataSource/1.0.0/schema.json";

function makeMinimalDef(): FabricDefinition {
  return {
    parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA })],
  };
}

// ---------------------------------------------------------------------------
// loadDataAgentDefinition
// ---------------------------------------------------------------------------

describe("loadDataAgentDefinition", () => {
  it("returns undefined for item directory with no Files/Config dir (shell)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    expect(loadDataAgentDefinition(dir)).toBeUndefined();
  });

  it("returns undefined for empty Files/Config dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    mkdirSync(path.join(dir, "Files", "Config"), { recursive: true });
    expect(loadDataAgentDefinition(dir)).toBeUndefined();
  });

  it("loads minimal definition (root config only)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    const def = loadDataAgentDefinition(dir);
    expect(def).toBeDefined();
    expect(def!.parts).toHaveLength(1);
    expect(def!.parts[0]!.path).toBe("Files/Config/data_agent.json");
  });

  it("loads full definition with draft stage_config and datasource", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    const draftDir = path.join(configDir, "draft");
    const dsDir = path.join(draftDir, "lakehouse-MyLH");
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({
        $schema: STAGE_SCHEMA,
        aiInstructions: "Be helpful.",
        experimental: {},
      }),
    );
    writeFileSync(
      path.join(dsDir, "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        artifactId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        workspaceId: "11111111-2222-3333-4444-555555555555",
        type: "lakehouse",
        displayName: "My LH",
      }),
    );
    const def = loadDataAgentDefinition(dir);
    expect(def).toBeDefined();
    expect(def!.parts).toHaveLength(3);
    const paths = def!.parts.map((p) => p.path);
    expect(paths).toContain("Files/Config/data_agent.json");
    expect(paths).toContain("Files/Config/draft/stage_config.json");
    expect(paths).toContain(
      "Files/Config/draft/lakehouse-MyLH/datasource.json",
    );
  });

  it("throws when published/ directory is present", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    const publishedDir = path.join(configDir, "published");
    mkdirSync(publishedDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    writeFileSync(
      path.join(publishedDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: null }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(
      /server-managed/,
    );
  });

  it("throws when root config is missing (other files present)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const draftDir = path.join(dir, "Files", "Config", "draft");
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: null }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(
      /missing the required.*data_agent\.json/,
    );
  });

  it("throws on invalid root config schema URL", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: "https://bad-schema.example/wrong/1.0.0/schema.json" }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(
      /unrecognised.*\$schema/,
    );
  });

  it("throws on invalid datasource type", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    const dsDir = path.join(configDir, "draft", "badtype-MyLH");
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    writeFileSync(
      path.join(dsDir, "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "not_a_real_type",
        displayName: "Bad Type",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(
      /unrecognised type/,
    );
  });

  it("throws on unsupported draft file name", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "da-test-"));
    const configDir = path.join(dir, "Files", "Config");
    const dsDir = path.join(configDir, "draft", "lakehouse-MyLH");
    mkdirSync(dsDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    writeFileSync(path.join(dsDir, "extras.txt"), "surprise!");
    expect(() => loadDataAgentDefinition(dir)).toThrow(
      /unsupported filename/,
    );
  });
});

// ---------------------------------------------------------------------------
// hashDataAgentDefinition
// ---------------------------------------------------------------------------

describe("hashDataAgentDefinition", () => {
  it("hashes only authored parts, ignoring .platform", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "hello",
        }),
        part(".platform", {
          metadata: { type: "DataAgent" },
          config: { logicalId: "00000000-0000-0000-0000-000000000000" },
        }),
      ],
    };
    const defNoPlatform: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "hello",
        }),
      ],
    };
    expect(hashDataAgentDefinition(def)).toBe(
      hashDataAgentDefinition(defNoPlatform),
    );
  });

  it("hashes only authored parts, ignoring published/**", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/published/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "server managed",
        }),
      ],
    };
    const defNoPublished: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
      ],
    };
    expect(hashDataAgentDefinition(def)).toBe(
      hashDataAgentDefinition(defNoPublished),
    );
  });

  it("produces different hashes for different aiInstructions", () => {
    const def1: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "v1",
        }),
      ],
    };
    const def2: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "v2",
        }),
      ],
    };
    expect(hashDataAgentDefinition(def1)).not.toBe(
      hashDataAgentDefinition(def2),
    );
  });

  it("produces stable hash for identical content", () => {
    const def = makeMinimalDef();
    expect(hashDataAgentDefinition(def)).toBe(
      hashDataAgentDefinition(def),
    );
  });

  it("includes publish_info.json in exclusion", () => {
    const withPublishInfo: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/publish_info.json", {
          $schema: "...",
          description: "published",
        }),
      ],
    };
    const withoutPublishInfo: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
      ],
    };
    expect(hashDataAgentDefinition(withPublishInfo)).toBe(
      hashDataAgentDefinition(withoutPublishInfo),
    );
  });

  it("hashes reordered nested object keys identically (stableJson property)", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const orderedA = Buffer.from(
      JSON.stringify({ $schema: schemaUrl, b: 1, a: 2 }),
    ).toString("base64");
    const orderedB = Buffer.from(
      JSON.stringify({ $schema: schemaUrl, a: 2, b: 1 }),
    ).toString("base64");
    const defA: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: orderedA,
          payloadType: "InlineBase64",
        },
      ],
    };
    const defB: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: orderedB,
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(hashDataAgentDefinition(defA)).toBe(
      hashDataAgentDefinition(defB),
    );
  });

  it("still detects real content changes after key reordering", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const defA: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: Buffer.from(
            JSON.stringify({ $schema: schemaUrl, a: 1 }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    const defB: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: Buffer.from(
            JSON.stringify({ $schema: schemaUrl, a: 2 }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(hashDataAgentDefinition(defA)).not.toBe(
      hashDataAgentDefinition(defB),
    );
  });

  it("hashes reordered nested keys identically (deeply nested)", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const withNestedA = Buffer.from(
      JSON.stringify({ $schema: schemaUrl, nested: { z: 1, a: 2 } }),
    ).toString("base64");
    const withNestedB = Buffer.from(
      JSON.stringify({ $schema: schemaUrl, nested: { a: 2, z: 1 } }),
    ).toString("base64");
    const defA: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: withNestedA,
          payloadType: "InlineBase64",
        },
      ],
    };
    const defB: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: withNestedB,
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(hashDataAgentDefinition(defA)).toBe(
      hashDataAgentDefinition(defB),
    );
  });
});

// ---------------------------------------------------------------------------
// buildEffectiveDataAgentDefinition
// ---------------------------------------------------------------------------

describe("buildEffectiveDataAgentDefinition", () => {
  it("strips server-managed parts from definition", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/published/stage_config.json", {
          $schema: STAGE_SCHEMA,
        }),
        part("Files/Config/publish_info.json", { description: "prod" }),
        part(".platform", { config: {} }),
      ],
    };
    const effective = buildEffectiveDataAgentDefinition(def);
    expect(effective.parts).toHaveLength(1);
    expect(effective.parts[0]!.path).toBe("Files/Config/data_agent.json");
  });

  it("keeps all authored parts intact", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: "test",
        }),
        part("Files/Config/draft/lakehouse-SalesLH/datasource.json", {
          type: "lakehouse",
        }),
      ],
    };
    const effective = buildEffectiveDataAgentDefinition(def);
    expect(effective.parts).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// dataAgentHasDefinition
// ---------------------------------------------------------------------------

describe("dataAgentHasDefinition", () => {
  it("returns false for empty parts", () => {
    expect(dataAgentHasDefinition({ parts: [] })).toBe(false);
  });

  it("returns false when only .platform present", () => {
    const def: FabricDefinition = {
      parts: [part(".platform", { config: {} })],
    };
    expect(dataAgentHasDefinition(def)).toBe(false);
  });

  it("returns true when root config present", () => {
    expect(dataAgentHasDefinition(makeMinimalDef())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateDataAgentDefinitionResponse (server round-trip)
// ---------------------------------------------------------------------------

describe("validateDataAgentDefinitionResponse", () => {
  it("accepts an empty definition (shell agent response)", () => {
    expect(() =>
      validateDataAgentDefinitionResponse({ parts: [] }),
    ).not.toThrow();
  });

  it("accepts a full server definition with .platform", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: null,
        }),
        part(".platform", {
          $schema:
            "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
          metadata: { type: "DataAgent" },
          config: { version: "2.0", logicalId: "00000000-0000-0000-0000-000000000000" },
        }),
      ],
    };
    expect(() => validateDataAgentDefinitionResponse(def)).not.toThrow();
  });

  it("throws for non-JSON root config payload", () => {
    const def: FabricDefinition = {
      parts: [
        {
          path: "Files/Config/data_agent.json",
          payload: Buffer.from("not json").toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    expect(() => validateDataAgentDefinitionResponse(def)).toThrow(
      /not valid JSON/,
    );
  });
});

// ---------------------------------------------------------------------------
// isServiceGeneratedDefault
// ---------------------------------------------------------------------------

describe("isServiceGeneratedDefault", () => {
  it("returns true for exact live server default shape ({$schema, aiInstructions:null}, no experimental)", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: STAGE_SCHEMA,
      aiInstructions: null,
    });
    expect(isServiceGeneratedDefault(p)).toBe(true);
  });

  it("returns true when experimental is {} (old server format, backwards compat)", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: STAGE_SCHEMA,
      aiInstructions: null,
      experimental: {},
    });
    expect(isServiceGeneratedDefault(p)).toBe(true);
  });

  it("returns false when experimental is non-empty (user has set content)", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: STAGE_SCHEMA,
      aiInstructions: null,
      experimental: { someFlag: true },
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when experimental is an empty array", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: STAGE_SCHEMA,
      aiInstructions: null,
      experimental: [],
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when the stage schema is missing", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      aiInstructions: null,
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when the stage schema is unrecognized", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: ROOT_SCHEMA,
      aiInstructions: null,
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when the stage config contains an unknown field", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      $schema: STAGE_SCHEMA,
      aiInstructions: null,
      externallyAdded: true,
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when aiInstructions is a non-null string", () => {
    const p = part("Files/Config/draft/stage_config.json", {
      aiInstructions: "Be helpful",
      experimental: {},
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false for root config path", () => {
    const p = part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false for a datasource path", () => {
    const p = part("Files/Config/draft/lh-Sales/datasource.json", {
      type: "lakehouse",
    });
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });

  it("returns false when payload is invalid JSON", () => {
    const p = {
      path: "Files/Config/draft/stage_config.json",
      payload: Buffer.from("bad json").toString("base64"),
      payloadType: "InlineBase64" as const,
    };
    expect(isServiceGeneratedDefault(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDataAgentCurrentHash
// ---------------------------------------------------------------------------

describe("buildDataAgentCurrentHash", () => {
  const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";

  function dsPart(name: string): ReturnType<typeof part> {
    return part(`Files/Config/draft/${name}/datasource.json`, {
      type: "lakehouse",
      artifactId: VALID_UUID,
      workspaceId: VALID_UUID,
    });
  }

  it("matches desired hash when server state equals desired (no drift)", () => {
    const desired: FabricDefinition = makeMinimalDef();
    const current: FabricDefinition = {
      parts: [
        ...desired.parts,
        // server adds blank stage_config
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: null,
        }),
      ],
    };
    const desiredHash = hashDataAgentDefinition(desired);
    const currentHash = buildDataAgentCurrentHash(current, desired);
    // blank stage_config is excluded → hashes match → no drift
    expect(currentHash).toBe(desiredHash);
  });

  it("detects drift when a current-only user-authored datasource is removed from desired", () => {
    const dsA = dsPart("lh-A");
    const dsB = dsPart("lh-B");
    // desired has only dsA; current has both dsA and dsB
    const desired: FabricDefinition = {
      parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }), dsA],
    };
    const current: FabricDefinition = {
      parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }), dsA, dsB],
    };
    const desiredHash = hashDataAgentDefinition(desired);
    const currentHash = buildDataAgentCurrentHash(current, desired);
    // dsB is user-authored → included → hashes differ → drift detected
    expect(currentHash).not.toBe(desiredHash);
  });

  it("does NOT detect drift for server-default blank stage_config absent from desired", () => {
    const desired: FabricDefinition = {
      parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA })],
    };
    const current: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA,
          aiInstructions: null,
        }),
      ],
    };
    const desiredHash = hashDataAgentDefinition(desired);
    const currentHash = buildDataAgentCurrentHash(current, desired);
    expect(currentHash).toBe(desiredHash);
  });
});

// ---------------------------------------------------------------------------
// Payload normalisation — server JSON reformatting
// ---------------------------------------------------------------------------

describe("hashDataAgentDefinition — JSON normalisation", () => {
  function makePartB64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj)).toString("base64");
  }
  function makePrettyB64(obj: unknown): string {
    return Buffer.from(JSON.stringify(obj, null, 2)).toString("base64");
  }

  it("produces the same hash for compact and pretty-printed JSON payloads", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const compactDef: FabricDefinition = {
      parts: [{ path: "Files/Config/data_agent.json", payload: makePartB64({ $schema: schemaUrl }), payloadType: "InlineBase64" }],
    };
    const prettyDef: FabricDefinition = {
      parts: [{ path: "Files/Config/data_agent.json", payload: makePrettyB64({ $schema: schemaUrl }), payloadType: "InlineBase64" }],
    };
    expect(hashDataAgentDefinition(compactDef)).toBe(hashDataAgentDefinition(prettyDef));
  });

  it("buildDataAgentCurrentHash matches hashDataAgentDefinition after server normalisation", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const stageUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/stageConfiguration/1.0.0/schema.json";
    // Desired: user's compact JSON (from disk)
    const desired: FabricDefinition = {
      parts: [
        { path: "Files/Config/data_agent.json", payload: makePartB64({ $schema: schemaUrl }), payloadType: "InlineBase64" },
        { path: "Files/Config/draft/stage_config.json", payload: makePartB64({ $schema: stageUrl, aiInstructions: "hello" }), payloadType: "InlineBase64" },
      ],
    };
    // Current: server's pretty-printed response (same semantic content)
    const current: FabricDefinition = {
      parts: [
        { path: "Files/Config/data_agent.json", payload: makePrettyB64({ $schema: schemaUrl }), payloadType: "InlineBase64" },
        { path: "Files/Config/draft/stage_config.json", payload: makePrettyB64({ $schema: stageUrl, aiInstructions: "hello" }), payloadType: "InlineBase64" },
        { path: ".platform", payload: makePrettyB64({ type: "DataAgent" }), payloadType: "InlineBase64" },
      ],
    };
    expect(buildDataAgentCurrentHash(current, desired)).toBe(hashDataAgentDefinition(desired));
  });

  it("detects a real content change despite normalisation", () => {
    const schemaUrl =
      "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
    const desired: FabricDefinition = {
      parts: [{ path: "Files/Config/data_agent.json", payload: makePartB64({ $schema: schemaUrl }), payloadType: "InlineBase64" }],
    };
    const differentContent: FabricDefinition = {
      parts: [{ path: "Files/Config/data_agent.json", payload: makePartB64({ $schema: schemaUrl, extra: "field" }), payloadType: "InlineBase64" }],
    };
    expect(hashDataAgentDefinition(desired)).not.toBe(hashDataAgentDefinition(differentContent));
  });

  it("detects drift when non-default stage_config is in current but not in desired", () => {
    const desired: FabricDefinition = {
      parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA })],
    };
    const current: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        // user had previously set instructions — now removed from desired
        part("Files/Config/draft/stage_config.json", {
          aiInstructions: "Be concise",
          experimental: {},
        }),
      ],
    };
    const desiredHash = hashDataAgentDefinition(desired);
    const currentHash = buildDataAgentCurrentHash(current, desired);
    // Non-default stage_config is user-authored → included → drift detected
    expect(currentHash).not.toBe(desiredHash);
  });

  it("changing an authored file changes the comparison hash", () => {
    const desired: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          aiInstructions: "Be helpful",
          experimental: {},
        }),
      ],
    };
    const currentSame: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          aiInstructions: "Be helpful",
          experimental: {},
        }),
      ],
    };
    const currentDifferent: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA }),
        part("Files/Config/draft/stage_config.json", {
          aiInstructions: "Different instructions",
          experimental: {},
        }),
      ],
    };
    const desiredHash = hashDataAgentDefinition(desired);
    expect(buildDataAgentCurrentHash(currentSame, desired)).toBe(desiredHash);
    expect(buildDataAgentCurrentHash(currentDifferent, desired)).not.toBe(desiredHash);
  });
});

// ---------------------------------------------------------------------------
// datasource.json UUID validation (item 7)
// ---------------------------------------------------------------------------

describe("datasource.json UUID validation in loadDataAgentDefinition", () => {
  const ROOT_SCHEMA_URL =
    "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
  const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";

  function makeDsDir(): { dir: string; configDir: string; draftDir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "da-ds-test-"));
    const configDir = path.join(dir, "Files", "Config");
    const draftDir = path.join(configDir, "draft");
    mkdirSync(path.join(draftDir, "lh-Sales"), { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA_URL }),
    );
    return { dir, configDir, draftDir };
  }

  it("accepts a valid datasource with UUID artifactId and workspaceId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects missing artifactId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/artifactId/);
  });

  it("rejects null artifactId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: null,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/artifactId/);
  });

  it("rejects non-UUID artifactId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: "not-a-uuid",
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/artifactId.*UUID/);
  });

  it("rejects missing workspaceId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/workspaceId/);
  });

  it("rejects null workspaceId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: null,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/workspaceId/);
  });

  it("rejects non-UUID workspaceId", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: "bad-id",
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/workspaceId.*UUID/);
  });

  it("rejects an array datasource.json (not an object)", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify([{ type: "lakehouse" }]),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/must be a JSON object/);
  });

  it("rejects a null datasource.json", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      "null",
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/must be a JSON object/);
  });

  it("rejects missing type field", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/missing the required 'type'/);
  });

  it("rejects unknown datasource type", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "unknown_type",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/unrecognised type/);
  });

  it("rejects datasource.json missing $schema", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/missing the required '\$schema'|\$schema/);
  });

  it("rejects datasource.json with wrong $schema pattern", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: "https://example.com/wrong-schema.json",
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/unrecognised.*'\$schema'|\$schema/);
  });

  it("accepts datasource.json with valid $schema pattern (non-1.0.0 version)", () => {
    const { dir, draftDir } = makeDsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataSource/2.0.0/schema.json",
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Test DS",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Strict schema validation (desired files, not server readback)
// ---------------------------------------------------------------------------

describe("strict desired definition validation", () => {
  function makeDraftDir(): { dir: string; draftDir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "da-strict-"));
    const configDir = path.join(dir, "Files", "Config");
    const draftDir = path.join(configDir, "draft");
    mkdirSync(path.join(draftDir, "lh-Sales"), { recursive: true });
    writeFileSync(
      path.join(configDir, "data_agent.json"),
      JSON.stringify({ $schema: ROOT_SCHEMA }),
    );
    return { dir, draftDir };
  }

  it("rejects stage_config.json missing $schema", () => {
    const { dir } = (() => {
      const d = makeDraftDir();
      writeFileSync(
        path.join(d.draftDir, "stage_config.json"),
        JSON.stringify({ aiInstructions: "hello" }),
      );
      return d;
    })();
    expect(() => loadDataAgentDefinition(dir)).toThrow(/\$schema/);
  });

  it("accepts stage_config.json with valid $schema", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: "hello" }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects datasource.json missing displayName", () => {
    const { dir, draftDir } = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/displayName/);
  });

  it("rejects datasource.json with empty displayName", () => {
    const { dir, draftDir } = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "  ",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/displayName/);
  });

  it("accepts datasource.json with all required fields", () => {
    const { dir, draftDir } = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Sales LH",
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects fewshots.json missing $schema", () => {
    const { dir, draftDir } = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Sales",
      }),
    );
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({ examples: [] }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/\$schema/);
  });

  it("accepts fewshots.json with valid $schema and empty fewShots array", () => {
    const { dir, draftDir } = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Sales",
      }),
    );
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({ $schema: FEWSHOTS_SCHEMA, fewShots: [] }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  // --------------------------------------------------------------------------
  // stage_config: aiInstructions null / non-string
  // --------------------------------------------------------------------------

  it("accepts stage_config.json with aiInstructions: null", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: null }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects stage_config.json with numeric aiInstructions", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: 42 }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/aiInstructions.*string or null/);
  });

  // --------------------------------------------------------------------------
  // stage_config: experimental validation
  // --------------------------------------------------------------------------

  it("accepts stage_config.json with experimental: null", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: "Hello", experimental: null }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("accepts stage_config.json with experimental: {} (empty object)", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: "Hello", experimental: {} }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("accepts stage_config.json with experimental: { someFlag: true }", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, aiInstructions: "Hello", experimental: { someFlag: true } }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects stage_config.json with experimental: 'foo' (primitive string)", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, experimental: "foo" }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/experimental.*object or null/);
  });

  it("rejects stage_config.json with experimental: [] (array)", () => {
    const { dir, draftDir } = makeDraftDir();
    writeFileSync(
      path.join(draftDir, "stage_config.json"),
      JSON.stringify({ $schema: STAGE_SCHEMA, experimental: [] }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/experimental.*object or null/);
  });

  // --------------------------------------------------------------------------
  // fewshots.json: fewShots collection structure
  // --------------------------------------------------------------------------

  function makeFewshotsDir(): { dir: string; draftDir: string } {
    const d = makeDraftDir();
    const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
    writeFileSync(
      path.join(d.draftDir, "lh-Sales", "datasource.json"),
      JSON.stringify({
        $schema: DATASOURCE_SCHEMA,
        type: "lakehouse",
        artifactId: VALID_UUID,
        workspaceId: VALID_UUID,
        displayName: "Sales",
      }),
    );
    return d;
  }

  it("rejects fewshots.json with missing fewShots property", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({ $schema: FEWSHOTS_SCHEMA }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots.*property|missing.*fewShots/);
  });

  it("rejects fewshots.json where fewShots is an object (not array)", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({ $schema: FEWSHOTS_SCHEMA, fewShots: {} }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots.*array/);
  });

  it("rejects fewshots.json where fewShots is a string", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({ $schema: FEWSHOTS_SCHEMA, fewShots: "bad" }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots.*array/);
  });

  it("accepts fewshots.json with valid entry (UUID id, non-empty question)", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [
          {
            id: "a67215a2-b766-4bfd-bd63-f0241bac1a0f",
            question: "What was total revenue last quarter?",
          },
        ],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).not.toThrow();
  });

  it("rejects fewshots.json entry with missing id", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [{ question: "Show me total sales" }],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\].*id/);
  });

  it("rejects fewshots.json entry with non-UUID id", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [{ id: "not-a-uuid", question: "Show me total sales" }],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\]\.id.*UUID/);
  });

  it("rejects fewshots.json entry with missing question", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [{ id: "a67215a2-b766-4bfd-bd63-f0241bac1a0f" }],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\].*question/);
  });

  it("rejects fewshots.json entry with empty question string", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [{ id: "a67215a2-b766-4bfd-bd63-f0241bac1a0f", question: "  " }],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\]\.question.*non-empty/);
  });

  it("rejects fewshots.json entry where id is null", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: [{ id: null, question: "How many sales?" }],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\].*id/);
  });

  it("rejects fewshots.json where fewShots contains a non-object entry (array item)", () => {
    const { dir, draftDir } = makeFewshotsDir();
    writeFileSync(
      path.join(draftDir, "lh-Sales", "fewshots.json"),
      JSON.stringify({
        $schema: FEWSHOTS_SCHEMA,
        fewShots: ["not-an-object"],
      }),
    );
    expect(() => loadDataAgentDefinition(dir)).toThrow(/fewShots\[0\].*object/);
  });
});

// ---------------------------------------------------------------------------
// isUntouchedDataAgentShellDefinition
// ---------------------------------------------------------------------------

describe("isUntouchedDataAgentShellDefinition", () => {
  const VALID_UUID = "a67215a2-b766-4bfd-bd63-f0241bac1a0f";
  const ROOT_SCHEMA_URL =
    "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";
  const STAGE_SCHEMA_URL =
    "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/stageConfiguration/1.0.0/schema.json";
  const PLATFORM_SCHEMA =
    "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json";

  function shellDef(): FabricDefinition {
    return {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
        part(".platform", {
          $schema: PLATFORM_SCHEMA,
          metadata: { type: "DataAgent", displayName: "My Agent" },
        }),
      ],
    };
  }

  it("returns true for canonical untouched shell (root + stage + .platform)", () => {
    expect(isUntouchedDataAgentShellDefinition(shellDef())).toBe(true);
  });

  it("returns true for shell without .platform", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(true);
  });

  it("returns true for shell with empty experimental in stage_config", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
          experimental: {},
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(true);
  });

  it("returns false when aiInstructions is non-null (stage_config modified)", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: "You are a helpful assistant.",
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when a datasource part is present", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
        part("Files/Config/draft/lakehouse-Sales/datasource.json", {
          $schema: DATASOURCE_SCHEMA,
          type: "lakehouse",
          artifactId: VALID_UUID,
          workspaceId: VALID_UUID,
          displayName: "Sales",
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when root config $schema is missing", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { version: "2.1.0" }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when root config $schema does not match dataAgent pattern", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", {
          $schema: "https://example.com/wrong-schema.json",
        }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when root config contains an unknown field", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", {
          $schema: ROOT_SCHEMA_URL,
          externallyAdded: true,
        }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when stage_config contains an unknown field", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL }),
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
          externallyAdded: true,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when stage_config is missing (only root present)", () => {
    const def: FabricDefinition = {
      parts: [part("Files/Config/data_agent.json", { $schema: ROOT_SCHEMA_URL })],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false when only stage_config is present (no root)", () => {
    const def: FabricDefinition = {
      parts: [
        part("Files/Config/draft/stage_config.json", {
          $schema: STAGE_SCHEMA_URL,
          aiInstructions: null,
        }),
      ],
    };
    expect(isUntouchedDataAgentShellDefinition(def)).toBe(false);
  });

  it("returns false for empty definition", () => {
    expect(isUntouchedDataAgentShellDefinition({ parts: [] })).toBe(false);
  });
});
