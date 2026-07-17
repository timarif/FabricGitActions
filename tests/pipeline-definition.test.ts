import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  hashPipelineDefinition,
  loadPipelineDefinition,
  pipelineIncludesPlatformPart,
} from "../src/fabric/pipeline-definition";

function pipelineDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-pipeline-"));
  const itemDirectory = path.join(root, "pipeline");
  mkdirSync(path.join(itemDirectory, "definition"), {
    recursive: true,
  });
  return itemDirectory;
}

describe("Data Pipeline definitions", () => {
  it("loads the public definition snapshot and optional platform metadata", () => {
    const itemDirectory = pipelineDirectory();
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "pipeline-content.json",
      ),
      JSON.stringify({
        properties: {
          activities: [
            {
              name: "Wait1",
              type: "Wait",
              dependsOn: [],
              typeProperties: { waitTimeInSeconds: 1 },
            },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", ".platform"),
      JSON.stringify({
        metadata: {
          type: "DataPipeline",
          displayName: "Hello",
          description: "",
        },
      }),
      "utf8",
    );

    const definition = loadPipelineDefinition(itemDirectory);

    expect(definition).toMatchInlineSnapshot(`
      {
        "parts": [
          {
            "path": ".platform",
            "payload": "eyJtZXRhZGF0YSI6eyJ0eXBlIjoiRGF0YVBpcGVsaW5lIiwiZGlzcGxheU5hbWUiOiJIZWxsbyIsImRlc2NyaXB0aW9uIjoiIn19",
            "payloadType": "InlineBase64",
          },
          {
            "path": "pipeline-content.json",
            "payload": "eyJwcm9wZXJ0aWVzIjp7ImFjdGl2aXRpZXMiOlt7Im5hbWUiOiJXYWl0MSIsInR5cGUiOiJXYWl0IiwiZGVwZW5kc09uIjpbXSwidHlwZVByb3BlcnRpZXMiOnsid2FpdFRpbWVJblNlY29uZHMiOjF9fV19fQ==",
            "payloadType": "InlineBase64",
          },
        ],
      }
    `);
    expect(pipelineIncludesPlatformPart(definition)).toBe(true);
  });

  it("hashes pipeline and platform JSON semantically", () => {
    const first: FabricDefinition = {
      parts: [
        {
          path: "pipeline-content.json",
          payload: Buffer.from(
            '{"properties":{"description":"Hello","activities":[]}}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(
            '{"metadata":{"type":"DataPipeline","x":1}}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    const second: FabricDefinition = {
      format: "service-default",
      parts: [
        {
          path: ".platform",
          payload: Buffer.from(
            '{\n "metadata": { "x": 1, "type": "DataPipeline" }\n}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "pipeline-content.json",
          payload: Buffer.from(
            '{\n "properties": { "activities": [], "description": "Hello" }\n}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(hashPipelineDefinition(first, true)).toBe(
      hashPipelineDefinition(second, true),
    );
  });

  it("rejects unsupported paths and sensitivity-label metadata", () => {
    const itemDirectory = pipelineDirectory();
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "pipeline-content.json",
      ),
      '{"properties":{"activities":[]}}',
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition", "notes.json"),
      "{}",
      "utf8",
    );

    expect(() => loadPipelineDefinition(itemDirectory)).toThrow(
      "Unsupported Data Pipeline definition path 'notes.json'",
    );

    const secondItemDirectory = pipelineDirectory();
    writeFileSync(
      path.join(
        secondItemDirectory,
        "definition",
        "pipeline-content.json",
      ),
      '{"properties":{"activities":[]}}',
      "utf8",
    );
    writeFileSync(
      path.join(secondItemDirectory, "definition", ".platform"),
      '{"metadata":{"type":"DataPipeline"},"sensitivityLabelId":"label"}',
      "utf8",
    );

    expect(() =>
      loadPipelineDefinition(secondItemDirectory),
    ).toThrow("sensitivity labels are not supported");
  });

  it("rejects non-object pipeline content", () => {
    const itemDirectory = pipelineDirectory();
    writeFileSync(
      path.join(
        itemDirectory,
        "definition",
        "pipeline-content.json",
      ),
      "[]",
      "utf8",
    );

    expect(() => loadPipelineDefinition(itemDirectory)).toThrow(
      "must contain a JSON object",
    );
  });
});
