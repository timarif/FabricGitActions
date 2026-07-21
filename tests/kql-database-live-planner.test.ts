import {
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type { KqlDatabaseAdapter } from "../src/fabric/kql-database";
import {
  enrichPlanWithFabric,
  type FabricPlanAdapters,
} from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: {
    eventhouse: "eventhouse-content",
    database: "database-content",
  },
  itemDirectories: {
    eventhouse: "items/eventhouse",
    database: "items/database",
  },
  itemDefinitions: {
    eventhouse: {
      displayName: "TelemetryEventhouse",
      minimumConsumptionUnits: 2.25,
    },
    database: {
      displayName: "TelemetryDB",
      databaseType: "ReadWrite",
      references: { eventhouse: "eventhouse" },
    },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  reportDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "kql-plan" },
    workspace: { id: "workspace" },
    items: [
      {
        logicalId: "database",
        type: "KQLDatabase",
        path: "items/database",
        dependsOn: ["eventhouse"],
      },
      {
        logicalId: "eventhouse",
        type: "Eventhouse",
        path: "items/eventhouse",
      },
    ],
  },
};

interface KqlMocks {
  plan: Mock<KqlDatabaseAdapter["plan"]>;
  planUnresolvedParent: Mock<
    KqlDatabaseAdapter["planUnresolvedParent"]
  >;
}

function adapters(
  eventhousePlan: () => Promise<{
    action: "create" | "no-op";
    reason: string;
    observedStateHash: string;
    physicalId?: string;
  }>,
  kqlDatabase: KqlMocks,
): FabricPlanAdapters {
  const unused = {
    plan: vi.fn(async () => {
      throw new Error("Unexpected adapter call.");
    }),
  };
  return {
    lakehouse: unused,
    eventhouse: { plan: vi.fn(eventhousePlan) },
    kqlDatabase,
    environment: unused,
    notebook: unused,
    sparkJob: unused,
    pipeline: unused,
    semanticModel: unused,
    report: unused,
    sparkCustomPool: unused,
  };
}

describe("KQL Database live planning", () => {
  it("keeps a new database symbolic while its Eventhouse is created in the same plan", async () => {
    const kqlDatabase: KqlMocks = {
      plan: vi.fn<KqlDatabaseAdapter["plan"]>(),
      planUnresolvedParent: vi.fn<
        KqlDatabaseAdapter["planUnresolvedParent"]
      >(async () => ({
        action: "create",
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
      adapters(
        async () => ({
          action: "create",
          reason: "create",
          observedStateHash: "absent",
        }),
        kqlDatabase,
      ),
    );

    const planned = enriched.items.find(
      (item) => item.logicalId === "database",
    );
    expect(planned).toMatchObject({ action: "create" });
    expect(planned).not.toHaveProperty(
      "materializedDefinitionHash",
    );
    expect(planned).not.toHaveProperty("resolvedBindingsHash");
    expect(kqlDatabase.plan).not.toHaveBeenCalled();
    expect(kqlDatabase.planUnresolvedParent).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.database,
      ["eventhouse"],
    );
  });

  it("materializes and proves the parent when the Eventhouse ID is available", async () => {
    const kqlDatabase: KqlMocks = {
      plan: vi.fn(
        async (_workspace, _desired, materialized) => {
          expect(materialized.creationPayload).toEqual({
            databaseType: "ReadWrite",
            parentEventhouseItemId: "eventhouse-physical",
          });
          return {
            action: "no-op" as const,
            reason: "matches",
            observedStateHash: "database-observed",
            physicalId: "database-physical",
          };
        },
      ),
      planUnresolvedParent: vi.fn<
        KqlDatabaseAdapter["planUnresolvedParent"]
      >(),
    };

    const enriched = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      adapters(
        async () => ({
          action: "no-op",
          reason: "matches",
          observedStateHash: "eventhouse-observed",
          physicalId: "eventhouse-physical",
        }),
        kqlDatabase,
      ),
    );

    const planned = enriched.items.find(
      (item) => item.logicalId === "database",
    );
    expect(planned).toMatchObject({
      action: "no-op",
      physicalId: "database-physical",
    });
    expect(planned?.materializedDefinitionHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(planned?.resolvedBindingsHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("blocks an existing database until a newly created parent ID is reviewable", async () => {
    const kqlDatabase: KqlMocks = {
      plan: vi.fn<KqlDatabaseAdapter["plan"]>(),
      planUnresolvedParent: vi.fn<
        KqlDatabaseAdapter["planUnresolvedParent"]
      >(async () => ({
        action: "blocked",
        reason: "existing database requires replan",
        observedStateHash: "database-observed",
        physicalId: "database-existing",
      })),
    };

    const enriched = await enrichPlanWithFabric(
      buildPlan(loaded, {
        mode: "plan",
        environment: "dev",
      }),
      loaded,
      adapters(
        async () => ({
          action: "create",
          reason: "create",
          observedStateHash: "absent",
        }),
        kqlDatabase,
      ),
    );

    expect(
      enriched.items.find(
        (item) => item.logicalId === "database",
      ),
    ).toMatchObject({
      action: "blocked",
      physicalId: "database-existing",
    });
  });
});
