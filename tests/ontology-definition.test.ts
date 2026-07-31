import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  hashOntologyDefinition,
  loadOntologyDefinition,
} from "../src/fabric/ontology-definition";

function ontologyDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-ontology-"));
  const itemDirectory = path.join(root, "ontology");
  mkdirSync(
    path.join(
      itemDirectory,
      "definition",
      "EntityTypes",
      "1001",
    ),
    { recursive: true },
  );
  return itemDirectory;
}

function writeDefinition(itemDirectory: string): void {
  writeFileSync(
    path.join(itemDirectory, "definition", "definition.json"),
    "{}\n",
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", ".platform"),
    JSON.stringify({
      metadata: {
        type: "Ontology",
        displayName: "AssetOntology",
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(
      itemDirectory,
      "definition",
      "EntityTypes",
      "1001",
      "definition.json",
    ),
    JSON.stringify({
      id: "1001",
      namespace: "usertypes",
      name: "Asset",
      namespaceType: "Custom",
      properties: [],
    }),
    "utf8",
  );
}

describe("Ontology definitions", () => {
  it("loads the documented JSON definition tree without emitting a format field", () => {
    const itemDirectory = ontologyDirectory();
    writeDefinition(itemDirectory);

    const definition = loadOntologyDefinition(itemDirectory);

    expect(definition.format).toBeUndefined();
    expect(definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      "EntityTypes/1001/definition.json",
      "definition.json",
    ]);
  });

  it("hashes JSON formatting semantically and ignores service platform fields", () => {
    const baseParts = [
      {
        path: "definition.json",
        payload: Buffer.from("{}").toString("base64"),
        payloadType: "InlineBase64" as const,
      },
      {
        path: "EntityTypes/1001/definition.json",
        payload: Buffer.from(
          JSON.stringify({
            id: "1001",
            namespace: "usertypes",
            name: "Asset",
            namespaceType: "Custom",
          }),
        ).toString("base64"),
        payloadType: "InlineBase64" as const,
      },
    ];
    const desired: FabricDefinition = {
      format: "Default",
      parts: [
        ...baseParts,
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              metadata: {
                type: "Ontology",
                displayName: "AssetOntology",
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    const observed: FabricDefinition = {
      parts: [
        {
          ...baseParts[1]!,
          payload: Buffer.from(
            JSON.stringify({
              $schema:
                "https://developer.microsoft.com/json-schemas/fabric/item/ontology/entityType/1.0.0/schema.json",
              id: "1001",
              namespace: "usertypes",
              baseEntityTypeId: null,
              name: "Asset",
              entityIdParts: [],
              displayNamePropertyId: null,
              namespaceType: "Custom",
              visibility: "Visible",
              properties: [],
              timeseriesProperties: [],
              untypedProperties: [],
            }),
          ).toString("base64"),
        },
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              metadata: {
                displayName: "AssetOntology",
                type: "Ontology",
              },
              config: {
                logicalId:
                  "11111111-1111-4111-8111-111111111111",
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        baseParts[0]!,
      ],
    };

    expect(hashOntologyDefinition(observed)).toBe(
      hashOntologyDefinition(desired),
    );
  });

  it("requires root and platform parts", () => {
    const itemDirectory = ontologyDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "definition.json"),
      "{}",
      "utf8",
    );

    expect(() => loadOntologyDefinition(itemDirectory)).toThrow(
      "definition/.platform",
    );
  });

  it("rejects unsupported paths and entity IDs that do not match the path", () => {
    const itemDirectory = ontologyDirectory();
    writeDefinition(itemDirectory);
    writeFileSync(
      path.join(itemDirectory, "definition", "notes.txt"),
      "unsupported",
      "utf8",
    );
    expect(() => loadOntologyDefinition(itemDirectory)).toThrow(
      "Unsupported Ontology definition path",
    );

    const mismatched = ontologyDirectory();
    writeDefinition(mismatched);
    writeFileSync(
      path.join(
        mismatched,
        "definition",
        "EntityTypes",
        "1001",
        "definition.json",
      ),
      JSON.stringify({ id: "1002" }),
      "utf8",
    );
    expect(() => loadOntologyDefinition(mismatched)).toThrow(
      "id must match path ID",
    );
  });
});
