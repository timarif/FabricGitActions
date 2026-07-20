import { describe, expect, it, vi } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { reportBindingConnectionString } from "../src/fabric/report-definition";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

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

const reportDefinition: FabricDefinition = {
  format: "PBIR",
  parts: [
    jsonPart("definition.pbir", {
      $schema:
        "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
      version: "4.0",
      datasetReference: {
        byConnection: {
          connectionString: "semanticmodelid=source",
        },
      },
    }),
    jsonPart("definition/report.json", {}),
    jsonPart("definition/version.json", {}),
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: {
    model: "model-content",
    report: "report-content",
  },
  itemDirectories: {
    model: "items/model",
    report: "items/report",
  },
  itemDefinitions: {
    model: { displayName: "Sales Model" },
    report: {
      displayName: "Sales Report",
      references: { semanticModel: "model" },
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {
    model: {
      format: "TMSL",
      parts: [
        jsonPart("model.bim", {}),
        jsonPart("definition.pbism", {}),
      ],
    },
  },
  reportDefinitions: { report: reportDefinition },
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "report-plan" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "model",
        type: "SemanticModel",
        path: "items/model",
      },
      {
        logicalId: "report",
        type: "Report",
        path: "items/report",
        dependsOn: ["model"],
      },
    ],
  },
};

function baseAdapters(
  semanticPlan: () => Promise<{
    action: "create" | "no-op";
    reason: string;
    observedStateHash: string;
    physicalId?: string;
  }>,
  report: {
    plan: ReturnType<typeof vi.fn>;
    planUnresolvedReferences: ReturnType<typeof vi.fn>;
  },
) {
  const unused = {
    plan: vi.fn(async () => {
      throw new Error("Unexpected adapter call.");
    }),
  };
  return {
    lakehouse: unused,
    environment: unused,
    notebook: unused,
    sparkJob: unused,
    pipeline: unused,
    semanticModel: { plan: vi.fn(semanticPlan) },
    report,
    sparkCustomPool: unused,
  };
}

describe("Report live planning", () => {
  it("keeps a new Report symbolic while its Semantic Model is created in the same plan", async () => {
    const report = {
      plan: vi.fn(),
      planUnresolvedReferences: vi.fn(async () => ({
        action: "create" as const,
        reason: "wait",
        observedStateHash: "absent",
      })),
    };
    const enriched = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      baseAdapters(
        async () => ({
          action: "create",
          reason: "create",
          observedStateHash: "absent",
        }),
        report,
      ),
    );

    const plannedReport = enriched.items.find(
      (item) => item.logicalId === "report",
    );
    expect(plannedReport).toMatchObject({ action: "create" });
    expect(plannedReport).not.toHaveProperty(
      "materializedDefinitionHash",
    );
    expect(plannedReport).not.toHaveProperty(
      "resolvedBindingsHash",
    );
    expect(report.plan).not.toHaveBeenCalled();
    expect(report.planUnresolvedReferences).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.report,
      reportDefinition,
      ["model"],
    );
  });

  it("materializes and proves the binding when the Semantic Model ID is available", async () => {
    const report = {
      plan: vi.fn(
        async (
          _workspace: string,
          _desired: unknown,
          definition: FabricDefinition,
        ) => {
          expect(reportBindingConnectionString(definition)).toBe(
            "semanticmodelid=model-physical",
          );
          return {
            action: "no-op" as const,
            reason: "matches",
            observedStateHash: "report-observed",
            physicalId: "report-physical",
          };
        },
      ),
      planUnresolvedReferences: vi.fn(),
    };
    const enriched = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      baseAdapters(
        async () => ({
          action: "no-op",
          reason: "matches",
          observedStateHash: "model-observed",
          physicalId: "model-physical",
        }),
        report,
      ),
    );
    const plannedReport = enriched.items.find(
      (item) => item.logicalId === "report",
    );

    expect(plannedReport).toMatchObject({
      action: "no-op",
      physicalId: "report-physical",
    });
    expect(plannedReport?.materializedDefinitionHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(plannedReport?.resolvedBindingsHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("blocks an existing Report until a newly created Semantic Model ID is reviewable", async () => {
    const report = {
      plan: vi.fn(),
      planUnresolvedReferences: vi.fn(async () => ({
        action: "blocked" as const,
        reason: "existing report requires replan",
        observedStateHash: "metadata-only",
        physicalId: "report-existing",
      })),
    };
    const enriched = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      baseAdapters(
        async () => ({
          action: "create",
          reason: "create",
          observedStateHash: "absent",
        }),
        report,
      ),
    );

    expect(
      enriched.items.find((item) => item.logicalId === "report"),
    ).toMatchObject({
      action: "blocked",
      physicalId: "report-existing",
    });
  });
});
