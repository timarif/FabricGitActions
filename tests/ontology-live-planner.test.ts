import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

describe("Ontology live planning", () => {
  it("dispatches Ontology discovery with the captured definition", async () => {
    const definition = {
      format: "Default",
      parts: [
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              metadata: {
                type: "Ontology",
                displayName: "AssetOntology",
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64" as const,
        },
        {
          path: "definition.json",
          payload: Buffer.from("{}").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { ontology: "content" },
      itemDirectories: { ontology: "items/ontology" },
      itemDefinitions: {
        ontology: {
          displayName: "AssetOntology",
        },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {},
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      ontologyDefinitions: { ontology: definition },
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "ontology-plan" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "ontology",
            type: "Ontology",
            path: "items/ontology",
          },
        ],
      },
    };
    const fail = vi.fn(async () => {
      throw new Error("Unrelated adapter should not be called.");
    });
    const ontology = vi.fn(async () => ({
      action: "create" as const,
      reason: "Ontology does not exist.",
      observedStateHash: "a".repeat(64),
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
        ontology: { plan: ontology },
        sparkJob: { plan: fail },
        pipeline: { plan: fail },
        semanticModel: { plan: fail },
        sparkCustomPool: { plan: fail },
      },
    );

    expect(ontology).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.ontology,
      definition,
    );
    expect(fail).not.toHaveBeenCalled();
    expect(online.items[0]).toMatchObject({
      type: "Ontology",
      action: "create",
      observedStateHash: "a".repeat(64),
    });
  });
});
