import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const definition = {
  format: "TMSL",
  parts: [
    {
      path: "model.bim",
      payload: Buffer.from(
        JSON.stringify({
          compatibilityLevel: 1702,
          model: { culture: "en-US", tables: [] },
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
    {
      path: "definition.pbism",
      payload: Buffer.from(
        JSON.stringify({ version: "5.0", settings: {} }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { sales: "content" },
  itemDirectories: { sales: "items/semantic-models/sales" },
  itemDefinitions: {
    sales: { displayName: "Sales", description: "Managed" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: { sales: definition },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "semantic-model" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "sales",
        type: "SemanticModel",
        path: "items/semantic-models/sales",
      },
    ],
  },
};

describe("Semantic Model live planning", () => {
  it("uses the authenticated Semantic Model adapter and captured definition", async () => {
    const fail = vi.fn(async () => {
      throw new Error("Unexpected adapter call.");
    });
    const semanticModelPlan = vi.fn(async () => ({
      action: "update" as const,
      reason: "definition differs",
      physicalId: "model-1",
      observedStateHash: "observed",
    }));
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });

    const online = await enrichPlanWithFabric(
      offline,
      loaded,
      {
        lakehouse: { plan: fail },
        environment: { plan: fail },
        notebook: { plan: fail },
        sparkJob: { plan: fail },
        pipeline: { plan: fail },
        semanticModel: { plan: semanticModelPlan },
        sparkCustomPool: { plan: fail },
      },
    );

    expect(semanticModelPlan).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.sales,
      definition,
    );
    expect(online.items[0]).toMatchObject({
      type: "SemanticModel",
      action: "update",
      physicalId: "model-1",
      observedStateHash: "observed",
    });
  });
});
