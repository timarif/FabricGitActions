import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

function createDeployment(
  type:
    | "Lakehouse"
    | "Environment"
    | "Notebook"
    | "SparkJobDefinition"
    | "DataPipeline",
  itemYaml: string,
): { root: string; manifestPath: string; itemDirectory: string } {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-item-"));
  const itemDirectory = path.join(root, "items/item");
  mkdirSync(itemDirectory, { recursive: true });
  writeFileSync(path.join(itemDirectory, "item.yaml"), itemYaml, "utf8");
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
  - logicalId: target
    type: ${type}
    path: items/item
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

  it("requires a non-empty Environment definition directory", () => {
    const fixture = createDeployment("Environment", "displayName: Spark\n");

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "requires a definition directory",
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

  it("requires a Spark job main.py or main.scala entry point", () => {
    const fixture = createDeployment(
      "SparkJobDefinition",
      "displayName: Spark Job\n",
    );
    mkdirSync(path.join(fixture.itemDirectory, "definition"));

    expect(() => loadManifest(fixture.manifestPath)).toThrow(
      "requires exactly one definition/main.py or definition/main.scala",
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
      "requires exactly one definition/main.py or definition/main.scala",
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
});
