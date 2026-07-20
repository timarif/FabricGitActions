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
  assertReportBinding,
  buildEffectiveReportDefinition,
  hashAuxiliaryReportParts,
  hashReportDefinition,
  hashReportSourceDefinition,
  loadReportDefinition,
  reportDefinitionFormat,
  reportIncludesDiagramLayoutPart,
  reportIncludesPlatformPart,
} from "../src/fabric/report-definition";

const PBIR_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json";
const VERSION_METADATA_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json";
const PAGES_METADATA_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json";

function reportDirectory(): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-report-definition-"),
  );
  const itemDirectory = path.join(root, "report");
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

function pbirProperties(modelId: string, version = "4.0") {
  return {
    $schema: PBIR_SCHEMA,
    version,
    datasetReference: {
      byConnection: {
        connectionString: `semanticmodelid=${modelId}`,
      },
    },
  };
}

function pbirDefinition(
  modelId = "11111111-1111-4111-8111-111111111111",
): FabricDefinition {
  return {
    format: "PBIR",
    parts: [
      jsonPart("definition.pbir", pbirProperties(modelId)),
      jsonPart("definition/report.json", {
        $schema: "report-schema",
        themeCollection: {},
      }),
      jsonPart("definition/version.json", {
        $schema: VERSION_METADATA_SCHEMA,
        version: "2.0.0",
      }),
      jsonPart("definition/pages/pages.json", {
        pageOrder: [],
      }),
    ],
  };
}

describe("Report definitions", () => {
  it("loads PBIR pages, visuals, bookmarks, resources, and official optional parts", () => {
    const itemDirectory = reportDirectory();
    const root = path.join(itemDirectory, "definition");
    mkdirSync(
      path.join(
        root,
        "definition",
        "pages",
        "page-1",
        "visuals",
        "visual-1",
      ),
      { recursive: true },
    );
    mkdirSync(path.join(root, "definition", "bookmarks"), {
      recursive: true,
    });
    mkdirSync(path.join(root, "StaticResources", "RegisteredResources"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "definition.pbir"),
      JSON.stringify(pbirProperties("source-placeholder")),
    );
    writeFileSync(
      path.join(root, "definition", "report.json"),
      JSON.stringify({ $schema: "report-schema" }),
    );
    writeFileSync(
      path.join(root, "definition", "version.json"),
      JSON.stringify({
        $schema: VERSION_METADATA_SCHEMA,
        version: "2.0.0",
      }),
    );
    writeFileSync(
      path.join(root, "definition", "pages", "pages.json"),
      JSON.stringify({
        $schema: PAGES_METADATA_SCHEMA,
        pageOrder: ["page-1"],
        activePageName: "page-1",
      }),
    );
    writeFileSync(
      path.join(
        root,
        "definition",
        "pages",
        "page-1",
        "page.json",
      ),
      JSON.stringify({ name: "page-1" }),
    );
    writeFileSync(
      path.join(
        root,
        "definition",
        "pages",
        "page-1",
        "visuals",
        "visual-1",
        "visual.json",
      ),
      JSON.stringify({ name: "visual-1" }),
    );
    writeFileSync(
      path.join(
        root,
        "definition",
        "bookmarks",
        "bookmark-1.bookmark.json",
      ),
      JSON.stringify({ name: "bookmark-1" }),
    );
    writeFileSync(
      path.join(
        root,
        "StaticResources",
        "RegisteredResources",
        "theme.json",
      ),
      Buffer.from([0, 1, 2, 3]),
    );
    writeFileSync(
      path.join(root, "semanticModelDiagramLayout.json"),
      JSON.stringify({ diagrams: [] }),
    );
    writeFileSync(
      path.join(root, ".platform"),
      JSON.stringify({
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        config: {
          version: "2.0",
          logicalId: "550e8400-e29b-41d4-a716-446655440000",
        },
        metadata: {
          type: "Report",
          displayName: "Sales Report",
          description: "Managed",
        },
      }),
    );

    const definition = loadReportDefinition(itemDirectory);

    expect(definition.format).toBe("PBIR");
    expect(definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      "StaticResources/RegisteredResources/theme.json",
      "definition.pbir",
      "definition/bookmarks/bookmark-1.bookmark.json",
      "definition/pages/page-1/page.json",
      "definition/pages/page-1/visuals/visual-1/visual.json",
      "definition/pages/pages.json",
      "definition/report.json",
      "definition/version.json",
      "semanticModelDiagramLayout.json",
    ]);
    expect(reportIncludesPlatformPart(definition)).toBe(true);
    expect(reportIncludesDiagramLayoutPart(definition)).toBe(true);
  });

  it("rejects PBIR version metadata without the official schema", () => {
    const itemDirectory = reportDirectory();
    const root = path.join(itemDirectory, "definition");
    mkdirSync(path.join(root, "definition"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "definition.pbir"),
      JSON.stringify(pbirProperties("source-placeholder")),
    );
    writeFileSync(
      path.join(root, "definition", "report.json"),
      "{}",
    );
    writeFileSync(
      path.join(root, "definition", "version.json"),
      JSON.stringify({ version: "2.0.0" }),
    );

    expect(() => loadReportDefinition(itemDirectory)).toThrow(
      "definition/version.json must use",
    );
  });

  it("rejects PBIR definitions without a page", () => {
    const itemDirectory = reportDirectory();
    const root = path.join(itemDirectory, "definition");
    mkdirSync(path.join(root, "definition"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "definition.pbir"),
      JSON.stringify(pbirProperties("source-placeholder")),
    );
    writeFileSync(
      path.join(root, "definition", "report.json"),
      "{}",
    );
    writeFileSync(
      path.join(root, "definition", "version.json"),
      JSON.stringify({
        $schema: VERSION_METADATA_SCHEMA,
        version: "2.0.0",
      }),
    );

    expect(() => loadReportDefinition(itemDirectory)).toThrow(
      "at least one page definition",
    );
  });

  it("loads PBIR-Legacy and rejects mixed layouts", () => {
    const itemDirectory = reportDirectory();
    const root = path.join(itemDirectory, "definition");
    writeFileSync(
      path.join(root, "definition.pbir"),
      JSON.stringify(pbirProperties("placeholder", "1.0")),
    );
    writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify({ sections: [] }),
    );
    expect(reportDefinitionFormat(loadReportDefinition(itemDirectory))).toBe(
      "PBIR-Legacy",
    );

    mkdirSync(path.join(root, "definition"), { recursive: true });
    writeFileSync(
      path.join(root, "definition", "report.json"),
      "{}",
    );
    writeFileSync(
      path.join(root, "definition", "version.json"),
      "{}",
    );
    expect(() => loadReportDefinition(itemDirectory)).toThrow(
      "must not mix PBIR",
    );
  });

  it("rejects legacy definitionProperties schemas that carry duplicate physical binding fields", () => {
    const itemDirectory = reportDirectory();
    const root = path.join(itemDirectory, "definition");
    writeFileSync(
      path.join(root, "definition.pbir"),
      JSON.stringify({
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/1.0.0/schema.json",
        version: "1.0",
        datasetReference: {
          byConnection: {
            connectionString: "semanticmodelid=old",
            pbiServiceModelId: 1,
            pbiModelVirtualServerName: "sobe_wowvirtualserver",
            pbiModelDatabaseName: "old",
            name: "EntityDataSource",
            connectionType: "pbiServiceXmlaStyleLive",
          },
        },
      }),
    );
    writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify({ sections: [] }),
    );

    expect(() => loadReportDefinition(itemDirectory)).toThrow(
      "definitionProperties/2.x.x",
    );
  });

  it("rejects legacy binding fields even when a definition claims the 2.x schema", () => {
    const definition = pbirDefinition();
    definition.parts[0] = jsonPart("definition.pbir", {
      ...pbirProperties("model"),
      datasetReference: {
        byConnection: {
          connectionString: "semanticmodelid=model",
          pbiModelDatabaseName: "stale-model",
        },
      },
    });

    expect(() =>
      hashReportDefinition(definition, false, false),
    ).toThrow("unsupported properties: pbiModelDatabaseName");
  });

  it("excludes the physical model ID from source hashing but includes it in materialized hashing", () => {
    const left = pbirDefinition(
      "11111111-1111-4111-8111-111111111111",
    );
    const right = pbirDefinition(
      "22222222-2222-4222-8222-222222222222",
    );

    expect(hashReportSourceDefinition(left)).toBe(
      hashReportSourceDefinition(right),
    );
    expect(
      hashReportDefinition(left, false, false),
    ).not.toBe(hashReportDefinition(right, false, false));
    assertReportBinding(
      right,
      "22222222-2222-4222-8222-222222222222",
    );
  });

  it("normalizes the service-expanded connection string to its Semantic Model ID", () => {
    const semanticModelId =
      "22222222-2222-4222-8222-222222222222";
    const desired = pbirDefinition(semanticModelId);
    const service = pbirDefinition(semanticModelId);
    service.parts[0] = jsonPart("definition.pbir", {
      ...pbirProperties(semanticModelId),
      datasetReference: {
        byConnection: {
          connectionString:
            "Data Source=powerbi://api.powerbi.com/v1.0/myorg/workspace;" +
            "initial catalog=Sales Model;integrated security=ClaimsToken;" +
            `semanticmodelid=${semanticModelId}`,
        },
      },
    });

    expect(
      hashReportDefinition(desired, false, false),
    ).toBe(
      hashReportDefinition(service, false, false),
    );
    assertReportBinding(service, semanticModelId);
  });

  it("preserves only omitted platform and diagram layout parts during full replacement", () => {
    const desired = pbirDefinition("model-new");
    const current: FabricDefinition = {
      format: "PBIR-Legacy",
      parts: [
        jsonPart("definition.pbir", pbirProperties("model-old")),
        jsonPart("report.json", { sections: [] }),
        jsonPart(".platform", { metadata: { type: "Report" } }),
        jsonPart("semanticModelDiagramLayout.json", {
          diagrams: [],
        }),
        {
          path: "StaticResources/obsolete.bin",
          payload: Buffer.from("obsolete").toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    const effective = buildEffectiveReportDefinition(
      desired,
      current,
    );

    expect(effective.format).toBe("PBIR");
    expect(effective.parts.map((part) => part.path)).toContain(
      ".platform",
    );
    expect(effective.parts.map((part) => part.path)).toContain(
      "semanticModelDiagramLayout.json",
    );
    expect(effective.parts.map((part) => part.path)).not.toContain(
      "report.json",
    );
    expect(effective.parts.map((part) => part.path)).not.toContain(
      "StaticResources/obsolete.bin",
    );
    expect(
      hashAuxiliaryReportParts(
        effective.parts.filter(
          (part) =>
            part.path === ".platform" ||
            part.path === "semanticModelDiagramLayout.json",
        ),
      ),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects unsafe, unsupported, malformed, case-colliding, and sensitivity-label content", () => {
    const duplicate: FabricDefinition = {
      ...pbirDefinition(),
      parts: [
        ...pbirDefinition().parts,
        jsonPart("DEFINITION/REPORT.JSON", {}),
      ],
    };
    expect(() =>
      hashReportDefinition(duplicate, false, false),
    ).toThrow("case-colliding");

    const traversal: FabricDefinition = {
      ...pbirDefinition(),
      parts: [
        ...pbirDefinition().parts,
        jsonPart("../secret.json", {}),
      ],
    };
    expect(() =>
      hashReportDefinition(traversal, false, false),
    ).toThrow("Unsupported Report definition path");

    const byPath = pbirDefinition();
    byPath.parts[0] = jsonPart("definition.pbir", {
      $schema: PBIR_SCHEMA,
      version: "4.0",
      datasetReference: { byPath: { path: "../Model" } },
    });
    expect(() =>
      hashReportDefinition(byPath, false, false),
    ).toThrow("byPath is not supported");

    const sensitivity = pbirDefinition();
    sensitivity.parts.push(
      jsonPart(".platform", {
        metadata: { type: "Report" },
        sensitivityLabelSettings: { labelId: "label" },
      }),
    );
    expect(() =>
      hashReportDefinition(sensitivity, true, false),
    ).toThrow("sensitivity label");

    const malformed = pbirDefinition();
    malformed.parts[1] = {
      path: "definition/report.json",
      payload: Buffer.from("{").toString("base64"),
      payloadType: "InlineBase64",
    };
    expect(() =>
      hashReportDefinition(malformed, false, false),
    ).toThrow("valid UTF-8 JSON");

    const unsupportedPayload = pbirDefinition();
    unsupportedPayload.parts[0] = {
      ...unsupportedPayload.parts[0]!,
      payloadType: "External",
    } as never;
    expect(() =>
      hashReportDefinition(
        unsupportedPayload,
        false,
        false,
      ),
    ).toThrow("Unsupported Fabric definition payload type");
  });
});
