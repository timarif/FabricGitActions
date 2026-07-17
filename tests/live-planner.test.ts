import { describe, expect, it } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import { rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

describe("online Fabric planning", () => {
  it("classifies Fabric workloads and Spark custom pools online", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: {
        lakehouse: "lakehouse-content",
        environment: "environment-content",
        notebook: "notebook-content",
        pool: "pool-content",
      },
      itemDirectories: {
        lakehouse: "items/lakehouse",
        environment: "items/environment",
        notebook: "items/notebook",
        pool: "items/pool",
      },
      itemDefinitions: {
        lakehouse: { displayName: "Bronze" },
        environment: { displayName: "Spark" },
        notebook: { displayName: "Notebook" },
        pool: { displayName: "Batch Small" },
      },
      environmentDefinitions: {
        environment: {
          parts: [
            {
              path: "Libraries/PublicLibraries/environment.yml",
              payload: Buffer.from("dependencies: []\n").toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      notebookDefinitions: {
        notebook: {
          format: "fabricGitSource",
          parts: [
            {
              path: "notebook-content.py",
              payload: Buffer.from("print('hello')\n").toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      sparkJobDefinitions: {},
      pipelineDefinitions: {},
      sparkCustomPoolDefinitions: {
        pool: {
          nodeFamily: "MemoryOptimized",
          nodeSize: "Small",
          autoScale: {
            enabled: true,
            minNodeCount: 1,
            maxNodeCount: 2,
          },
          dynamicExecutorAllocation: {
            enabled: true,
            minExecutors: 1,
            maxExecutors: 1,
          },
        },
      },
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "lakehouse",
            type: "Lakehouse",
            path: "items/lakehouse",
          },
          {
            logicalId: "environment",
            type: "Environment",
            path: "items/environment",
          },
          {
            logicalId: "notebook",
            type: "Notebook",
            path: "items/notebook",
            dependsOn: ["lakehouse"],
          },
          {
            logicalId: "pool",
            type: "SparkCustomPool",
            path: "items/pool",
          },
        ],
      },
    };
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const adapter = {
      plan: async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      }),
    };
    const environmentAdapter = {
      plan: async () => ({
        action: "no-op" as const,
        reason: "published",
        physicalId: "environment-1",
        observedStateHash: "environment-state",
      }),
    };
    const notebookAdapter = {
      plan: async () => ({
        action: "update" as const,
        reason: "definition differs",
        physicalId: "notebook-1",
        observedStateHash: "notebook-state",
      }),
    };
    const sparkJobAdapter = {
      plan: async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      }),
    };
    const pipelineAdapter = {
      plan: async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      }),
    };
    const sparkCustomPoolAdapter = {
      plan: async () => ({
        action: "no-op" as const,
        reason: "pool matches",
        physicalId: "pool-1",
        observedStateHash: "pool-state",
      }),
    };

    const online = await enrichPlanWithFabric(offline, loaded, {
      lakehouse: adapter,
      environment: environmentAdapter,
      notebook: notebookAdapter,
      sparkJob: sparkJobAdapter,
      pipeline: pipelineAdapter,
      sparkCustomPool: sparkCustomPoolAdapter,
    });

    expect(online.items[0]?.action).toBe("create");
    expect(online.items[0]?.observedStateHash).toBe("absent");
    expect(online.items[1]?.action).toBe("no-op");
    expect(online.items[1]?.physicalId).toBe("environment-1");
    expect(online.items[2]?.action).toBe("update");
    expect(online.items[2]?.physicalId).toBe("notebook-1");
    expect(online.items[3]?.action).toBe("no-op");
    expect(online.items[3]?.physicalId).toBe("pool-1");
    expect(online.planHash).not.toBe(offline.planHash);

    const savedPlan = JSON.parse(JSON.stringify(online));
    expect(rehashPlan(savedPlan).planHash).toBe(online.planHash);
  });

  it("blocks Spark Job logical bindings until resolution is implemented", async () => {
    const sparkLoaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { sparkJob: "content" },
      itemDirectories: { sparkJob: "items/spark-job" },
      itemDefinitions: {
        sparkJob: {
          displayName: "Spark",
          bindings: [
            {
              target: "properties.defaultLakehouseArtifactId",
              valueFrom: "items.bronze.id",
            },
          ],
        },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {
        sparkJob: {
          format: "SparkJobDefinitionV2",
          parts: [
            {
              path: "SparkJobDefinitionV1.json",
              payload: Buffer.from("{}").toString("base64"),
              payloadType: "InlineBase64",
            },
            {
              path: "Main/main.py",
              payload: Buffer.from("print('hello')\n").toString(
                "base64",
              ),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      pipelineDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "sparkJob",
            type: "SparkJobDefinition",
            path: "items/spark-job",
          },
        ],
      },
    };
    const offline = buildPlan(sparkLoaded, {
      mode: "plan",
      environment: "dev",
    });
    const fail = async () => {
      throw new Error("Adapter should not be called.");
    };

    const online = await enrichPlanWithFabric(
      offline,
      sparkLoaded,
      {
        lakehouse: { plan: fail },
        environment: { plan: fail },
        notebook: { plan: fail },
        sparkJob: { plan: fail },
        pipeline: { plan: fail },
        sparkCustomPool: { plan: fail },
      },
    );

    expect(online.items[0]?.action).toBe("blocked");
    expect(online.items[0]?.reason).toContain(
      "references and bindings require",
    );
  });

  it("blocks unsupported Data Pipeline bindings instead of ignoring them", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { pipeline: "content" },
      itemDirectories: { pipeline: "items/pipeline" },
      itemDefinitions: {
        pipeline: {
          displayName: "Pipeline",
          bindings: [
            {
              target: "/activities/0/typeProperties/notebookId",
              valueFrom: "item.notebook.id",
            },
          ],
        },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {},
      pipelineDefinitions: {
        pipeline: {
          parts: [
            {
              path: "pipeline-content.json",
              payload: Buffer.from("{}").toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "pipeline",
            type: "DataPipeline",
            path: "items/pipeline",
          },
        ],
      },
    };
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const fail = async () => {
      throw new Error("Adapter should not be called.");
    };

    const online = await enrichPlanWithFabric(offline, loaded, {
      lakehouse: { plan: fail },
      environment: { plan: fail },
      notebook: { plan: fail },
      sparkJob: { plan: fail },
      pipeline: { plan: fail },
      sparkCustomPool: { plan: fail },
    });

    expect(online.items[0]?.action).toBe("blocked");
    expect(online.items[0]?.reason).toContain("cannot be ignored");
  });
});
