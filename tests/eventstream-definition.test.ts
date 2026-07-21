import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  eventstreamIncludesPlatformPart,
  eventstreamIncludesPropertiesPart,
  hashEventstreamDefinition,
  loadEventstreamDefinition,
} from "../src/fabric/eventstream-definition";

function eventstreamDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-eventstream-"));
  const itemDirectory = path.join(root, "eventstream");
  mkdirSync(path.join(itemDirectory, "definition"), { recursive: true });
  return itemDirectory;
}

const MINIMAL_TOPOLOGY = {
  compatibilityLevel: "1.1",
  sources: [],
  destinations: [],
  operators: [],
  streams: [],
};

const SAMPLE_TOPOLOGY_WITH_IDS = {
  compatibilityLevel: "1.1",
  sources: [
    { id: "aaa-111", type: "SampleData", name: "SampleSource" },
  ],
  destinations: [
    { id: "bbb-222", type: "Lakehouse", name: "LakehouseDest" },
  ],
  operators: [],
  streams: [{ id: "ccc-333", name: "DefaultStream" }],
};

const SAMPLE_TOPOLOGY_WITHOUT_IDS = {
  compatibilityLevel: "1.1",
  sources: [
    { type: "SampleData", name: "SampleSource" },
  ],
  destinations: [
    { type: "Lakehouse", name: "LakehouseDest" },
  ],
  operators: [],
  streams: [{ name: "DefaultStream" }],
};

function base64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

describe("Eventstream definitions", () => {
  describe("loadEventstreamDefinition", () => {
    it("loads a minimal eventstream.json without optional parts", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify(MINIMAL_TOPOLOGY),
        "utf8",
      );

      const definition = loadEventstreamDefinition(itemDirectory);

      expect(definition.parts).toHaveLength(1);
      expect(definition.parts[0]!.path).toBe("eventstream.json");
      expect(eventstreamIncludesPlatformPart(definition)).toBe(false);
      expect(eventstreamIncludesPropertiesPart(definition)).toBe(false);
    });

    it("loads all three parts when present", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify(MINIMAL_TOPOLOGY),
        "utf8",
      );
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstreamProperties.json"),
        JSON.stringify({ retentionTimeInDays: 7, eventThroughputLevel: "Medium" }),
        "utf8",
      );
      writeFileSync(
        path.join(itemDirectory, "definition", ".platform"),
        JSON.stringify({ metadata: { type: "Eventstream", displayName: "My Stream" } }),
        "utf8",
      );

      const definition = loadEventstreamDefinition(itemDirectory);

      expect(definition.parts).toHaveLength(3);
      expect(eventstreamIncludesPlatformPart(definition)).toBe(true);
      expect(eventstreamIncludesPropertiesPart(definition)).toBe(true);
    });

    it("sorts parts in canonical order", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify(MINIMAL_TOPOLOGY),
        "utf8",
      );
      writeFileSync(
        path.join(itemDirectory, "definition", ".platform"),
        JSON.stringify({ metadata: { type: "Eventstream", displayName: "My Stream" } }),
        "utf8",
      );

      const definition = loadEventstreamDefinition(itemDirectory);
      const paths = definition.parts.map((p) => p.path);

      // parts should be sorted — .platform sorts before eventstream.json
      expect(paths).toEqual([".platform", "eventstream.json"]);
    });

    it("rejects a directory with no eventstream.json", () => {
      const itemDirectory = eventstreamDirectory();

      expect(() => loadEventstreamDefinition(itemDirectory)).toThrow(
        "Eventstream definition must include definition/eventstream.json",
      );
    });

    it("rejects unsupported files in the definition directory", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify(MINIMAL_TOPOLOGY),
        "utf8",
      );
      writeFileSync(
        path.join(itemDirectory, "definition", "extra.json"),
        "{}",
        "utf8",
      );

      expect(() => loadEventstreamDefinition(itemDirectory)).toThrow(
        "Unsupported Eventstream definition path 'extra.json'",
      );
    });

    it("rejects eventstream.json with invalid JSON", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        "NOT-JSON",
        "utf8",
      );

      expect(() => loadEventstreamDefinition(itemDirectory)).toThrow(
        "must contain valid JSON",
      );
    });
  });

  describe("hashEventstreamDefinition", () => {
    it("produces stable hashes independent of node id fields", () => {
      const withIds: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(SAMPLE_TOPOLOGY_WITH_IDS),
            payloadType: "InlineBase64",
          },
        ],
      };
      const withoutIds: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(SAMPLE_TOPOLOGY_WITHOUT_IDS),
            payloadType: "InlineBase64",
          },
        ],
      };

      const hashWithIds = hashEventstreamDefinition(withIds, false, false);
      const hashWithoutIds = hashEventstreamDefinition(withoutIds, false, false);

      expect(hashWithIds).toBe(hashWithoutIds);
    });

    it("produces different hashes when topology changes", () => {
      const original: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };
      const modified: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64({
              ...MINIMAL_TOPOLOGY,
              operators: [{ name: "changed-operator", type: "Filter" }],
            }),
            payloadType: "InlineBase64",
          },
        ],
      };

      expect(hashEventstreamDefinition(original, false, false)).not.toBe(
        hashEventstreamDefinition(modified, false, false),
      );
    });

    it("excludes eventstreamProperties.json from hash when includeProperties=false", () => {
      const withProperties: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 30, eventThroughputLevel: "High" }),
            payloadType: "InlineBase64",
          },
        ],
      };
      const withoutProperties: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };

      const hashWith = hashEventstreamDefinition(withProperties, false, false);
      const hashWithout = hashEventstreamDefinition(withoutProperties, false, false);

      expect(hashWith).toBe(hashWithout);
    });

    it("includes eventstreamProperties.json in hash when includeProperties=true", () => {
      const base: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 1, eventThroughputLevel: "Low" }),
            payloadType: "InlineBase64",
          },
        ],
      };
      const different: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 7, eventThroughputLevel: "Medium" }),
            payloadType: "InlineBase64",
          },
        ],
      };

      const hashBase = hashEventstreamDefinition(base, false, true);
      const hashDifferent = hashEventstreamDefinition(different, false, true);

      expect(hashBase).not.toBe(hashDifferent);
    });

    it("excludes .platform from hash when includePlatform=false", () => {
      const withPlatform: FabricDefinition = {
        parts: [
          {
            path: ".platform",
            payload: base64({ metadata: { type: "Eventstream", displayName: "My Stream" } }),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };
      const withoutPlatform: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };

      const hashWith = hashEventstreamDefinition(withPlatform, false, false);
      const hashWithout = hashEventstreamDefinition(withoutPlatform, false, false);

      expect(hashWith).toBe(hashWithout);
    });

    it("includes .platform in hash when includePlatform=true", () => {
      const withPlatform: FabricDefinition = {
        parts: [
          {
            path: ".platform",
            payload: base64({ metadata: { type: "Eventstream", displayName: "My Stream" } }),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };
      const withoutPlatform: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
        ],
      };

      const hashWith = hashEventstreamDefinition(withPlatform, true, false);
      const hashWithout = hashEventstreamDefinition(withoutPlatform, true, false);

      expect(hashWith).not.toBe(hashWithout);
    });

    it("rejects definition missing eventstream.json part", () => {
      const definition: FabricDefinition = {
        parts: [
          {
            path: ".platform",
            payload: base64({ metadata: {} }),
            payloadType: "InlineBase64",
          },
        ],
      };

      expect(() =>
        hashEventstreamDefinition(definition, false, false),
      ).toThrow("must contain exactly one eventstream.json part");
    });
  });

  // ---------------------------------------------------------------------------
  // Load-time validation regression tests
  // ---------------------------------------------------------------------------

  describe("load-time validation — eventstream.json structural errors", () => {
    function makeDefPart(topology: unknown): FabricDefinition {
      return {
        parts: [
          {
            path: "eventstream.json",
            payload: Buffer.from(JSON.stringify(topology)).toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      };
    }

    it("rejects an empty object {} (missing all required collection fields)", () => {
      expect(() =>
        hashEventstreamDefinition(makeDefPart({}), false, false),
      ).toThrow("sources");
    });

    it("rejects null as the entire eventstream.json content", () => {
      // JSON.parse("null") returns null — parseJsonPart must reject it
      const def: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: Buffer.from("null").toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      };
      expect(() =>
        hashEventstreamDefinition(def, false, false),
      ).toThrow("must contain a JSON object");
    });

    it("rejects sources: null (explicit null is not an array)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({
            ...MINIMAL_TOPOLOGY,
            sources: null,
          }),
          false,
          false,
        ),
      ).toThrow("'sources' must be an array");
    });

    it("rejects sources: 'not-an-array' (string is not an array)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, sources: "not-an-array" }),
          false,
          false,
        ),
      ).toThrow("'sources' must be an array");
    });

    it("rejects destinations: 42 (number is not an array)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, destinations: 42 }),
          false,
          false,
        ),
      ).toThrow("'destinations' must be an array");
    });

    it("rejects operators: {} (plain object is not an array)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, operators: {} }),
          false,
          false,
        ),
      ).toThrow("'operators' must be an array");
    });

    it("rejects streams: true (boolean is not an array)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, streams: true }),
          false,
          false,
        ),
      ).toThrow("'streams' must be an array");
    });

    it("rejects null entry inside sources array", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, sources: [null] }),
          false,
          false,
        ),
      ).toThrow("'sources[0]' must be an object");
    });

    it("rejects string entry inside destinations array", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, destinations: ["not-an-object"] }),
          false,
          false,
        ),
      ).toThrow("'destinations[0]' must be an object");
    });

    it("rejects number entry inside operators array", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, operators: [42] }),
          false,
          false,
        ),
      ).toThrow("'operators[0]' must be an object");
    });

    it("rejects compatibilityLevel: 1.1 (number, not a string)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, compatibilityLevel: 1.1 }),
          false,
          false,
        ),
      ).toThrow("'compatibilityLevel' must be a string");
    });

    it("rejects compatibilityLevel: null", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, compatibilityLevel: null }),
          false,
          false,
        ),
      ).toThrow("'compatibilityLevel' must be a string");
    });

    it("rejects unsupported compatibilityLevel strings", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({ ...MINIMAL_TOPOLOGY, compatibilityLevel: "2.0" }),
          false,
          false,
        ),
      ).toThrow("'compatibilityLevel' must be \"1.0\" or \"1.1\"");
    });

    it("accepts valid topology with node objects (non-empty arrays)", () => {
      expect(() =>
        hashEventstreamDefinition(
          makeDefPart({
            ...MINIMAL_TOPOLOGY,
            sources: [{ name: "src", type: "SampleData" }],
            streams: [{ name: "defaultStream" }],
          }),
          false,
          false,
        ),
      ).not.toThrow();
    });

    it("rejects missing sources field from loadEventstreamDefinition", () => {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify({ destinations: [], operators: [], streams: [] }),
        "utf8",
      );
      expect(() => loadEventstreamDefinition(itemDirectory)).toThrow(
        "sources",
      );
    });
  });

  describe("load-time validation — eventstreamProperties.json type errors", () => {
    function loadWithProperties(props: unknown): FabricDefinition {
      const itemDirectory = eventstreamDirectory();
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstream.json"),
        JSON.stringify(MINIMAL_TOPOLOGY),
        "utf8",
      );
      writeFileSync(
        path.join(itemDirectory, "definition", "eventstreamProperties.json"),
        JSON.stringify(props),
        "utf8",
      );
      return loadEventstreamDefinition(itemDirectory);
    }

    it("rejects retentionTimeInDays: null (explicit null)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: null,
          eventThroughputLevel: "Low",
        }),
      ).toThrow("'retentionTimeInDays' must not be null");
    });

    it("rejects eventThroughputLevel: null (explicit null)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 1,
          eventThroughputLevel: null,
        }),
      ).toThrow("'eventThroughputLevel' must not be null");
    });

    it("rejects retentionTimeInDays: 'seven' (string instead of integer)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: "seven",
          eventThroughputLevel: "Low",
        }),
      ).toThrow("retentionTimeInDays must be an integer between 1 and 90");
    });

    it("rejects retentionTimeInDays: 0 (below minimum)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 0,
          eventThroughputLevel: "Low",
        }),
      ).toThrow("retentionTimeInDays must be an integer between 1 and 90");
    });

    it("rejects retentionTimeInDays: 91 (above maximum)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 91,
          eventThroughputLevel: "Low",
        }),
      ).toThrow("retentionTimeInDays must be an integer between 1 and 90");
    });

    it("rejects retentionTimeInDays: 1.5 (non-integer)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 1.5,
          eventThroughputLevel: "Low",
        }),
      ).toThrow("retentionTimeInDays must be an integer between 1 and 90");
    });

    it("rejects eventThroughputLevel: 'VeryHigh' (invalid enum)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 1,
          eventThroughputLevel: "VeryHigh",
        }),
      ).toThrow('eventThroughputLevel must be "Low", "Medium", or "High"');
    });

    it("rejects eventThroughputLevel: 2 (number instead of string)", () => {
      expect(() =>
        loadWithProperties({
          retentionTimeInDays: 1,
          eventThroughputLevel: 2,
        }),
      ).toThrow('eventThroughputLevel must be "Low", "Medium", or "High"');
    });

    it("accepts missing retentionTimeInDays (omitted defaults to 1 in hash)", () => {
      // Load succeeds; hash normalization fills in default
      expect(() =>
        loadWithProperties({ eventThroughputLevel: "Medium" }),
      ).not.toThrow();
    });

    it("accepts missing eventThroughputLevel (omitted defaults to Low in hash)", () => {
      expect(() =>
        loadWithProperties({ retentionTimeInDays: 7 }),
      ).not.toThrow();
    });

    it("produces stable hash: missing fields hash the same as explicit defaults", () => {
      const explicit: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 1, eventThroughputLevel: "Low" }),
            payloadType: "InlineBase64",
          },
        ],
      };
      const missing: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({}),
            payloadType: "InlineBase64",
          },
        ],
      };
      expect(hashEventstreamDefinition(explicit, false, true)).toBe(
        hashEventstreamDefinition(missing, false, true),
      );
    });

    it("does NOT hash the same as explicit defaults when real changes exist (no perpetual drift suppression)", () => {
      const defaults: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 1, eventThroughputLevel: "Low" }),
            payloadType: "InlineBase64",
          },
        ],
      };
      const changed: FabricDefinition = {
        parts: [
          {
            path: "eventstream.json",
            payload: base64(MINIMAL_TOPOLOGY),
            payloadType: "InlineBase64",
          },
          {
            path: "eventstreamProperties.json",
            payload: base64({ retentionTimeInDays: 30, eventThroughputLevel: "High" }),
            payloadType: "InlineBase64",
          },
        ],
      };
      expect(hashEventstreamDefinition(defaults, false, true)).not.toBe(
        hashEventstreamDefinition(changed, false, true),
      );
    });
  });
});
