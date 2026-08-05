import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { APACHE_AIRFLOW_DEFINITION_PATH } from "../src/fabric/apache-airflow-definition";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const bundle = {
  definition: {
    parts: [
      {
        path: APACHE_AIRFLOW_DEFINITION_PATH,
        payload: Buffer.from(
          JSON.stringify({
            properties: {
              type: "Airflow",
              typeProperties: {
                airflowProperties: {},
                computeProperties: {},
              },
            },
          }),
        ).toString("base64"),
        payloadType: "InlineBase64" as const,
      },
    ],
  },
  files: [],
};

describe("Apache Airflow live planning", () => {
  it("dispatches the captured bundle and preserves file operations", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { airflow: "content" },
      itemDirectories: { airflow: "items/airflow" },
      itemDefinitions: {
        airflow: {
          displayName: "HelloAirflow",
        },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {},
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      apacheAirflowBundles: { airflow: bundle },
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "airflow-plan" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "airflow",
            type: "ApacheAirflowJob",
            path: "items/airflow",
          },
        ],
      },
    };
    const fail = vi.fn(async () => {
      throw new Error("Unrelated adapter should not be called.");
    });
    const apacheAirflow = vi.fn(async () => ({
      action: "update" as const,
      reason: "DAG differs.",
      physicalId: "airflow-1",
      observedStateHash: "a".repeat(64),
      stagedDefinitionHash: "b".repeat(64),
      managedMetadataMatches: true,
      apacheAirflowFiles: {
        desiredHash: "c".repeat(64),
        observedStateHash: "d".repeat(64),
        ownershipHash: "e".repeat(64),
        operations: [
          {
            filePath: "dags/hello.py",
            action: "update" as const,
            desiredHash: "f".repeat(64),
            observedHash: "1".repeat(64),
            ownedHash: "1".repeat(64),
            sizeBytes: 15,
            reason: "Update DAG.",
          },
        ],
      },
    }));

    const online = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      {
        lakehouse: { plan: fail },
        environment: { plan: fail },
        notebook: { plan: fail },
        apacheAirflow: { plan: apacheAirflow },
        sparkJob: { plan: fail },
        pipeline: { plan: fail },
        semanticModel: { plan: fail },
        sparkCustomPool: { plan: fail },
      },
    );

    expect(apacheAirflow).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.airflow,
      bundle,
    );
    expect(online.items[0]).toMatchObject({
      type: "ApacheAirflowJob",
      action: "update",
      apacheAirflowFiles: {
        operations: [
          expect.objectContaining({
            filePath: "dags/hello.py",
            action: "update",
          }),
        ],
      },
    });
  });
});
