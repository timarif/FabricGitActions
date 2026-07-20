import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import { hashSparkJobDefinition } from "../src/fabric/spark-job-definition";
import {
  materializeSparkJobDefinitionWithProof,
  validateLogicalReferenceDeclarations,
} from "../src/fabric/logical-references";
import {
  materializeSparkJobArtifactUris,
  planSparkJobArtifacts,
} from "../src/fabric/spark-job-artifacts";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

const ONE_LAKE_DFS_ENDPOINT =
  "https://onelake.dfs.fabric.microsoft.com";
const ONE_LAKE_BLOB_ENDPOINT =
  "https://onelake.blob.fabric.microsoft.com";
type ApplyOneLakeStager = NonNullable<
  Parameters<typeof applyApprovedPlan>[0]["oneLakeArtifactStager"]
>;

const sparkJobDefinition = {
  format: "SparkJobDefinitionV2",
  parts: [
    {
      path: "SparkJobDefinitionV1.json",
      payload: Buffer.from(
        JSON.stringify({
          executableFile: "main.py",
          additionalLibraryUris: [],
          language: "Python",
        }),
      ).toString("base64"),
      payloadType: "InlineBase64" as const,
    },
    {
      path: "Main/main.py",
      payload: Buffer.from("print('hello')\n").toString("base64"),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { sparkJob: "content" },
  itemDirectories: { sparkJob: "items/spark-job" },
  itemDefinitions: {
    sparkJob: { displayName: "Hello", description: "Desired" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: { sparkJob: sparkJobDefinition },
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
        logicalId: "sparkJob",
        type: "SparkJobDefinition",
        path: "items/spark-job",
      },
    ],
  },
};

const referencedLoaded: LoadedManifest = {
  ...loaded,
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
      displayName: "Hello",
      description: "Desired",
      references: { defaultLakehouse: "bronze" },
    },
  },
  manifest: {
    ...loaded.manifest,
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

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash,
    ...(physicalId ? { physicalId } : {}),
  };
  return rehashPlan(plan);
}

function makeReferencedPlan(
  lakehouseAction: PlannedAction,
  sparkAction: PlannedAction,
  lakehousePhysicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(referencedLoaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: lakehouseAction,
    reason: lakehouseAction,
    observedStateHash:
      lakehouseAction === "create" ? "absent" : "lakehouse-state",
    ...(lakehousePhysicalId
      ? { physicalId: lakehousePhysicalId }
      : {}),
  };
  plan.items[1] = {
    ...plan.items[1]!,
    action: sparkAction,
    reason: sparkAction,
    observedStateHash:
      sparkAction === "create" ? "absent" : "spark-state",
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-spark-job-apply-"),
  );
  return {
    root,
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function oneLakeStager(
  uploadImmutable: ApplyOneLakeStager["uploadImmutable"],
  verify: ApplyOneLakeStager["verify"],
  dfsEndpoint = ONE_LAKE_DFS_ENDPOINT,
  blobEndpoint = ONE_LAKE_BLOB_ENDPOINT,
): ApplyOneLakeStager {
  return {
    uploadImmutable,
    verify,
    getEndpointIdentity: () => ({
      dfsEndpoint,
      blobEndpoint,
    }),
  };
}

async function artifactScenario() {
  const output = files();
  const workspaceId = "11111111-1111-1111-1111-111111111111";
  const lakehouseId = "22222222-2222-2222-2222-222222222222";
  const sourcePath = path.join(output.root, "main.jar");
  const bytes = Buffer.from("approved jar");
  writeFileSync(sourcePath, bytes);
  const contentHash = createHash("sha256")
    .update(bytes)
    .digest("hex");
  const definition = {
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
        payloadType: "InlineBase64" as const,
      },
    ],
  };
  const loadedWithArtifact: LoadedManifest = {
    ...referencedLoaded,
    manifest: {
      ...referencedLoaded.manifest,
      workspace: { id: workspaceId },
    },
    sparkJobDefinitions: { sparkJob: definition },
    sparkJobArtifactSources: {
      sparkJob: [
        {
          kind: "executable",
          fileName: "main.jar",
          relativePath: "definition/main.jar",
          sourcePath,
          contentHash,
          sizeBytes: bytes.byteLength,
        },
      ],
    },
  };
  const plan = buildPlan(loadedWithArtifact, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action: "create",
    reason: "create",
    observedStateHash: "absent",
  };
  plan.items[1] = {
    ...plan.items[1]!,
    action: "create",
    reason: "create",
    observedStateHash: "absent",
    sparkJobArtifacts: await planSparkJobArtifacts({
      deploymentId: plan.deploymentId,
      environment: plan.environment,
      workspaceId,
      logicalId: "sparkJob",
      targetLakehouseLogicalId: "bronze",
      sources: loadedWithArtifact.sparkJobArtifactSources!.sparkJob!,
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
    }),
  };
  return {
    output,
    workspaceId,
    lakehouseId,
    contentHash,
    loaded: loadedWithArtifact,
    plan: rehashPlan(plan),
  };
}

function materializedArtifactCurrentPlan(
  scenario: Awaited<ReturnType<typeof artifactScenario>>,
  artifactAction: "create" | "no-op" = "create",
  targetLakehouseId = scenario.lakehouseId,
): DeploymentPlan {
  const currentPlan = JSON.parse(
    JSON.stringify(scenario.plan),
  ) as DeploymentPlan;
  currentPlan.items[0] = {
    ...currentPlan.items[0]!,
    action: "no-op",
    reason: "no-op",
    observedStateHash: "lakehouse-state",
    physicalId: targetLakehouseId,
  };
  const approvedStaging =
    currentPlan.items[1]!.sparkJobArtifacts!;
  const artifactUris = materializeSparkJobArtifactUris(
    approvedStaging,
    scenario.loaded.sparkJobArtifactSources!.sparkJob!,
    ONE_LAKE_DFS_ENDPOINT,
    scenario.workspaceId,
    targetLakehouseId,
    currentPlan.deploymentId,
    currentPlan.environment,
    "sparkJob",
  );
  const uriByName = new Map(
    artifactUris.map((artifact) => [
      artifact.fileName,
      artifact.abfssUri,
    ]),
  );
  const staging = {
    ...approvedStaging,
    targetBinding: "physical" as const,
    targetLakehousePhysicalId: targetLakehouseId,
    artifacts: approvedStaging.artifacts.map((artifact) => ({
      ...artifact,
      action: artifactAction,
      observedHash:
        artifactAction === "no-op" ? artifact.contentHash : "",
      abfssUri: uriByName.get(artifact.fileName)!,
      reason:
        artifactAction === "no-op" ? "matches" : "absent",
    })),
  };
  const bindings = validateLogicalReferenceDeclarations({
    item: scenario.loaded.manifest.items[1]!,
    definition: scenario.loaded.itemDefinitions.sparkJob!,
    itemGraph: scenario.loaded.manifest.items,
  });
  const materialized =
    materializeSparkJobDefinitionWithProof(
      scenario.loaded.sparkJobDefinitions.sparkJob!,
      bindings,
      { bronze: targetLakehouseId },
      artifactUris,
    );
  currentPlan.items[1] = {
    ...currentPlan.items[1]!,
    materializedDefinitionHash:
      materialized.materializedDefinitionHash,
    resolvedBindingsHash: materialized.resolvedBindingsHash,
    sparkJobArtifacts: staging,
  };
  return rehashPlan(currentPlan);
}

function lakehouseAdapter() {
  const fail = async () => {
    throw new Error("Lakehouse adapter should not be called.");
  };
  return {
    plan: vi.fn(fail),
    create: vi.fn(fail),
    update: vi.fn(fail),
    resumeCreate: vi.fn(fail),
    verify: vi.fn(fail),
  };
}

function sparkJobAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash =
    plannedAction === "create" ? "absent" : "observed",
  physicalId = "spark-existing",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash
        ? { stagedDefinitionHash }
        : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkJobDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkJobDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        onUpdateCheckpoint?: (state?: {
          phase:
            | "metadata-submitting"
            | "metadata-updated"
            | "definition-staged";
          stagedDefinitionHash: string;
        }) => void,
      ) => {
        onUpdateCheckpoint?.({
          phase: "metadata-submitting",
          stagedDefinitionHash: "a".repeat(64),
        });
        onUpdateCheckpoint?.({
          phase: "definition-staged",
          stagedDefinitionHash: hashSparkJobDefinition(
            sparkJobDefinition,
            false,
          ),
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    resumeCreate: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _definition: LoadedManifest["sparkJobDefinitions"][string],
        _operation: {
          operationId?: string;
          location?: string;
        },
        onMutationAccepted?: (physicalId: string) => void,
      ) => {
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
        };
      },
    ),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "Hello",
      description: "Desired",
    })),
  };
}

describe("guarded Spark Job Definition apply", () => {
  it("stages an approved JAR before creating the Spark Job", async () => {
    const scenario = await artifactScenario();
    const events: string[] = [];
    const failLakehouse = async () => {
      throw new Error("Lakehouse adapter should not be called.");
    };
    const lakehouse = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "create",
        observedStateHash: "absent",
      })),
      create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.(scenario.lakehouseId);
        return {
          id: scenario.lakehouseId,
          displayName: "Bronze",
        };
      },
      ),
      update: vi.fn(failLakehouse),
      resumeCreate: vi.fn(failLakehouse),
      verify: vi.fn(failLakehouse),
    };
    const spark = sparkJobAdapter();
    spark.create.mockImplementation(
      async (
        _workspace,
        _desired,
        definition,
        onMutationAccepted,
        _onOperationAccepted,
        onCreateSubmitting,
      ) => {
        events.push("spark-create");
        onCreateSubmitting?.();
        onMutationAccepted?.("spark-created");
        const configPart = definition.parts.find(
          (part) =>
            part.path === "SparkJobDefinitionV1.json",
        );
        const config = JSON.parse(
          Buffer.from(
            configPart?.payload ?? "",
            "base64",
          ).toString("utf8"),
        ) as Record<string, unknown>;
        expect(config.executableFile).toBe(
          `abfss://${scenario.workspaceId}@onelake.dfs.fabric.microsoft.com/${scenario.lakehouseId}/Files/.fabric-deploy/sample/dev/sparkJob/${scenario.contentHash}/main.jar`,
        );
        expect(config.additionalLibraryUris).toEqual([]);
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
        };
      },
    );
    const uploadImmutable = vi.fn(
      async (_descriptor, hooks) => {
        events.push("artifact-upload");
        hooks?.onUploadSubmitting?.();
        hooks?.onUploadVerified?.();
        return {
          exists: true,
          matches: true,
          observedHash: scenario.contentHash,
        };
      },
    );
    const verify = vi.fn(async () => ({
      exists: true,
      matches: true,
      observedHash: scenario.contentHash,
    }));

    const result = await applyApprovedPlan({
      approvedPlan: scenario.plan,
      currentPlan: scenario.plan,
      loadedManifest: scenario.loaded,
      lakehouseAdapter: lakehouse,
      sparkJobAdapter: spark,
      oneLakeArtifactStager: oneLakeStager(uploadImmutable, verify),
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
      allowCreate: true,
      allowUpdate: false,
      allowOneLakeArtifactCreate: true,
      checkpointFile: scenario.output.checkpointFile,
      resultFile: scenario.output.resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(events).toEqual(["artifact-upload", "spark-create"]);
    const checkpoint = JSON.parse(
      readFileSync(scenario.output.checkpointFile, "utf8"),
    );
    expect(
      checkpoint.oneLakeArtifacts.sparkJob.artifacts[
        scenario.plan.items[1]!.sparkJobArtifacts!.artifacts[0]!
          .operationId
      ].phase,
    ).toBe("verified");
  });

  it("recovers after the Lakehouse checkpoint before artifact state exists", async () => {
    const scenario = await artifactScenario();
    const checkpoint = createCheckpoint(scenario.plan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: scenario.lakehouseId,
      completedAt: "2026-07-18T00:00:00.000Z",
    };
    writeCheckpoint(scenario.output.checkpointFile, checkpoint);
    const currentPlan = materializedArtifactCurrentPlan(scenario);
    const lakehouse = {
      plan: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: scenario.lakehouseId,
        displayName: "Bronze",
      })),
    };
    const spark = sparkJobAdapter();
    const uploadImmutable = vi.fn(
      async (_descriptor, hooks) => {
        hooks?.onUploadSubmitting?.();
        hooks?.onUploadVerified?.();
        return {
          exists: true,
          matches: true,
          observedHash: scenario.contentHash,
        };
      },
    );
    const verify = vi.fn(async () => ({
      exists: true,
      matches: true,
      observedHash: scenario.contentHash,
    }));

    const result = await applyApprovedPlan({
      approvedPlan: scenario.plan,
      currentPlan,
      loadedManifest: scenario.loaded,
      lakehouseAdapter: lakehouse,
      sparkJobAdapter: spark,
      oneLakeArtifactStager: oneLakeStager(uploadImmutable, verify),
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
      allowCreate: true,
      allowUpdate: false,
      allowOneLakeArtifactCreate: true,
      checkpointFile: scenario.output.checkpointFile,
      resultFile: scenario.output.resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(lakehouse.verify).toHaveBeenCalledOnce();
    expect(uploadImmutable).toHaveBeenCalledOnce();
    expect(spark.create).toHaveBeenCalledOnce();
  });

  it("rejects a different physical Spark materialization after Lakehouse recovery", async () => {
    const scenario = await artifactScenario();
    const checkpoint = createCheckpoint(scenario.plan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: scenario.lakehouseId,
      completedAt: "2026-07-18T00:00:00.000Z",
    };
    writeCheckpoint(scenario.output.checkpointFile, checkpoint);
    const currentPlan = materializedArtifactCurrentPlan(scenario);
    currentPlan.items[1] = {
      ...currentPlan.items[1]!,
      materializedDefinitionHash: "f".repeat(64),
    };
    const tamperedCurrentPlan = rehashPlan(currentPlan);
    const uploadImmutable = vi.fn();
    const spark = sparkJobAdapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: tamperedCurrentPlan,
        loadedManifest: scenario.loaded,
        lakehouseAdapter: lakehouseAdapter(),
        sparkJobAdapter: spark,
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          vi.fn(),
        ),
        oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
        oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: true,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow(
      /materialized with different dependency or artifact IDs/i,
    );
    expect(uploadImmutable).not.toHaveBeenCalled();
    expect(spark.create).not.toHaveBeenCalled();
  });

  it("requires independent authorization for OneLake artifact creation", async () => {
    const scenario = await artifactScenario();
    const uploadImmutable = vi.fn();

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: scenario.plan,
        loadedManifest: scenario.loaded,
        lakehouseAdapter: lakehouseAdapter(),
        sparkJobAdapter: sparkJobAdapter(),
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          vi.fn(),
        ),
        oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
        oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: false,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow("allow-onelake-artifact-create is false");
    expect(uploadImmutable).not.toHaveBeenCalled();
  });

  it("binds symbolic artifact approval to both OneLake endpoints", async () => {
    const scenario = await artifactScenario();
    const uploadImmutable = vi.fn();
    const lakehouse = {
      plan: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(),
    };
    const alternateDfs =
      "https://alternate.dfs.fabric.microsoft.com";
    const alternateBlob =
      "https://alternate.blob.fabric.microsoft.com";

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: scenario.plan,
        loadedManifest: scenario.loaded,
        lakehouseAdapter: lakehouse,
        sparkJobAdapter: sparkJobAdapter(),
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          vi.fn(),
          alternateDfs,
          alternateBlob,
        ),
        oneLakeDfsEndpoint: alternateDfs,
        oneLakeBlobEndpoint: alternateBlob,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: true,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow(
      /endpoint configuration changed after plan approval/i,
    );
    expect(lakehouse.create).not.toHaveBeenCalled();
    expect(uploadImmutable).not.toHaveBeenCalled();
  });

  it("verifies staged JAR no-ops with every mutation flag disabled", async () => {
    const scenario = await artifactScenario();
    const plan = buildPlan(scenario.loaded, {
      mode: "plan",
      environment: "dev",
      sourceCommit: "commit-1",
    });
    plan.items[0] = {
      ...plan.items[0]!,
      action: "no-op",
      reason: "no-op",
      observedStateHash: "lakehouse-state",
      physicalId: scenario.lakehouseId,
    };
    const staging = await planSparkJobArtifacts({
      deploymentId: plan.deploymentId,
      environment: plan.environment,
      workspaceId: scenario.workspaceId,
      logicalId: "sparkJob",
      targetLakehouseLogicalId: "bronze",
      targetLakehousePhysicalId: scenario.lakehouseId,
      sources:
        scenario.loaded.sparkJobArtifactSources!.sparkJob!,
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
      stager: {
        inspect: vi.fn(async () => ({
          exists: true,
          matches: true,
          observedHash: scenario.contentHash,
        })),
      },
    });
    const bindings = validateLogicalReferenceDeclarations({
      item: scenario.loaded.manifest.items[1]!,
      definition: scenario.loaded.itemDefinitions.sparkJob!,
      itemGraph: scenario.loaded.manifest.items,
    });
    const materialized =
      materializeSparkJobDefinitionWithProof(
        scenario.loaded.sparkJobDefinitions.sparkJob!,
        bindings,
        { bronze: scenario.lakehouseId },
        materializeSparkJobArtifactUris(
          staging!,
          scenario.loaded.sparkJobArtifactSources!.sparkJob!,
          ONE_LAKE_DFS_ENDPOINT,
          scenario.workspaceId,
          scenario.lakehouseId,
          plan.deploymentId,
          plan.environment,
          "sparkJob",
        ),
      );
    plan.items[1] = {
      ...plan.items[1]!,
      action: "no-op",
      reason: "no-op",
      observedStateHash: "spark-state",
      physicalId: "spark-existing",
      materializedDefinitionHash:
        materialized.materializedDefinitionHash,
      resolvedBindingsHash: materialized.resolvedBindingsHash,
      sparkJobArtifacts: staging,
    };
    const approved = rehashPlan(plan);
    const lakehouse = {
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "no-op",
        physicalId: scenario.lakehouseId,
        observedStateHash: "lakehouse-state",
      })),
      create: vi.fn(),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: scenario.lakehouseId,
        displayName: "Bronze",
      })),
    };
    const spark = sparkJobAdapter(
      "no-op",
      "spark-state",
      "spark-existing",
    );
    const uploadImmutable = vi.fn();
    const verify = vi.fn(async () => ({
      exists: true,
      matches: true,
      observedHash: scenario.contentHash,
    }));

    const result = await applyApprovedPlan({
      approvedPlan: approved,
      currentPlan: approved,
      loadedManifest: scenario.loaded,
      lakehouseAdapter: lakehouse,
      sparkJobAdapter: spark,
      oneLakeArtifactStager: oneLakeStager(uploadImmutable, verify),
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
      allowCreate: false,
      allowUpdate: false,
      allowOneLakeArtifactCreate: false,
      checkpointFile: scenario.output.checkpointFile,
      resultFile: scenario.output.resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(uploadImmutable).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalled();
  });

  it("recovers an ambiguous artifact upload before creating the Spark Job", async () => {
    const scenario = await artifactScenario();
    const firstLakehouse = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "create",
        observedStateHash: "absent",
      })),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: (operation: {
            operationId?: string;
            location?: string;
          }) => void,
          onCreateSubmitting?: () => void,
        ) => {
          onCreateSubmitting?.();
          onMutationAccepted?.(scenario.lakehouseId);
          return {
            id: scenario.lakehouseId,
            displayName: "Bronze",
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(),
    };
    let uploadAttempt = 0;
    const uploadImmutable = vi.fn(
      async (_descriptor, hooks) => {
        uploadAttempt += 1;
        hooks?.onUploadSubmitting?.();
        if (uploadAttempt === 1) {
          throw new Error("ambiguous upload");
        }
        hooks?.onUploadVerified?.();
        return {
          exists: true,
          matches: true,
          observedHash: scenario.contentHash,
        };
      },
    );
    const verify = vi.fn(async () => ({
      exists: true,
      matches: true,
      observedHash: scenario.contentHash,
    }));
    const firstSpark = sparkJobAdapter();

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: scenario.plan,
        loadedManifest: scenario.loaded,
        lakehouseAdapter: firstLakehouse,
        sparkJobAdapter: firstSpark,
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          verify,
        ),
        oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
        oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: true,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow("ambiguous upload");
    expect(firstSpark.create).not.toHaveBeenCalled();
    const failedCheckpoint = JSON.parse(
      readFileSync(scenario.output.checkpointFile, "utf8"),
    );
    expect(
      failedCheckpoint.oneLakeArtifacts.sparkJob.artifacts[
        scenario.plan.items[1]!.sparkJobArtifacts!.artifacts[0]!
          .operationId
      ].phase,
    ).toBe("upload-submitting");

    const rehashedCurrentPlan =
      materializedArtifactCurrentPlan(scenario, "no-op");
    const secondLakehouse = {
      plan: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(async () => ({
        id: scenario.lakehouseId,
        displayName: "Bronze",
      })),
    };
    const secondSpark = sparkJobAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: scenario.plan,
      currentPlan: rehashedCurrentPlan,
      loadedManifest: scenario.loaded,
      lakehouseAdapter: secondLakehouse,
      sparkJobAdapter: secondSpark,
      oneLakeArtifactStager: oneLakeStager(uploadImmutable, verify),
      oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
      oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
      allowCreate: true,
      allowUpdate: false,
      allowOneLakeArtifactCreate: true,
      checkpointFile: scenario.output.checkpointFile,
      resultFile: scenario.output.resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(uploadImmutable).toHaveBeenCalledTimes(2);
    expect(secondSpark.create).toHaveBeenCalledOnce();
  });

  it("verifies a checkpointed symbolic target before artifact recovery", async () => {
    const scenario = await artifactScenario();
    const tamperedLakehouseId =
      "33333333-3333-3333-3333-333333333333";
    const artifact =
      scenario.plan.items[1]!.sparkJobArtifacts!.artifacts[0]!;
    const checkpoint = createCheckpoint(scenario.plan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: tamperedLakehouseId,
      completedAt: "2026-07-18T00:00:00.000Z",
    };
    checkpoint.oneLakeArtifacts = {
      sparkJob: {
        logicalId: "sparkJob",
        targetLakehouseLogicalId: "bronze",
        targetLakehouseId: tamperedLakehouseId,
        stagingHash:
          scenario.plan.items[1]!.sparkJobArtifacts!.stagingHash,
        artifacts: {
          [artifact.operationId]: {
            operationId: artifact.operationId,
            operationHash: artifact.operationHash,
            fileName: artifact.fileName,
            oneLakePath: artifact.oneLakePath,
            contentHash: artifact.contentHash,
            sizeBytes: artifact.sizeBytes,
            phase: "upload-submitting",
            submittedAt: "2026-07-18T00:00:01.000Z",
            updatedAt: "2026-07-18T00:00:01.000Z",
          },
        },
        updatedAt: "2026-07-18T00:00:01.000Z",
      },
    };
    writeCheckpoint(scenario.output.checkpointFile, checkpoint);
    const uploadImmutable = vi.fn();
    const verifyArtifact = vi.fn();
    const verifyLakehouse = vi.fn(async () => {
      throw new Error("checkpointed target verification failed");
    });

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: materializedArtifactCurrentPlan(
          scenario,
          "create",
          tamperedLakehouseId,
        ),
        loadedManifest: scenario.loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: verifyLakehouse,
        },
        sparkJobAdapter: sparkJobAdapter(),
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          verifyArtifact,
        ),
        oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
        oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: true,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow("checkpointed target verification failed");
    expect(verifyLakehouse).toHaveBeenCalledOnce();
    expect(uploadImmutable).not.toHaveBeenCalled();
    expect(verifyArtifact).not.toHaveBeenCalled();
  });

  it("validates pending Spark materialization before artifact recovery", async () => {
    const scenario = await artifactScenario();
    const artifact =
      scenario.plan.items[1]!.sparkJobArtifacts!.artifacts[0]!;
    const checkpoint = createCheckpoint(scenario.plan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: scenario.lakehouseId,
      completedAt: "2026-07-18T00:00:00.000Z",
    };
    checkpoint.oneLakeArtifacts = {
      sparkJob: {
        logicalId: "sparkJob",
        targetLakehouseLogicalId: "bronze",
        targetLakehouseId: scenario.lakehouseId,
        stagingHash:
          scenario.plan.items[1]!.sparkJobArtifacts!.stagingHash,
        artifacts: {
          [artifact.operationId]: {
            operationId: artifact.operationId,
            operationHash: artifact.operationHash,
            fileName: artifact.fileName,
            oneLakePath: artifact.oneLakePath,
            contentHash: artifact.contentHash,
            sizeBytes: artifact.sizeBytes,
            phase: "verified",
            verifiedAt: "2026-07-18T00:00:01.000Z",
            updatedAt: "2026-07-18T00:00:01.000Z",
          },
        },
        completedAt: "2026-07-18T00:00:01.000Z",
        updatedAt: "2026-07-18T00:00:01.000Z",
      },
    };
    checkpoint.pendingCreates.sparkJob = {
      logicalId: "sparkJob",
      action: "create",
      submittedAt: "2026-07-18T00:00:02.000Z",
      materializedDefinitionHash: "f".repeat(64),
      resolvedBindingsHash: "e".repeat(64),
    };
    writeCheckpoint(scenario.output.checkpointFile, checkpoint);
    const verify = vi.fn();
    const uploadImmutable = vi.fn();
    const verifyLakehouse = vi.fn(async () => ({
      id: scenario.lakehouseId,
      displayName: "Bronze",
    }));

    await expect(
      applyApprovedPlan({
        approvedPlan: scenario.plan,
        currentPlan: materializedArtifactCurrentPlan(scenario),
        loadedManifest: scenario.loaded,
        lakehouseAdapter: {
          plan: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          resumeCreate: vi.fn(),
          verify: verifyLakehouse,
        },
        sparkJobAdapter: sparkJobAdapter(),
        oneLakeArtifactStager: oneLakeStager(
          uploadImmutable,
          verify,
        ),
        oneLakeDfsEndpoint: ONE_LAKE_DFS_ENDPOINT,
        oneLakeBlobEndpoint: ONE_LAKE_BLOB_ENDPOINT,
        allowCreate: true,
        allowUpdate: false,
        allowOneLakeArtifactCreate: true,
        checkpointFile: scenario.output.checkpointFile,
        resultFile: scenario.output.resultFile,
      }),
    ).rejects.toThrow(
      /materialized with different dependency IDs/i,
    );
    expect(verifyLakehouse).not.toHaveBeenCalled();
    expect(uploadImmutable).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("rejects tampered OneLake artifact checkpoint proof", async () => {
    const scenario = await artifactScenario();
    const artifact =
      scenario.plan.items[1]!.sparkJobArtifacts!.artifacts[0]!;
    const checkpoint = createCheckpoint(scenario.plan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: scenario.lakehouseId,
      completedAt: "2026-07-18T00:00:00.000Z",
    };
    checkpoint.oneLakeArtifacts = {
      sparkJob: {
        logicalId: "sparkJob",
        targetLakehouseLogicalId: "bronze",
        targetLakehouseId: scenario.lakehouseId,
        stagingHash:
          scenario.plan.items[1]!.sparkJobArtifacts!.stagingHash,
        artifacts: {
          [artifact.operationId]: {
            operationId: artifact.operationId,
            operationHash: "f".repeat(64),
            fileName: artifact.fileName,
            oneLakePath: artifact.oneLakePath,
            contentHash: artifact.contentHash,
            sizeBytes: artifact.sizeBytes,
            phase: "verified",
            verifiedAt: "2026-07-18T00:00:01.000Z",
            updatedAt: "2026-07-18T00:00:01.000Z",
          },
        },
        completedAt: "2026-07-18T00:00:01.000Z",
        updatedAt: "2026-07-18T00:00:01.000Z",
      },
    };
    writeCheckpoint(scenario.output.checkpointFile, checkpoint);

    expect(() =>
      loadCheckpoint(
        scenario.output.checkpointFile,
        scenario.plan,
      ),
    ).toThrow("do not match the approved deployment plan");
  });

  it("materializes a same-run Lakehouse ID before creating the Spark Job", async () => {
    const plan = makeReferencedPlan("create", "create");
    const output = files();
    const pendingProofs: unknown[] = [];
    const sparkAdapter = sparkJobAdapter();
    sparkAdapter.create = vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        definition: LoadedManifest["sparkJobDefinitions"][string],
        onMutationAccepted?: (physicalId: string) => void,
        _onOperationAccepted?: (operation: {
          operationId?: string;
          location?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        pendingProofs.push(
          JSON.parse(
            readFileSync(output.checkpointFile, "utf8"),
          ).pendingCreates.sparkJob,
        );
        onMutationAccepted?.("spark-created");
        return {
          id: "spark-created",
          displayName: "Hello",
          description: "Desired",
          definition,
        };
      },
    );
    const lakehouse = {
      plan: vi.fn(async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      })),
      create: vi.fn(
        async (
          _workspace: string,
          _desired: ItemDefinition,
          onMutationAccepted?: (physicalId: string) => void,
          _onOperationAccepted?: (operation: {
            operationId?: string;
            location?: string;
          }) => void,
          onCreateSubmitting?: () => void,
        ) => {
          onCreateSubmitting?.();
          onMutationAccepted?.("lakehouse-created");
          return {
            id: "lakehouse-created",
            displayName: "Bronze",
          };
        },
      ),
      update: vi.fn(),
      resumeCreate: vi.fn(),
      verify: vi.fn(),
    };

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: referencedLoaded,
      lakehouseAdapter: lakehouse,
      sparkJobAdapter: sparkAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    const materializedDefinition =
      sparkAdapter.create.mock.calls[0]?.[2];
    const config = JSON.parse(
      Buffer.from(
        materializedDefinition?.parts.find(
          (part) =>
            part.path === "SparkJobDefinitionV1.json",
        )?.payload ?? "",
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    expect(config.defaultLakehouseArtifactId).toBe(
      "lakehouse-created",
    );
    expect(pendingProofs[0]).toMatchObject({
      materializedDefinitionHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
      resolvedBindingsHash: expect.stringMatching(
        /^[a-f0-9]{64}$/,
      ),
    });
    expect(result.items.map((item) => item.status)).toEqual([
      "created",
      "created",
    ]);
  });

  it("refuses to resume a pending Spark write with different dependency IDs", async () => {
    const approvedPlan = makeReferencedPlan("create", "create");
    const currentPlan = makeReferencedPlan(
      "no-op",
      "create",
      "lakehouse-new",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.completedItems.bronze = {
      logicalId: "bronze",
      action: "create",
      physicalId: "lakehouse-new",
      completedAt: new Date().toISOString(),
    };
    const sparkItem = referencedLoaded.manifest.items[1]!;
    const bindings = validateLogicalReferenceDeclarations({
      item: sparkItem,
      definition: referencedLoaded.itemDefinitions.sparkJob!,
      itemGraph: referencedLoaded.manifest.items,
    });
    const oldProof = materializeSparkJobDefinitionWithProof(
      sparkJobDefinition,
      bindings,
      { bronze: "lakehouse-old" },
    );
    checkpoint.pendingCreates.sparkJob = {
      logicalId: "sparkJob",
      action: "create",
      submittedAt: new Date().toISOString(),
      materializedDefinitionHash:
        oldProof.materializedDefinitionHash,
      resolvedBindingsHash: oldProof.resolvedBindingsHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: referencedLoaded,
        lakehouseAdapter: lakehouseAdapter(),
        sparkJobAdapter: sparkJobAdapter(),
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow(
      "materialized with different dependency IDs",
    );
  });

  it("creates and checkpoints a Spark Job Definition", async () => {
    const plan = makePlan("create", "absent");
    const output = files();
    const adapter = sparkJobAdapter();

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("created");
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.sparkJob,
      sparkJobDefinition,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    expect(
      JSON.parse(
        readFileSync(output.checkpointFile, "utf8"),
      ).completedItems.sparkJob.physicalId,
    ).toBe("spark-created");
  });

  it("updates through the Spark Job Definition adapter", async () => {
    const plan = makePlan(
      "update",
      "before",
      "spark-existing",
    );
    const output = files();
    const adapter = sparkJobAdapter(
      "update",
      "before",
      "spark-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledOnce();
  });

  it("verifies a no-op Spark Job Definition", async () => {
    const plan = makePlan(
      "no-op",
      "observed",
      "spark-existing",
    );
    const output = files();
    const adapter = sparkJobAdapter(
      "no-op",
      "observed",
      "spark-existing",
    );

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("verified");
    expect(adapter.verify).toHaveBeenCalledOnce();
  });

  it("recovers an interrupted definition update", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "spark-existing",
    );
    const currentPlan = makePlan(
      "update",
      "metadata-updated",
      "spark-existing",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const stagedDefinitionHash = "b".repeat(64);
    checkpoint.pendingUpdates.sparkJob = {
      logicalId: "sparkJob",
      action: "update",
      physicalId: "spark-existing",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const adapter = sparkJobAdapter(
      "update",
      "metadata-updated",
      "spark-existing",
      stagedDefinitionHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      sparkJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});
