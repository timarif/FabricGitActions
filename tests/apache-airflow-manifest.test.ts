import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { APACHE_AIRFLOW_DEFINITION_PATH } from "../src/fabric/apache-airflow-definition";
import { loadManifest } from "../src/manifest";
import { buildPlan } from "../src/planner";

function fixture(platformDisplayName = "HelloAirflow"): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-airflow-manifest-"),
  );
  const itemDirectory = path.join(root, "items", "airflow");
  mkdirSync(path.join(itemDirectory, "definition", "dags"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "deployment.yaml"),
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: airflow-test
workspace:
  id: workspace-1
items:
  - logicalId: airflow
    type: ApacheAirflowJob
    path: items/airflow
`,
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "item.yaml"),
    `
displayName: HelloAirflow
description: Managed Airflow job.
`,
    "utf8",
  );
  writeFileSync(
    path.join(
      itemDirectory,
      "definition",
      APACHE_AIRFLOW_DEFINITION_PATH,
    ),
    JSON.stringify({
      properties: {
        type: "Airflow",
        typeProperties: {
          airflowProperties: {
            airflowVersion: "2.10.5",
            pythonVersion: "3.12",
            airflowRequirements: [],
          },
          computeProperties: {
            computePool: "StarterPool",
            computeSize: "Small",
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", ".platform"),
    JSON.stringify({
      metadata: {
        type: "ApacheAirflowJob",
        displayName: platformDisplayName,
        description: "Managed Airflow job.",
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", "dags", "hello.py"),
    "print('hello')\n",
    "utf8",
  );
  return path.join(root, "deployment.yaml");
}

describe("Apache Airflow manifest integration", () => {
  it("loads a public definition and captured DAG bundle", () => {
    const loaded = loadManifest(fixture());
    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const airflowBundle =
      loaded.apacheAirflowBundles?.airflow;

    expect(airflowBundle).toBeDefined();
    expect(airflowBundle!.definition.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: APACHE_AIRFLOW_DEFINITION_PATH,
        }),
      ]),
    );
    expect(airflowBundle!.files).toEqual([
      expect.objectContaining({ filePath: "dags/hello.py" }),
    ]);
    expect(plan.items[0]).toMatchObject({
      type: "ApacheAirflowJob",
      action: "unknown",
    });
  });

  it("rejects mismatched platform metadata", () => {
    expect(() => loadManifest(fixture("DifferentAirflow"))).toThrow(
      ".platform displayName must match item.yaml",
    );
  });

  it("allows guarded deletion without a definition directory", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-airflow-delete-"),
    );
    const itemDirectory = path.join(root, "items", "airflow");
    mkdirSync(itemDirectory, { recursive: true });
    writeFileSync(
      path.join(root, "deployment.yaml"),
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: airflow-delete
workspace:
  id: workspace-1
items:
  - logicalId: airflow
    type: ApacheAirflowJob
    path: items/airflow
    desiredState: absent
`,
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      `
displayName: HelloAirflow
desiredState: absent
`,
      "utf8",
    );

    expect(
      loadManifest(path.join(root, "deployment.yaml")).manifest
        .items[0],
    ).toMatchObject({
      type: "ApacheAirflowJob",
      desiredState: "absent",
    });
  });
});
