import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

const PBISM_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json";
const PBIR_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json";
const VERSION_METADATA_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json";
const PAGES_METADATA_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json";

function fixture(): {
  root: string;
  manifestPath: string;
  reportPropertiesPath: string;
} {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-report-manifest-"),
  );
  const model = path.join(root, "items", "model");
  const report = path.join(root, "items", "report");
  mkdirSync(path.join(model, "definition"), { recursive: true });
  mkdirSync(path.join(report, "definition", "definition"), {
    recursive: true,
  });
  writeFileSync(
    path.join(model, "item.yaml"),
    "displayName: Sales Model\n",
  );
  writeFileSync(
    path.join(model, "definition", "model.bim"),
    JSON.stringify({
      compatibilityLevel: 1702,
      model: { culture: "en-US", tables: [] },
    }),
  );
  writeFileSync(
    path.join(model, "definition", "definition.pbism"),
    JSON.stringify({
      $schema: PBISM_SCHEMA,
      version: "1.0",
      settings: {},
    }),
  );
  writeFileSync(
    path.join(report, "item.yaml"),
    [
      "displayName: Sales Report",
      "references:",
      "  semanticModel: salesModel",
      "",
    ].join("\n"),
  );
  const reportPropertiesPath = path.join(
    report,
    "definition",
    "definition.pbir",
  );
  writeFileSync(
    reportPropertiesPath,
    JSON.stringify({
      $schema: PBIR_SCHEMA,
      version: "4.0",
      datasetReference: {
        byConnection: {
          connectionString: "semanticmodelid=source-one",
        },
      },
    }),
  );
  writeFileSync(
    path.join(
      report,
      "definition",
      "definition",
      "report.json",
    ),
    "{}",
  );
  writeFileSync(
    path.join(
      report,
      "definition",
      "definition",
      "version.json",
    ),
    JSON.stringify({
      $schema: VERSION_METADATA_SCHEMA,
      version: "2.0.0",
    }),
  );
  mkdirSync(
    path.join(
      report,
      "definition",
      "definition",
      "pages",
      "page-1",
    ),
    { recursive: true },
  );
  writeFileSync(
    path.join(
      report,
      "definition",
      "definition",
      "pages",
      "pages.json",
    ),
    JSON.stringify({
      $schema: PAGES_METADATA_SCHEMA,
      pageOrder: ["page-1"],
      activePageName: "page-1",
    }),
  );
  writeFileSync(
    path.join(
      report,
      "definition",
      "definition",
      "pages",
      "page-1",
      "page.json",
    ),
    JSON.stringify({
      name: "page-1",
      displayName: "Overview",
      displayOption: "FitToPage",
      height: 720,
      width: 1280,
    }),
  );
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(
    manifestPath,
    [
      "apiVersion: fabric.deploy/v1alpha1",
      "kind: FabricDeployment",
      "metadata:",
      "  deploymentId: report-test",
      "workspace:",
      "  id: 00000000-0000-0000-0000-000000000001",
      "items:",
      "  - logicalId: salesModel",
      "    type: SemanticModel",
      "    path: items/model",
      "  - logicalId: salesReport",
      "    type: Report",
      "    path: items/report",
      "    dependsOn:",
      "      - salesModel",
      "",
    ].join("\n"),
  );
  return { root, manifestPath, reportPropertiesPath };
}

describe("Report manifests", () => {
  it("rejects desiredState: absent until Report deletion has stable identity proof", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-report-delete-manifest-"),
    );
    const report = path.join(root, "items", "report");
    mkdirSync(report, { recursive: true });
    writeFileSync(
      path.join(report, "item.yaml"),
      "displayName: Sales Report\ndesiredState: absent\n",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      [
        "apiVersion: fabric.deploy/v1alpha1",
        "kind: FabricDeployment",
        "metadata:",
        "  deploymentId: report-delete-test",
        "workspace:",
        "  id: 00000000-0000-0000-0000-000000000001",
        "items:",
        "  - logicalId: salesReport",
        "    type: Report",
        "    path: items/report",
        "    desiredState: absent",
        "",
      ].join("\n"),
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "does not support desiredState: absent",
    );
  });

  it("loads a bound Report and excludes the source physical ID from item content hashing", () => {
    const files = fixture();
    const first = loadManifest(files.manifestPath);
    writeFileSync(
      files.reportPropertiesPath,
      JSON.stringify({
        $schema: PBIR_SCHEMA,
        version: "4.0",
        datasetReference: {
          byConnection: {
            connectionString: "semanticmodelid=source-two",
          },
        },
      }),
    );
    const second = loadManifest(files.manifestPath);

    expect(first.reportDefinitions?.salesReport?.format).toBe(
      "PBIR",
    );
    expect(first.itemContentHashes.salesReport).toBe(
      second.itemContentHashes.salesReport,
    );
  });

  it("requires the Semantic Model dependency and target type", () => {
    const files = fixture();
    const source = [
      "apiVersion: fabric.deploy/v1alpha1",
      "kind: FabricDeployment",
      "metadata:",
      "  deploymentId: report-test",
      "workspace:",
      "  id: 00000000-0000-0000-0000-000000000001",
      "items:",
      "  - logicalId: salesModel",
      "    type: SemanticModel",
      "    path: items/model",
      "  - logicalId: salesReport",
      "    type: Report",
      "    path: items/report",
      "",
    ].join("\n");
    writeFileSync(files.manifestPath, source);
    expect(() => loadManifest(files.manifestPath)).toThrow(
      "dependsOn does not include it",
    );
  });
});
