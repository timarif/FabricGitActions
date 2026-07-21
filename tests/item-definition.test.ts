import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

function createDeployment(
  type:
    | "Lakehouse"
    | "Eventhouse"
    | "KQLDatabase"
    | "Environment"
    | "Notebook"
    | "SparkJobDefinition"
    | "DataPipeline"
    | "SemanticModel",
  itemYaml: string,
): { root: string; manifestPath: string; itemDirectory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-item-"));
  const itemDirectory = path.join(root, "items/item");
  mkdirSync(itemDirectory, { recursive: true });
  writeFileSync(
    path.join(itemDirectory, "item.yaml"),
    type === "KQLDatabase" &&
    !itemYaml.includes("desiredState: absent")
      ? `${itemYaml.trimEnd()}\nreferences:\n  eventhouse: eventhouse\n`
      : itemYaml,
    "utf8",
  );
  if (type === "KQLDatabase") {
    const eventhouseDirectory = path.join(root, "items/eventhouse");
    mkdirSync(eventhouseDirectory, { recursive: true });
    writeFileSync(
      path.join(eventhouseDirectory, "item.yaml"),
      "displayName: ParentEventhouse\n",
      "utf8",
    );
  }
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(
    manifestPath,
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: item-test
workspace:
  id: workspace-1
items:
${type === "KQLDatabase" ? `  - logicalId: eventhouse
    type: Eventhouse
    path: items/eventhouse
` : ""}  - logicalId: target
    type: ${type}
    path: items/item
${type === "KQLDatabase" ? "    dependsOn: [eventhouse]\n" : ""}
`,
    "utf8",
  );
  return { root, manifestPath, itemDirectory };
}

describe("item definition validation", () => {
  it("loads a Lakehouse item definition", () => {
    const fixture = createDeployment(
      "Lakehouse",
      "displayName: Bronze\ndescription: Raw data\nenableSchemas: true\n",
    );

    const loaded = loadManifest(fixture.manifestPath);

    expect(loaded.itemDefinitions.target).toEqual({
      displayName: "Bronze",
      description: "Raw data",
      enableSchemas: true,
    });
  });

  it("enforces Fabric Lakehouse naming rules", () => {
    const invalid = createDeployment(
      "Lakehouse",
      "displayName: Fabric Deploy Lakehouse\n",
    );

    expect(() => loadManifest(invalid.manifestPath)).toThrow(
      "must begin with a letter, contain only letters, numbers, and underscores",
    );

    const valid = createDeployment(
      "Lakehouse",
      `displayName: ${`a${"b".repeat(122)}`}\n`,
    );
    expect(
      loadManifest(valid.manifestPath).itemDefinitions.target
        ?.displayName,
    ).toHaveLength(123);
  });

  it("loads an Eventhouse item definition", () => {
    const fixture = createDeployment(
      "Eventhouse",
      "displayName: telemetry-prod\ndescription: Real-time telemetry\nminimumConsumptionUnits: 2.25\n",
    );

    expect(
      loadManifest(fixture.manifestPath).itemDefinitions.target,
    ).toEqual({
      displayName: "telemetry-prod",
      description: "Real-time telemetry",
      minimumConsumptionUnits: 2.25,
    });
  });

  it("validates Eventhouse names and minimum consumption units", () => {
    const invalidName = createDeployment(
      "Eventhouse",
      "displayName: Telemetry House\n",
    );
    expect(() => loadManifest(invalidName.manifestPath)).toThrow(
      "can contain only letters, numbers, underscores, periods, and hyphens",
    );

    const invalidMinimum = createDeployment(
      "Eventhouse",
      "displayName: Telemetry\nminimumConsumptionUnits: 50.5\n",
    );
    expect(() => loadManifest(invalidMinimum.manifestPath)).toThrow(
      "minimumConsumptionUnits must be one of",
    );

    const rangedMinimum = createDeployment(
      "Eventhouse",
      "displayName: Telemetry\nminimumConsumptionUnits: 51.5\n",
    );
    expect(
      loadManifest(rangedMinimum.manifestPath).itemDefinitions.target
        ?.minimumConsumptionUnits,
    ).toBe(51.5);
  });

  it("rejects unsupported Eventhouse definitions and deletion", () => {
    const withDefinition = createDeployment(
      "Eventhouse",
      "displayName: Telemetry\n",
    );
    mkdirSync(
      path.join(withDefinition.itemDirectory, "definition"),
    );
    expect(() => loadManifest(withDefinition.manifestPath)).toThrow(
      "does not support a definition directory",
    );

    const absent = createDeployment(
      "Eventhouse",
      "displayName: Telemetry\ndesiredState: absent\n",
    );
    writeFileSync(
      absent.manifestPath,
      readFileSync(absent.manifestPath, "utf8").replace(
        "path: items/item",
        "path: items/item\n    desiredState: absent",
      ),
      "utf8",
    );
    expect(() => loadManifest(absent.manifestPath)).toThrow(
      "does not support desiredState: absent",
    );
  });

  it("loads and validates a ReadWrite KQL Database definition", () => {
    const fixture = createDeployment(
      "KQLDatabase",
      "displayName: telemetry.database\ndescription: Telemetry data\ndatabaseType: ReadWrite\n",
    );

    expect(
      loadManifest(fixture.manifestPath).itemDefinitions.target,
    ).toEqual({
      displayName: "telemetry.database",
      description: "Telemetry data",
      databaseType: "ReadWrite",
      references: { eventhouse: "eventhouse" },
    });

    const invalidName = createDeployment(
      "KQLDatabase",
      "displayName: Telemetry Database\n",
    );
    expect(() => loadManifest(invalidName.manifestPath)).toThrow(
      "can contain only letters, numbers, underscores, periods, and hyphens",
    );
  });

  it("rejects KQL Database definitions, deletion, and properties on other item types", () => {
    const withDefinition = createDeployment(
      "KQLDatabase",
      "displayName: TelemetryDB\n",
    );
    mkdirSync(
      path.join(withDefinition.itemDirectory, "definition"),
    );
    expect(() => loadManifest(withDefinition.manifestPath)).toThrow(
      "does not support a definition directory",
    );

    const absent = createDeployment(
      "KQLDatabase",
      "displayName: TelemetryDB\ndesiredState: absent\n",
    );
    writeFileSync(
      absent.manifestPath,
      readFileSync(absent.manifestPath, "utf8").replace(
        "path: items/item",
        "path: items/item\n    desiredState: absent",
      ),
      "utf8",
    );
    expect(() => loadManifest(absent.manifestPath)).toThrow(
      "does not support desiredState: absent",
    );

    const otherType = createDeployment(
      "Lakehouse",
      "displayName: Bronze\ndatabaseType: ReadWrite\n",
    );
    expect(() => loadManifest(otherType.manifestPath)).toThrow(
      "can use databaseType only when type is KQLDatabase",
    );
  });

  it("requires an Environment definition directory", () => {
    const fixture = createDeployment("Environment", "displayName: Spark\n");

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "requires a definition directory",
    );
  });

  it("requires definition/environment.yml for an Environment", () => {
    const fixture = createDeployment("Environment", "displayName: Spark\n");
    const definition = path.join(fixture.itemDirectory, "definition");
    mkdirSync(definition);
    writeFileSync(path.join(definition, "Sparkcompute.yml"), "runtime_version: 1.3\n");

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "must include definition/environment.yml",
    );
  });

  it("accepts exactly one Python notebook definition", () => {
    const fixture = createDeployment("Notebook", "displayName: Notebook\n");
    const definition = path.join(fixture.itemDirectory, "definition");
    mkdirSync(definition);
    writeFileSync(path.join(definition, "notebook.py"), "print('ok')\n", "utf8");

    expect(loadManifest(fixture.manifestPath).itemDefinitions.target?.displayName).toBe(
      "Notebook",
    );
  });

  it("requires a Spark job main.py or main.jar entry point", () => {
    const fixture = createDeployment(
      "SparkJobDefinition",
      "displayName: Spark Job\n",
    );
    mkdirSync(path.join(fixture.itemDirectory, "definition"));

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "requires exactly one definition/main.py or definition/main.jar",
    );
  });

  it("does not accept a directory named main.py as a Spark entry point", () => {
    const fixture = createDeployment(
      "SparkJobDefinition",
      "displayName: Spark Job\n",
    );
    mkdirSync(
      path.join(fixture.itemDirectory, "definition", "main.py"),
      { recursive: true },
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "requires exactly one definition/main.py or definition/main.jar",
    );
  });

  it("validates pipeline-content.json", () => {
    const fixture = createDeployment("DataPipeline", "displayName: Pipeline\n");
    const definition = path.join(fixture.itemDirectory, "definition");
    mkdirSync(definition);
    writeFileSync(
      path.join(definition, "pipeline-content.json"),
      "not-json",
      "utf8",
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "pipeline definition is not valid JSON",
    );
  });

  it("rejects unknown logical references", () => {
    const fixture = createDeployment(
      "Lakehouse",
      "displayName: Bronze\nreferences:\n  source: missing\n",
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "targets unknown logicalId 'missing'",
    );
  });

  it("requires references to be declared in dependsOn", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-item-"));
    const sourceDirectory = path.join(root, "items/source");
    const targetDirectory = path.join(root, "items/target");
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(
      path.join(sourceDirectory, "item.yaml"),
      "displayName: Source\n",
      "utf8",
    );
    writeFileSync(
      path.join(targetDirectory, "item.yaml"),
      "displayName: Target\nreferences:\n  source: source\n",
      "utf8",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: dependency-test
workspace:
  id: workspace-1
items:
  - logicalId: source
    type: Lakehouse
    path: items/source
  - logicalId: target
    type: Lakehouse
    path: items/target
`,
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "dependsOn does not include it",
    );
  });

  it("accepts supported Spark Job reference and binding declarations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-item-"));
    const lakehouseDirectory = path.join(root, "items/bronze");
    const environmentDirectory = path.join(root, "items/environment");
    const sparkJobDirectory = path.join(root, "items/job");
    mkdirSync(lakehouseDirectory, { recursive: true });
    mkdirSync(path.join(environmentDirectory, "definition"), {
      recursive: true,
    });
    mkdirSync(path.join(sparkJobDirectory, "definition"), {
      recursive: true,
    });
    writeFileSync(
      path.join(lakehouseDirectory, "item.yaml"),
      "displayName: Bronze\n",
      "utf8",
    );
    writeFileSync(
      path.join(environmentDirectory, "item.yaml"),
      "displayName: Spark Environment\n",
      "utf8",
    );
    writeFileSync(
      path.join(
        environmentDirectory,
        "definition",
        "environment.yml",
      ),
      "dependencies: []\n",
      "utf8",
    );
    writeFileSync(
      path.join(sparkJobDirectory, "item.yaml"),
      [
        "displayName: Spark Job",
        "references:",
        "  defaultLakehouse: bronze",
        "bindings:",
        "  - target: /properties/environmentArtifactId",
        "    valueFrom: items.environment.id",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      path.join(sparkJobDirectory, "definition", "main.py"),
      "print('ok')\n",
      "utf8",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: references-test
workspace:
  id: workspace-1
items:
  - logicalId: bronze
    type: Lakehouse
    path: items/bronze
  - logicalId: environment
    type: Environment
    path: items/environment
  - logicalId: job
    type: SparkJobDefinition
    path: items/job
    dependsOn: [bronze, environment]
`,
      "utf8",
    );

    expect(loadManifest(manifestPath).itemDefinitions.job).toMatchObject({
      references: { defaultLakehouse: "bronze" },
      bindings: [
        {
          target: "/properties/environmentArtifactId",
          valueFrom: "items.environment.id",
        },
      ],
    });
  });

  it("rejects logical declarations on unsupported workloads during manifest loading", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-item-"));
    const lakehouseDirectory = path.join(root, "items/bronze");
    const notebookDirectory = path.join(root, "items/notebook");
    mkdirSync(lakehouseDirectory, { recursive: true });
    mkdirSync(path.join(notebookDirectory, "definition"), {
      recursive: true,
    });
    writeFileSync(
      path.join(lakehouseDirectory, "item.yaml"),
      "displayName: Bronze\n",
      "utf8",
    );
    writeFileSync(
      path.join(notebookDirectory, "item.yaml"),
      "displayName: Notebook\nreferences:\n  defaultLakehouse: bronze\n",
      "utf8",
    );
    writeFileSync(
      path.join(notebookDirectory, "definition", "notebook.py"),
      "print('ok')\n",
      "utf8",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: unsupported-reference-test
workspace:
  id: workspace-1
items:
  - logicalId: bronze
    type: Lakehouse
    path: items/bronze
  - logicalId: notebook
    type: Notebook
    path: items/notebook
    dependsOn: [bronze]
`,
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "does not support logical references or bindings",
    );
  });

  it("restricts enableSchemas to Lakehouse items", () => {
    const fixture = createDeployment(
      "Notebook",
      "displayName: Notebook\nenableSchemas: true\n",
    );
    const definition = path.join(fixture.itemDirectory, "definition");
    mkdirSync(definition);
    writeFileSync(path.join(definition, "notebook.py"), "print('ok')\n", "utf8");

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "can use enableSchemas only when type is Lakehouse",
    );
  });

  it("restricts minimumConsumptionUnits to Eventhouse items", () => {
    const fixture = createDeployment(
      "Lakehouse",
      "displayName: Bronze\nminimumConsumptionUnits: 2.25\n",
    );

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "can use minimumConsumptionUnits only when type is Eventhouse",
    );
  });
});
