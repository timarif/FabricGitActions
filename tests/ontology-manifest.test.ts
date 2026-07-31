import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";
import { buildPlan } from "../src/planner";

function fixture(
  itemYaml = `
displayName: AssetOntology
description: Managed ontology.
`,
  platformDisplayName = "AssetOntology",
): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-ontology-manifest-"),
  );
  const itemDirectory = path.join(root, "items", "ontology");
  mkdirSync(path.join(itemDirectory, "definition"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "deployment.yaml"),
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: ontology-test
workspace:
  id: workspace-1
items:
  - logicalId: ontology
    type: Ontology
    path: items/ontology
`,
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "item.yaml"),
    itemYaml,
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", "definition.json"),
    "{}",
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", ".platform"),
    JSON.stringify({
      metadata: {
        type: "Ontology",
        displayName: platformDisplayName,
        description: "Managed ontology.",
      },
    }),
    "utf8",
  );
  return path.join(root, "deployment.yaml");
}

describe("Ontology manifest integration", () => {
  it("loads a definition snapshot and builds an offline plan", () => {
    const loaded = loadManifest(fixture());
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    expect(loaded.ontologyDefinitions?.ontology).toMatchObject({
      parts: expect.arrayContaining([
        expect.objectContaining({ path: "definition.json" }),
        expect.objectContaining({ path: ".platform" }),
      ]),
    });
    expect(
      loaded.ontologyDefinitions?.ontology?.format,
    ).toBeUndefined();
    expect(plan.items[0]).toMatchObject({
      type: "Ontology",
      action: "unknown",
    });
  });

  it("enforces Ontology naming and preview folder limitations", () => {
    expect(() =>
      loadManifest(
        fixture(`
displayName: Invalid Ontology
description: Managed ontology.
`),
      ),
    ).toThrow("Ontology displayName");

    expect(() =>
      loadManifest(
        fixture(`
displayName: AssetOntology
description: Managed ontology.
folderId: folder-1
`),
      ),
    ).toThrow("folder placement is not supported");
  });

  it("rejects platform metadata that does not match item.yaml", () => {
    expect(() =>
      loadManifest(fixture(undefined, "DifferentOntology")),
    ).toThrow(".platform displayName must match item.yaml");
  });

  it("allows guarded Ontology deletion without a definition directory", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-ontology-delete-"),
    );
    const itemDirectory = path.join(root, "items", "ontology");
    mkdirSync(itemDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "deployment.yaml"),
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: ontology-delete
workspace:
  id: workspace-1
items:
  - logicalId: ontology
    type: Ontology
    path: items/ontology
    desiredState: absent
`,
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      `
displayName: AssetOntology
desiredState: absent
`,
      "utf8",
    );

    expect(
      loadManifest(path.join(root, "deployment.yaml")).manifest
        .items[0],
    ).toMatchObject({
      type: "Ontology",
      desiredState: "absent",
    });
  });
});
