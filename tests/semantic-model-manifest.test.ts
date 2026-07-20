import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

/**
 * Official $schema URL for definition.pbism.
 * Must match the constant in semantic-model-definition.ts.
 */
const PBISM_SCHEMA_URL =
  "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json";

function rootDirectory(): string {
  return mkdtempSync(
    path.join(tmpdir(), "fabric-semantic-manifest-"),
  );
}

function writeTmslItem(
  root: string,
  relativePath: string,
  itemYaml: string,
  platform?: Record<string, unknown>,
): void {
  const itemDirectory = path.join(root, relativePath);
  mkdirSync(path.join(itemDirectory, "definition"), {
    recursive: true,
  });
  writeFileSync(
    path.join(itemDirectory, "item.yaml"),
    itemYaml,
    "utf8",
  );
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
    JSON.stringify({
      $schema: PBISM_SCHEMA_URL,
      version: "5.0",
      settings: {},
    }),
    "utf8",
  );
  if (platform) {
    writeFileSync(
      path.join(itemDirectory, "definition", ".platform"),
      JSON.stringify(platform),
      "utf8",
    );
  }
}

function writeManifest(root: string, items: string): string {
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(
    manifestPath,
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: semantic-model
workspace:
  id: workspace
items:
${items}
`,
    "utf8",
  );
  return manifestPath;
}

/**
 * Returns a valid v2 .platform JSON object for a Semantic Model.
 * logicalId must be a valid RFC 4122 UUID (version 1-5, variant 8/9/a/b).
 */
function validPlatformV2(
  logicalId: string,
  displayName: string,
  description?: string,
): Record<string, unknown> {
  return {
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    config: {
      version: "2.0",
      logicalId,
    },
    metadata: {
      type: "SemanticModel",
      displayName,
      ...(description !== undefined ? { description } : {}),
    },
  };
}

describe("Semantic Model manifest integration", () => {
  it("captures the required definition snapshot and validates managed platform metadata", () => {
    const root = rootDirectory();
    writeTmslItem(
      root,
      "items/semantic-models/sales",
      "displayName: Sales\ndescription: Managed model\n",
      validPlatformV2(
        "12345678-1234-4234-8234-1234567890ab",
        "Sales",
        "Managed model",
      ),
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
`,
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.semanticModelDefinitions.sales).toMatchObject({
      format: "TMSL",
      parts: expect.arrayContaining([
        expect.objectContaining({ path: "model.bim" }),
        expect.objectContaining({ path: "definition.pbism" }),
        expect.objectContaining({ path: ".platform" }),
      ]),
    });
    expect(loaded.itemContentHashes.sales).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("requires item.yaml metadata to match a managed Semantic Model .platform", () => {
    const root = rootDirectory();
    writeTmslItem(
      root,
      "items/semantic-models/sales",
      "displayName: Sales\n",
      validPlatformV2(
        "12345678-1234-4234-8234-1234567890ab",
        "Sales",
        "",
      ),
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "must define item.yaml description when .platform metadata is managed",
    );
  });

  it("rejects duplicate desired identities and permits normal Fabric tag assignment", () => {
    const duplicateRoot = rootDirectory();
    writeTmslItem(
      duplicateRoot,
      "items/semantic-models/one",
      "displayName: Sales\n",
    );
    writeTmslItem(
      duplicateRoot,
      "items/semantic-models/two",
      "displayName: Sales\n",
    );
    const duplicateManifest = writeManifest(
      duplicateRoot,
      `  - logicalId: one
    type: SemanticModel
    path: items/semantic-models/one
  - logicalId: two
    type: SemanticModel
    path: items/semantic-models/two
`,
    );
    expect(() => loadManifest(duplicateManifest)).toThrow(
      "resolve to the same folder and displayName",
    );

    const taggedRoot = rootDirectory();
    const tagDirectory = path.join(
      taggedRoot,
      "items",
      "tags",
      "review",
    );
    mkdirSync(tagDirectory, { recursive: true });
    writeFileSync(
      path.join(tagDirectory, "item.yaml"),
      "displayName: Review\nscope:\n  type: Tenant\n",
      "utf8",
    );
    writeTmslItem(
      taggedRoot,
      "items/semantic-models/sales",
      "displayName: Sales\ntags: [review]\n",
    );
    const taggedManifest = writeManifest(
      taggedRoot,
      `  - logicalId: review
    type: FabricTag
    path: items/tags/review
  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
    dependsOn: [review]
`,
    );

    expect(
      loadManifest(taggedManifest).itemDefinitions.sales?.tags,
    ).toEqual(["review"]);
  });

  it("rejects two Semantic Models sharing the same .platform logicalId", () => {
    const root = rootDirectory();
    const sharedLogicalId = "12345678-1234-4234-8234-1234567890ab";
    writeTmslItem(
      root,
      "items/semantic-models/alpha",
      "displayName: Alpha\ndescription: First\n",
      validPlatformV2(sharedLogicalId, "Alpha", "First"),
    );
    writeTmslItem(
      root,
      "items/semantic-models/beta",
      "displayName: Beta\ndescription: Second\n",
      validPlatformV2(
        sharedLogicalId.toUpperCase(),
        "Beta",
        "Second",
      ),
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: alpha
    type: SemanticModel
    path: items/semantic-models/alpha
  - logicalId: beta
    type: SemanticModel
    path: items/semantic-models/beta
`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "same .platform config.logicalId",
    );
  });

  it("rejects a Semantic Model .platform missing the 'config' object", () => {
    const root = rootDirectory();
    writeTmslItem(
      root,
      "items/semantic-models/sales",
      "displayName: Sales\ndescription: Managed\n",
      {
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        // config intentionally omitted
        metadata: {
          type: "SemanticModel",
          displayName: "Sales",
          description: "Managed",
        },
      },
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
`,
    );

    expect(() => loadManifest(manifestPath)).toThrow("'config' object");
  });

  it("rejects a Semantic Model .platform with a non-v2 version", () => {
    const root = rootDirectory();
    writeTmslItem(
      root,
      "items/semantic-models/sales",
      "displayName: Sales\ndescription: Managed\n",
      {
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        config: {
          version: "1.0", // wrong version
          logicalId: "12345678-1234-4234-8234-1234567890ab",
        },
        metadata: {
          type: "SemanticModel",
          displayName: "Sales",
          description: "Managed",
        },
      },
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      'must declare version "2.0"',
    );
  });

  it("rejects a Semantic Model .platform with an invalid config.logicalId", () => {
    const root = rootDirectory();
    writeTmslItem(
      root,
      "items/semantic-models/sales",
      "displayName: Sales\ndescription: Managed\n",
      {
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        config: {
          version: "2.0",
          logicalId: "not-a-valid-uuid",
        },
        metadata: {
          type: "SemanticModel",
          displayName: "Sales",
          description: "Managed",
        },
      },
    );
    const manifestPath = writeManifest(
      root,
      `  - logicalId: sales
    type: SemanticModel
    path: items/semantic-models/sales
`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "config.logicalId must be a valid UUID",
    );
  });
});
