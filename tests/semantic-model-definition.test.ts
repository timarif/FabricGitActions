import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  buildEffectiveSemanticModelDefinition,
  hashAuxiliarySemanticModelParts,
  hashSemanticModelDefinition,
  loadSemanticModelDefinition,
  semanticModelDefinitionFormat,
  semanticModelIncludesCopilotParts,
  semanticModelIncludesDiagramLayoutPart,
  semanticModelIncludesPlatformPart,
  semanticModelPlatformLogicalId,
} from "../src/fabric/semantic-model-definition";

const PBISM_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json";
const PLATFORM_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json";

function semanticModelDirectory(): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-semantic-model-"),
  );
  const itemDirectory = path.join(root, "model");
  mkdirSync(path.join(itemDirectory, "definition"), {
    recursive: true,
  });
  return itemDirectory;
}

function jsonPart(
  partPath: string,
  value: Record<string, unknown>,
) {
  return {
    path: partPath,
    payload: Buffer.from(JSON.stringify(value)).toString("base64"),
    payloadType: "InlineBase64" as const,
  };
}

/** Minimal valid definition.pbism for TMSL (version 1.0, $schema URL). */
function pbismTmsl(): Record<string, unknown> {
  return { $schema: PBISM_SCHEMA, version: "1.0", settings: {} };
}

/** Minimal valid definition.pbism for TMDL (version 4.0, $schema URL). */
function pbismTmdl(): Record<string, unknown> {
  return { $schema: PBISM_SCHEMA, version: "4.0", settings: {} };
}

/** Valid v2 .platform for a SemanticModel. */
function platformV2(
  displayName = "Sales",
  logicalId = "550e8400-e29b-41d4-a716-446655440000",
): Record<string, unknown> {
  return {
    $schema: PLATFORM_SCHEMA,
    metadata: { type: "SemanticModel", displayName },
    config: { version: "2.0", logicalId },
  };
}

describe("Semantic Model definitions", () => {
  it("loads a TMSL definition and emits the exact API format", () => {
    const itemDirectory = semanticModelDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "model.bim"),
      JSON.stringify({
        compatibilityLevel: 1702,
        model: { culture: "en-US", tables: [] },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "definition.pbism",
      ),
      JSON.stringify(pbismTmsl()),
      "utf8",
    );
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "diagramLayout.json",
      ),
      JSON.stringify({ version: "1.1.0", diagrams: [] }),
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", ".platform"),
      JSON.stringify(platformV2("Sales")),
      "utf8",
    );

    const definition =
      loadSemanticModelDefinition(itemDirectory);

    expect(definition.format).toBe("TMSL");
    expect(definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      "definition.pbism",
      "diagramLayout.json",
      "model.bim",
    ]);
    expect(semanticModelDefinitionFormat(definition)).toBe(
      "TMSL",
    );
    expect(semanticModelIncludesPlatformPart(definition)).toBe(
      true,
    );
    expect(
      semanticModelIncludesDiagramLayoutPart(definition),
    ).toBe(true);
  });

  it("loads every nested TMDL part and normalizes line endings when hashing", () => {
    const itemDirectory = semanticModelDirectory();
    const tmdlDirectory = path.join(
      itemDirectory,
      "definition",
      "definition",
      "tables",
    );
    mkdirSync(tmdlDirectory, { recursive: true });
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "definition.pbism",
      ),
      JSON.stringify(pbismTmdl()),
      "utf8",
    );
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "definition",
        "model.tmdl",
      ),
      "model Model\nculture: en-US\n",
      "utf8",
    );
    writeFileSync(
      path.join(tmdlDirectory, "sales.tmdl"),
      "table Sales\n\tcolumn Amount\n",
      "utf8",
    );

    const loaded = loadSemanticModelDefinition(itemDirectory);
    const withCrLf: FabricDefinition = {
      format: "TMDL",
      parts: loaded.parts.map((part) =>
        part.path.endsWith(".tmdl")
          ? {
              ...part,
              payload: Buffer.from(
                Buffer.from(part.payload, "base64")
                  .toString("utf8")
                  .replace(/\n/g, "\r\n"),
              ).toString("base64"),
            }
          : part,
      ),
    };

    expect(loaded.format).toBe("TMDL");
    expect(loaded.parts.map((part) => part.path)).toEqual([
      "definition.pbism",
      "definition/model.tmdl",
      "definition/tables/sales.tmdl",
    ]);
    expect(
      hashSemanticModelDefinition(loaded, false, false),
    ).toBe(
      hashSemanticModelDefinition(withCrLf, false, false),
    );
  });

  it("hashes JSON semantically and ignores unmanaged service layout and platform parts", () => {
    const desired: FabricDefinition = {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {
          compatibilityLevel: 1702,
          model: { culture: "en-US", tables: [] },
        }),
        jsonPart("definition.pbism", {
          version: "5.0",
          settings: { qnaEnabled: false },
        }),
      ],
    };
    const service: FabricDefinition = {
      format: "TMSL",
      parts: [
        {
          path: "definition.pbism",
          payload: Buffer.from(
            '{\n "settings": {"qnaEnabled": false}, "version": "4.2"\n}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "model.bim",
          payload: Buffer.from(
            '{"model":{"culture":"en-US"},"compatibilityLevel":1702}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        jsonPart("diagramLayout.json", {
          version: "1.1.0",
          diagrams: [],
        }),
        jsonPart(".platform", {
          metadata: {
            type: "SemanticModel",
            displayName: "Generated",
          },
        }),
      ],
    };

    expect(
      hashSemanticModelDefinition(desired, false, false),
    ).toBe(
      hashSemanticModelDefinition(service, false, false),
    );
  });

  it("does not ignore non-empty TMSL collections or PBISM settings", () => {
    const base: FabricDefinition = {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {
          compatibilityLevel: 1702,
          model: { culture: "en-US", tables: [] },
        }),
        jsonPart("definition.pbism", {
          version: "5.0",
          settings: { qnaEnabled: false },
        }),
      ],
    };
    const withTable: FabricDefinition = {
      ...base,
      parts: [
        jsonPart("model.bim", {
          compatibilityLevel: 1702,
          model: {
            culture: "en-US",
            tables: [{ name: "Sales" }],
          },
        }),
        base.parts[1]!,
      ],
    };
    const withDifferentSettings: FabricDefinition = {
      ...base,
      parts: [
        base.parts[0]!,
        jsonPart("definition.pbism", {
          version: "4.2",
          settings: { qnaEnabled: true },
        }),
      ],
    };

    expect(
      hashSemanticModelDefinition(base, false, false),
    ).not.toBe(
      hashSemanticModelDefinition(withTable, false, false),
    );
    expect(
      hashSemanticModelDefinition(base, false, false),
    ).not.toBe(
      hashSemanticModelDefinition(
        withDifferentSettings,
        false,
        false,
      ),
    );
  });

  it("rejects mixed, missing, unsupported, duplicate, and malformed parts", () => {
    const mixed = semanticModelDirectory();
    mkdirSync(
      path.join(mixed, "definition", "definition"),
      { recursive: true },
    );
    writeFileSync(
      path.join(mixed, "definition", "definition.pbism"),
      "{}",
      "utf8",
    );
    writeFileSync(
      path.join(mixed, "definition", "model.bim"),
      "{}",
      "utf8",
    );
    writeFileSync(
      path.join(
        mixed,
        "definition",
        "definition",
        "model.tmdl",
      ),
      "model Model\n",
      "utf8",
    );
    expect(() =>
      loadSemanticModelDefinition(mixed),
    ).toThrow("must not mix TMSL");

    const unsupported = semanticModelDirectory();
    writeFileSync(
      path.join(
        unsupported,
        "definition",
        "definition.pbism",
      ),
      "{}",
      "utf8",
    );
    writeFileSync(
      path.join(unsupported, "definition", "model.bim"),
      "{}",
      "utf8",
    );
    writeFileSync(
      path.join(unsupported, "definition", "notes.json"),
      "{}",
      "utf8",
    );
    expect(() =>
      loadSemanticModelDefinition(unsupported),
    ).toThrow(
      "Unsupported Semantic Model definition path 'notes.json'",
    );

    const missing = semanticModelDirectory();
    writeFileSync(
      path.join(missing, "definition", "model.bim"),
      "{}",
      "utf8",
    );
    expect(() => loadSemanticModelDefinition(missing)).toThrow(
      "exactly one definition.pbism",
    );

    const duplicate: FabricDefinition = {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {}),
        jsonPart("definition.pbism", {}),
        jsonPart("./DEFINITION.PBISM", {}),
      ],
    };
    expect(() =>
      hashSemanticModelDefinition(duplicate, false, false),
    ).toThrow("duplicate canonical paths");

    const invalidJson: FabricDefinition = {
      format: "TMSL",
      parts: [
        {
          path: "model.bim",
          payload: Buffer.from("[]").toString("base64"),
          payloadType: "InlineBase64",
        },
        jsonPart("definition.pbism", { version: "5.0" }),
      ],
    };
    expect(() =>
      hashSemanticModelDefinition(
        invalidJson,
        false,
        false,
      ),
    ).toThrow("must contain a JSON object");

    const unsupportedPayload = {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {}),
        {
          ...jsonPart("definition.pbism", {}),
          payloadType: "External",
        },
      ],
    } as unknown as FabricDefinition;
    expect(() =>
      hashSemanticModelDefinition(
        unsupportedPayload,
        false,
        false,
      ),
    ).toThrow("Unsupported Fabric definition payload type");
  });

  it("rejects sensitivity label declarations in .platform", () => {
    const definition: FabricDefinition = {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {}),
        jsonPart("definition.pbism", {}),
        jsonPart(".platform", {
          metadata: { type: "SemanticModel" },
          sensitivityLabelSettings: { labelId: "label" },
        }),
      ],
    };

    expect(() =>
      hashSemanticModelDefinition(definition, true, false),
    ).toThrow("sensitivity labels are not supported");
  });

  // ---------------------------------------------------------------------------
  // definition.pbism validation
  // ---------------------------------------------------------------------------
  describe("definition.pbism validation (desired definitions)", () => {
    it("rejects missing $schema", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify({ version: "5.0" }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "must include a '$schema' string",
      );
    });

    it("rejects wrong $schema URL", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify({
          $schema:
            "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/2.0.0/schema.json",
          version: "5.0",
        }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "definition.pbism '$schema' must use",
      );
    });

    it("rejects missing version", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify({ $schema: PBISM_SCHEMA }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "must include a 'version' string",
      );
    });

    it("rejects unsupported versions 2.x and 3.x", () => {
      for (const version of ["2.0", "3.0", "2.5", "3.9"]) {
        const d = semanticModelDirectory();
        writeFileSync(
          path.join(d, "definition", "model.bim"),
          JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
          "utf8",
        );
        writeFileSync(
          path.join(d, "definition", "definition.pbism"),
          JSON.stringify({ $schema: PBISM_SCHEMA, version }),
          "utf8",
        );
        expect(
          () => loadSemanticModelDefinition(d),
          `version ${version}`,
        ).toThrow("is not supported");
      }
    });

    it("rejects TMDL with version 1.0", () => {
      const d = semanticModelDirectory();
      const tmdlDir = path.join(d, "definition", "definition");
      mkdirSync(tmdlDir, { recursive: true });
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify({ $schema: PBISM_SCHEMA, version: "1.0" }),
        "utf8",
      );
      writeFileSync(
        path.join(tmdlDir, "model.tmdl"),
        "model Model\n",
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "does not support TMDL",
      );
    });

    it("rejects malformed and unsupported 1.x version strings", () => {
      for (const version of ["1.1", "4", "4.0-preview", "04.0.0"]) {
        const d = semanticModelDirectory();
        writeFileSync(
          path.join(d, "definition", "model.bim"),
          JSON.stringify({
            compatibilityLevel: 1702,
            model: { tables: [] },
          }),
          "utf8",
        );
        writeFileSync(
          path.join(d, "definition", "definition.pbism"),
          JSON.stringify({ $schema: PBISM_SCHEMA, version }),
          "utf8",
        );
        expect(
          () => loadSemanticModelDefinition(d),
          `version ${version}`,
        ).toThrow();
      }
    });

    it("accepts version 1.0 for TMSL and version 4.0+ for both formats", () => {
      for (const [version, hasTmdl] of [
        ["1.0", false],
        ["4.0", false],
        ["5.0", false],
        ["4.0", true],
        ["5.0", true],
      ] as [string, boolean][]) {
        const d = semanticModelDirectory();
        writeFileSync(
          path.join(d, "definition", "definition.pbism"),
          JSON.stringify({ $schema: PBISM_SCHEMA, version }),
          "utf8",
        );
        if (hasTmdl) {
          const tmdlDir = path.join(d, "definition", "definition");
          mkdirSync(tmdlDir, { recursive: true });
          writeFileSync(
            path.join(tmdlDir, "model.tmdl"),
            "model Model\n",
            "utf8",
          );
        } else {
          writeFileSync(
            path.join(d, "definition", "model.bim"),
            JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
            "utf8",
          );
        }
        expect(
          () => loadSemanticModelDefinition(d),
          `version=${version} tmdl=${hasTmdl}`,
        ).not.toThrow();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // .platform v2 structure validation (desired definitions)
  // ---------------------------------------------------------------------------
  describe(".platform v2 validation (desired definitions)", () => {
    it("rejects .platform without $schema", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          metadata: {
            type: "SemanticModel",
            displayName: "Sales",
          },
          config: { version: "2.0", logicalId: "550e8400-e29b-41d4-a716-446655440000" },
        }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "must include a '$schema' string",
      );
    });

    it("rejects .platform without config", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          $schema: PLATFORM_SCHEMA,
          metadata: { type: "SemanticModel", displayName: "Sales" },
        }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "must include a 'config' object",
      );
    });

    it("rejects .platform with a non-v2 version", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          $schema: PLATFORM_SCHEMA,
          metadata: { type: "SemanticModel", displayName: "Sales" },
          config: { version: "1.0", logicalId: "550e8400-e29b-41d4-a716-446655440000" },
        }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        `must declare version "2.0"`,
      );
    });

    it("rejects .platform with invalid UUID logicalId", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          $schema: PLATFORM_SCHEMA,
          metadata: { type: "SemanticModel", displayName: "Sales" },
          config: { version: "2.0", logicalId: "not-a-uuid" },
        }),
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "config.logicalId must be a valid UUID",
      );
    });

    it("accepts a valid v2 .platform for TMSL", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify(platformV2("Sales")),
        "utf8",
      );
      const def = loadSemanticModelDefinition(d);
      expect(semanticModelIncludesPlatformPart(def)).toBe(true);
    });

    it("accepts the documented top-level v2 version layout", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({
          compatibilityLevel: 1702,
          model: { tables: [] },
        }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          version: "2.0",
          $schema: PLATFORM_SCHEMA,
          config: {
            logicalId:
              "550e8400-e29b-41d4-a716-446655440000",
          },
          metadata: {
            type: "SemanticModel",
            displayName: "Sales",
          },
        }),
        "utf8",
      );

      expect(() => loadSemanticModelDefinition(d)).not.toThrow();
    });

    it("rejects conflicting v2 version declarations", () => {
      const d = semanticModelDirectory();
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({
          compatibilityLevel: 1702,
          model: { tables: [] },
        }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", ".platform"),
        JSON.stringify({
          version: "2.0",
          $schema: PLATFORM_SCHEMA,
          config: {
            version: "1.0",
            logicalId:
              "550e8400-e29b-41d4-a716-446655440000",
          },
          metadata: {
            type: "SemanticModel",
            displayName: "Sales",
          },
        }),
        "utf8",
      );

      expect(() => loadSemanticModelDefinition(d)).toThrow(
        `must declare version "2.0"`,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Copilot path support
  // ---------------------------------------------------------------------------
  describe("Copilot auxiliary parts", () => {
    it("loads Copilot JSON and Markdown files alongside TMSL", () => {
      const d = semanticModelDirectory();
      const copilotDir = path.join(d, "definition", "Copilot");
      mkdirSync(copilotDir, { recursive: true });
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(copilotDir, "conversation.json"),
        JSON.stringify({ messages: [] }),
        "utf8",
      );
      writeFileSync(
        path.join(copilotDir, "README.md"),
        "# Copilot notes\n",
        "utf8",
      );

      const def = loadSemanticModelDefinition(d);
      expect(def.parts.map((p) => p.path)).toContain(
        "Copilot/conversation.json",
      );
      expect(def.parts.map((p) => p.path)).toContain(
        "Copilot/README.md",
      );
      expect(semanticModelIncludesCopilotParts(def)).toBe(true);
    });

    it("rejects unsupported Copilot file extensions", () => {
      const d = semanticModelDirectory();
      const copilotDir = path.join(d, "definition", "Copilot");
      mkdirSync(copilotDir, { recursive: true });
      writeFileSync(
        path.join(d, "definition", "model.bim"),
        JSON.stringify({ compatibilityLevel: 1702, model: { tables: [] } }),
        "utf8",
      );
      writeFileSync(
        path.join(d, "definition", "definition.pbism"),
        JSON.stringify(pbismTmsl()),
        "utf8",
      );
      writeFileSync(
        path.join(copilotDir, "data.csv"),
        "a,b,c\n",
        "utf8",
      );
      expect(() => loadSemanticModelDefinition(d)).toThrow(
        "Unsupported Semantic Model definition path",
      );
    });

    it("hashes Copilot JSON canonically and Markdown as normalized text", () => {
      const base: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {
            compatibilityLevel: 1702,
            model: { tables: [] },
          }),
          jsonPart("definition.pbism", { version: "5.0" }),
          {
            path: "Copilot/conversation.json",
            payload: Buffer.from(
              '{"messages":[],"title":"Chat"}',
            ).toString("base64"),
            payloadType: "InlineBase64",
          },
          {
            path: "Copilot/README.md",
            payload: Buffer.from("# Notes\r\n").toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      };
      const reordered: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {
            compatibilityLevel: 1702,
            model: { tables: [] },
          }),
          jsonPart("definition.pbism", { version: "5.0" }),
          {
            path: "Copilot/conversation.json",
            // Different JSON key order → same canonical hash
            payload: Buffer.from(
              '{"title":"Chat","messages":[]}',
            ).toString("base64"),
            payloadType: "InlineBase64",
          },
          {
            path: "Copilot/README.md",
            // CRLF normalized to LF
            payload: Buffer.from("# Notes\n").toString("base64"),
            payloadType: "InlineBase64",
          },
        ],
      };

      expect(
        hashSemanticModelDefinition(base, false, false, true),
      ).toBe(
        hashSemanticModelDefinition(reordered, false, false, true),
      );
      // Without includeCopilot both hashes are equal (Copilot excluded)
      expect(
        hashSemanticModelDefinition(base, false, false, false),
      ).toBe(
        hashSemanticModelDefinition(reordered, false, false, false),
      );
    });

    it("excludes Copilot from hash when includeCopilot is false", () => {
      const withCopilot: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", { compatibilityLevel: 1702, model: {} }),
          jsonPart("definition.pbism", { version: "5.0" }),
          jsonPart("Copilot/conversation.json", { messages: [] }),
        ],
      };
      const withoutCopilot: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", { compatibilityLevel: 1702, model: {} }),
          jsonPart("definition.pbism", { version: "5.0" }),
        ],
      };
      expect(
        hashSemanticModelDefinition(withCopilot, false, false, false),
      ).toBe(
        hashSemanticModelDefinition(withoutCopilot, false, false, false),
      );
      expect(
        hashSemanticModelDefinition(withCopilot, false, false, true),
      ).not.toBe(
        hashSemanticModelDefinition(withoutCopilot, false, false, true),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // semanticModelPlatformLogicalId
  // ---------------------------------------------------------------------------
  describe("semanticModelPlatformLogicalId", () => {
    it("returns the UUID from a valid v2 .platform", () => {
      const def: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {}),
          jsonPart("definition.pbism", {}),
          jsonPart(".platform", {
            config: {
              version: "2.0",
              logicalId: "550e8400-e29b-41d4-a716-446655440000",
            },
          }),
        ],
      };
      expect(semanticModelPlatformLogicalId(def)).toBe(
        "550e8400-e29b-41d4-a716-446655440000",
      );
    });

    it("canonicalizes the platform logicalId to lowercase", () => {
      const def: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {}),
          jsonPart("definition.pbism", {}),
          jsonPart(".platform", {
            config: {
              version: "2.0",
              logicalId:
                "550E8400-E29B-41D4-A716-446655440000",
            },
          }),
        ],
      };
      expect(semanticModelPlatformLogicalId(def)).toBe(
        "550e8400-e29b-41d4-a716-446655440000",
      );
    });

    it("returns undefined when .platform is absent", () => {
      const def: FabricDefinition = {
        format: "TMSL",
        parts: [jsonPart("model.bim", {}), jsonPart("definition.pbism", {})],
      };
      expect(semanticModelPlatformLogicalId(def)).toBeUndefined();
    });

    it("returns undefined when config is absent or logicalId is not a UUID", () => {
      for (const platform of [
        { metadata: { type: "SemanticModel" } },
        { config: { version: "1.0", logicalId: "not-uuid" } },
        { config: { version: "2.0" } },
      ]) {
        const def: FabricDefinition = {
          format: "TMSL",
          parts: [
            jsonPart("model.bim", {}),
            jsonPart("definition.pbism", {}),
            jsonPart(".platform", platform),
          ],
        };
        expect(
          semanticModelPlatformLogicalId(def),
          JSON.stringify(platform),
        ).toBeUndefined();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // buildEffectiveSemanticModelDefinition
  // ---------------------------------------------------------------------------
  describe("buildEffectiveSemanticModelDefinition", () => {
    it("preserves current diagramLayout.json, .platform, and Copilot parts omitted from desired", () => {
      const desired: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", { compatibilityLevel: 1702, model: {} }),
          jsonPart("definition.pbism", { version: "5.0" }),
        ],
      };
      const current: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", { compatibilityLevel: 1500, model: {} }),
          jsonPart("definition.pbism", { version: "5.0" }),
          jsonPart("diagramLayout.json", { version: "1.1.0", diagrams: [] }),
          jsonPart(".platform", {
            config: {
              version: "2.0",
              logicalId: "550e8400-e29b-41d4-a716-446655440000",
            },
          }),
          jsonPart("Copilot/conversation.json", { messages: [] }),
        ],
      };

      const effective = buildEffectiveSemanticModelDefinition(
        desired,
        current,
      );
      const paths = effective.parts.map((p) => p.path);
      // Core: from desired
      expect(paths).toContain("model.bim");
      expect(paths).toContain("definition.pbism");
      // Aux: preserved from current
      expect(paths).toContain("diagramLayout.json");
      expect(paths).toContain(".platform");
      expect(paths).toContain("Copilot/conversation.json");
      // Core content from desired (version 1702, not 1500)
      const bimPart = effective.parts.find((p) => p.path === "model.bim")!;
      const bimContent = JSON.parse(
        Buffer.from(bimPart.payload, "base64").toString("utf8"),
      ) as { compatibilityLevel: number };
      expect(bimContent.compatibilityLevel).toBe(1702);
    });

    it("uses desired content when desired includes an aux part", () => {
      const desiredPlatform = jsonPart(".platform", {
        config: {
          version: "2.0",
          logicalId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
        },
      });
      const desired: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {}),
          jsonPart("definition.pbism", {}),
          desiredPlatform,
        ],
      };
      const current: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", {}),
          jsonPart("definition.pbism", {}),
          jsonPart(".platform", {
            config: {
              version: "2.0",
              logicalId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
            },
          }),
        ],
      };

      const effective = buildEffectiveSemanticModelDefinition(
        desired,
        current,
      );
      const platformPart = effective.parts.find(
        (p) => p.path === ".platform",
      )!;
      expect(platformPart.payload).toBe(desiredPlatform.payload);
    });

    it("does not preserve stale cross-format core parts from current", () => {
      const desired: FabricDefinition = {
        format: "TMSL",
        parts: [
          jsonPart("model.bim", { compatibilityLevel: 1702, model: {} }),
          jsonPart("definition.pbism", { version: "5.0" }),
        ],
      };
      const currentTmdl: FabricDefinition = {
        format: "TMDL",
        parts: [
          {
            path: "definition/model.tmdl",
            payload: Buffer.from("model Model\n").toString("base64"),
            payloadType: "InlineBase64",
          },
          jsonPart("definition.pbism", { version: "5.0" }),
          jsonPart("diagramLayout.json", { version: "1.1.0", diagrams: [] }),
        ],
      };

      const effective = buildEffectiveSemanticModelDefinition(
        desired,
        currentTmdl,
      );
      const paths = effective.parts.map((p) => p.path);
      // TMDL core parts must NOT be preserved
      expect(paths).not.toContain("definition/model.tmdl");
      // Aux from current IS preserved
      expect(paths).toContain("diagramLayout.json");
    });
  });

  // ---------------------------------------------------------------------------
  // hashAuxiliarySemanticModelParts
  // ---------------------------------------------------------------------------
  describe("hashAuxiliarySemanticModelParts", () => {
    it("produces stable hashes across JSON key-order variation and CRLF normalization", () => {
      const partsA = [
        jsonPart(".platform", { config: { version: "2.0" } }),
        {
          path: "Copilot/README.md",
          payload: Buffer.from("# Notes\r\n").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ];
      const partsB = [
        jsonPart(".platform", { config: { version: "2.0" } }),
        {
          path: "Copilot/README.md",
          payload: Buffer.from("# Notes\n").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ];
      expect(hashAuxiliarySemanticModelParts(partsA)).toBe(
        hashAuxiliarySemanticModelParts(partsB),
      );
    });

    it("returns different hashes for different content", () => {
      const partsA = [jsonPart("diagramLayout.json", { version: "1.0.0" })];
      const partsB = [jsonPart("diagramLayout.json", { version: "2.0.0" })];
      expect(hashAuxiliarySemanticModelParts(partsA)).not.toBe(
        hashAuxiliarySemanticModelParts(partsB),
      );
    });

    it("ignores service-synchronized platform display metadata", () => {
      const before = [
        jsonPart(".platform", {
          metadata: {
            type: "SemanticModel",
            displayName: "Before",
            description: "Before",
          },
          config: {
            version: "2.0",
            logicalId:
              "550e8400-e29b-41d4-a716-446655440000",
          },
        }),
      ];
      const after = [
        jsonPart(".platform", {
          metadata: {
            type: "SemanticModel",
            displayName: "After",
            description: "After",
          },
          config: {
            version: "2.0",
            logicalId:
              "550e8400-e29b-41d4-a716-446655440000",
          },
        }),
      ];
      const differentIdentity = [
        jsonPart(".platform", {
          metadata: {
            type: "SemanticModel",
            displayName: "After",
          },
          config: {
            version: "2.0",
            logicalId:
              "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
          },
        }),
      ];

      expect(hashAuxiliarySemanticModelParts(before)).toBe(
        hashAuxiliarySemanticModelParts(after),
      );
      expect(hashAuxiliarySemanticModelParts(before)).not.toBe(
        hashAuxiliarySemanticModelParts(differentIdentity),
      );
    });
  });
});
