import { describe, expect, it, vi } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import { rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

describe("online Fabric planning", () => {
  it("plans supported absent items through exact deletion discovery", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { oldNotebook: "content" },
      itemDirectories: {
        oldNotebook: "items/notebooks/old",
      },
      itemDefinitions: {
        oldNotebook: {
          displayName: "Old Notebook",
          desiredState: "absent",
        },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {},
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "delete-notebook" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "oldNotebook",
            type: "Notebook",
            path: "items/notebooks/old",
            desiredState: "absent",
          },
        ],
      },
    };
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const fail = vi.fn(async () => {
      throw new Error("Present-state adapter should not be called.");
    });
    const deletion = vi.fn(async () => ({
      action: "delete" as const,
      reason: "approved soft deletion",
      physicalId: "notebook-1",
      observedStateHash: "a".repeat(64),
    }));

    const online = await enrichPlanWithFabric(offline, loaded, {
      deletion: { plan: deletion },
      lakehouse: { plan: fail },
      environment: { plan: fail },
      notebook: { plan: fail },
      sparkJob: { plan: fail },
      pipeline: { plan: fail },
      semanticModel: { plan: fail },
      sparkCustomPool: { plan: fail },
    });

    expect(deletion).toHaveBeenCalledWith(
      "workspace",
      "Notebook",
      loaded.itemDefinitions.oldNotebook,
    );
    expect(fail).not.toHaveBeenCalled();
    expect(online.items[0]).toMatchObject({
      desiredState: "absent",
      action: "delete",
      physicalId: "notebook-1",
      observedStateHash: "a".repeat(64),
    });
  });

  it("plans workspace creation before blocking child item planning", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: { lakehouse: "content" },
      itemDirectories: { lakehouse: "items/lakehouse" },
      itemDefinitions: {
        lakehouse: { displayName: "Bronze" },
      },
      environmentDefinitions: {},
      notebookDefinitions: {},
      sparkJobDefinitions: {},
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "managed-workspace" },
        workspace: {
          displayName: "tva-Analytics",
          capacityId: "capacity-1",
        },
        items: [
          {
            logicalId: "lakehouse",
            type: "Lakehouse",
            path: "items/lakehouse",
          },
        ],
      },
    };
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const fail = async () => {
      throw new Error("Item adapter should not be called.");
    };

    const online = await enrichPlanWithFabric(offline, loaded, {
      workspace: {
        plan: async () => ({
          action: "create" as const,
          reason: "missing",
          observedStateHash: "absent",
          managedMetadataMatches: false,
          capacityAssignmentRequired: true,
        }),
      },
      lakehouse: { plan: fail },
      environment: { plan: fail },
      notebook: { plan: fail },
      sparkJob: { plan: fail },
      pipeline: { plan: fail },
      semanticModel: { plan: fail },
      sparkCustomPool: { plan: fail },
    });

    expect(online.workspace).toMatchObject({
      action: "create",
      capacityAssignmentRequired: true,
    });
    expect(online.workspaceId).toMatch(/^pending:/);
    expect(online.items[0]?.action).toBe("blocked");
    expect(online.items[0]?.reason).toContain(
      "separate apply",
    );
  });

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
      semanticModelDefinitions: {},
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
      semanticModel: { plan: async () => {
        throw new Error("Semantic Model adapter should not be called.");
      } },
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

  it("materializes Spark Job logical bindings from planned dependency IDs", async () => {
    const sparkLoaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: {
        bronze: "lakehouse-content",
        sparkJob: "content",
      },
      itemDirectories: {
        bronze: "items/bronze",
        sparkJob: "items/spark-job",
      },
      itemDefinitions: {
        bronze: { displayName: "Bronze" },
        sparkJob: {
          displayName: "Spark",
          bindings: [
            {
              target: "/properties/defaultLakehouseArtifactId",
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
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "bronze",
            type: "Lakehouse",
            path: "items/bronze",
          },
          {
            logicalId: "sparkJob",
            type: "SparkJobDefinition",
            path: "items/spark-job",
            dependsOn: ["bronze"],
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
    let plannedDefinition:
      | LoadedManifest["sparkJobDefinitions"][string]
      | undefined;

    const online = await enrichPlanWithFabric(
      offline,
      sparkLoaded,
      {
        lakehouse: {
          plan: async () => ({
            action: "no-op" as const,
            reason: "exists",
            physicalId: "lakehouse-physical-id",
            observedStateHash: "lakehouse-state",
          }),
        },
        environment: { plan: fail },
        notebook: { plan: fail },
        sparkJob: {
          plan: async (
            _workspace,
            _desired,
            definition,
          ) => {
            plannedDefinition = definition;
            return {
              action: "no-op" as const,
              reason: "matches",
              physicalId: "spark-job-id",
              observedStateHash: "spark-state",
            };
          },
        },
        pipeline: { plan: fail },
        semanticModel: { plan: fail },
        sparkCustomPool: { plan: fail },
      },
    );

    const configPart = plannedDefinition?.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    expect(
      JSON.parse(
        Buffer.from(
          configPart?.payload ?? "",
          "base64",
        ).toString("utf8"),
      ).defaultLakehouseArtifactId,
    ).toBe("lakehouse-physical-id");
    expect(online.items[1]).toMatchObject({
      action: "no-op",
      materializedDefinitionHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
      resolvedBindingsHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
    });
  });

  it("plans and materializes content-addressed Spark Job JAR staging", async () => {
    const workspaceId = "11111111-1111-1111-1111-111111111111";
    const lakehouseId = "22222222-2222-2222-2222-222222222222";
    const contentHash = "a".repeat(64);
    const sparkLoaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: {
        bronze: "lakehouse-content",
        sparkJob: "content",
      },
      itemDirectories: {
        bronze: "items/bronze",
        sparkJob: "items/spark-job",
      },
      itemDefinitions: {
        bronze: { displayName: "Bronze" },
        sparkJob: {
          displayName: "Spark",
          references: { defaultLakehouse: "bronze" },
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
              payload: Buffer.from(
                JSON.stringify({
                  executableFile: "main.jar",
                  additionalLibraryUris: [],
                  language: "Scala/Java",
                  mainClass: "com.example.Main",
                }),
              ).toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      sparkJobArtifactSources: {
        sparkJob: [
          {
            kind: "executable",
            fileName: "main.jar",
            relativePath: "definition/main.jar",
            sourcePath: "C:\\repo\\definition\\main.jar",
            contentHash,
            sizeBytes: 42,
          },
        ],
      },
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: workspaceId },
        items: [
          {
            logicalId: "bronze",
            type: "Lakehouse",
            path: "items/bronze",
          },
          {
            logicalId: "sparkJob",
            type: "SparkJobDefinition",
            path: "items/spark-job",
            dependsOn: ["bronze"],
          },
        ],
      },
    };
    const offline = buildPlan(sparkLoaded, {
      mode: "plan",
      environment: "prod",
    });
    const fail = async () => {
      throw new Error("Adapter should not be called.");
    };
    let plannedDefinition:
      | LoadedManifest["sparkJobDefinitions"][string]
      | undefined;

    const online = await enrichPlanWithFabric(offline, sparkLoaded, {
      lakehouse: {
        plan: async () => ({
          action: "no-op" as const,
          reason: "exists",
          physicalId: lakehouseId,
          observedStateHash: "lakehouse-state",
        }),
      },
      environment: { plan: fail },
      notebook: { plan: fail },
      sparkJob: {
        plan: async (_workspace, _desired, definition) => {
          plannedDefinition = definition;
          return {
            action: "create" as const,
            reason: "absent",
            observedStateHash: "absent",
          };
        },
      },
      pipeline: { plan: fail },
      semanticModel: { plan: fail },
      sparkCustomPool: { plan: fail },
      oneLakeArtifacts: {
        dfsEndpoint: "https://onelake.dfs.fabric.microsoft.com",
        blobEndpoint:
          "https://onelake.blob.fabric.microsoft.com",
        stager: {
          inspect: vi.fn(async () => ({
            exists: false,
            matches: false,
            observedHash: "",
          })),
        },
      },
    });

    expect(online.items[1]?.sparkJobArtifacts).toMatchObject({
      targetLakehouseLogicalId: "bronze",
      targetLakehousePhysicalId: lakehouseId,
      targetBinding: "physical",
      oneLakeDfsEndpoint:
        "https://onelake.dfs.fabric.microsoft.com",
      oneLakeBlobEndpoint:
        "https://onelake.blob.fabric.microsoft.com",
      artifacts: [
        {
          action: "create",
          kind: "executable",
          fileName: "main.jar",
          contentHash,
        },
      ],
    });
    const configPart = plannedDefinition?.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    expect(
      JSON.parse(
        Buffer.from(
          configPart?.payload ?? "",
          "base64",
        ).toString("utf8"),
      ).executableFile,
    ).toBe(
      `abfss://${workspaceId}@onelake.dfs.fabric.microsoft.com/${lakehouseId}/Files/.fabric-deploy/sample/prod/sparkJob/${contentHash}/main.jar`,
    );
  });

  it("approves only creation when referenced dependencies are also new", async () => {
    const workspaceId = "11111111-1111-1111-1111-111111111111";
    const base: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: {
        bronze: "lakehouse-content",
        sparkJob: "spark-content",
      },
      itemDirectories: {
        bronze: "items/bronze",
        sparkJob: "items/spark-job",
      },
      itemDefinitions: {
        bronze: { displayName: "Bronze" },
        sparkJob: {
          displayName: "Spark",
          references: { defaultLakehouse: "bronze" },
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
              payload: Buffer.from(
                JSON.stringify({
                  executableFile: "main.jar",
                  additionalLibraryUris: [],
                  language: "Scala/Java",
                  mainClass: "com.example.Main",
                }),
              ).toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      sparkJobArtifactSources: {
        sparkJob: [
          {
            kind: "executable",
            fileName: "main.jar",
            relativePath: "definition/main.jar",
            sourcePath: "C:\\repo\\definition\\main.jar",
            contentHash: "a".repeat(64),
            sizeBytes: 42,
          },
        ],
      },
      pipelineDefinitions: {},
      semanticModelDefinitions: {},
      sparkCustomPoolDefinitions: {},
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: workspaceId },
        items: [
          {
            logicalId: "bronze",
            type: "Lakehouse",
            path: "items/bronze",
          },
          {
            logicalId: "sparkJob",
            type: "SparkJobDefinition",
            path: "items/spark-job",
            dependsOn: ["bronze"],
          },
        ],
      },
    };
    const unresolvedPlan = vi.fn(async () => ({
      action: "create" as const,
      reason: "absent",
      observedStateHash: "absent",
    }));
    const fail = async () => {
      throw new Error("Resolved Spark planning should not run.");
    };

    const online = await enrichPlanWithFabric(
      buildPlan(base, {
        mode: "plan",
        environment: "dev",
      }),
      base,
      {
        lakehouse: {
          plan: async () => ({
            action: "create" as const,
            reason: "missing",
            observedStateHash: "absent",
          }),
        },
        environment: { plan: fail },
        notebook: { plan: fail },
        sparkJob: {
          plan: fail,
          planUnresolvedReferences: unresolvedPlan,
        },
        pipeline: { plan: fail },
        semanticModel: { plan: fail },
        sparkCustomPool: { plan: fail },
      },
    );

    expect(unresolvedPlan).toHaveBeenCalledWith(
      workspaceId,
      base.itemDefinitions.sparkJob,
      ["bronze"],
    );
    expect(online.items[1]).toMatchObject({
      action: "create",
      sparkJobArtifacts: {
        targetLakehouseLogicalId: "bronze",
        targetBinding: "symbolic",
        artifacts: [
          {
            action: "create",
            kind: "executable",
            fileName: "main.jar",
          },
        ],
      },
    });
    expect(online.items[1]?.materializedDefinitionHash).toBeUndefined();
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
      semanticModelDefinitions: {},
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

    await expect(
      enrichPlanWithFabric(offline, loaded, {
        lakehouse: { plan: fail },
        environment: { plan: fail },
        notebook: { plan: fail },
        sparkJob: { plan: fail },
        pipeline: { plan: fail },
        semanticModel: { plan: fail },
        sparkCustomPool: { plan: fail },
      }),
    ).rejects.toThrow(
      "does not support logical references or bindings",
    );
  });
});
