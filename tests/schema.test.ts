import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deploymentSchema } from "../src/schema";

describe("published deployment schema", () => {
  it("stays synchronized with the runtime schema", () => {
    const published = JSON.parse(
      readFileSync(
        path.resolve(
          process.cwd(),
          "schemas/deployment-v1alpha1.schema.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(published.$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(published.title).toBe(
      "Microsoft Fabric deployment manifest",
    );

    const comparable = { ...published };
    delete comparable.$schema;
    delete comparable.title;
    expect(comparable).toEqual(deploymentSchema);
    expect(
      (
        (
          published.properties as Record<string, unknown>
        ).items as {
          items: {
            properties: {
              type: { enum: string[] };
            };
          };
        }
      ).items.properties.type.enum,
    ).toContain("SemanticModel");
    expect(
      (
        (
          published.properties as Record<string, unknown>
        ).items as {
          items: {
            properties: {
              type: { enum: string[] };
            };
          };
        }
      ).items.properties.type.enum,
    ).toContain("Eventhouse");
  });
});
