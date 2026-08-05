import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import {
  APACHE_AIRFLOW_DEFINITION_PATH,
  apacheAirflowIncludesPlatformPart,
  hashApacheAirflowDefinition,
} from "../src/fabric/apache-airflow-definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
  PlannedApacheAirflowFiles,
} from "../src/types";

const bundle = {
  definition: {
    parts: [
      {
        path: ".platform",
        payload: Buffer.from(
          JSON.stringify({
            metadata: {
              type: "ApacheAirflowJob",
              displayName: "HelloAirflow",
            },
          }),
        ).toString("base64"),
        payloadType: "InlineBase64" as const,
      },
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
  files: [
    {
      filePath: "dags/hello.py",
      payload: Buffer.from("print('hello')\n").toString("base64"),
      contentHash: "d".repeat(64),
      sizeBytes: 15,
    },
  ],
};

const filePlan: PlannedApacheAirflowFiles = {
  desiredHash: "a".repeat(64),
  observedStateHash: "b".repeat(64),
  ownershipHash: "c".repeat(64),
  operations: [
    {
      filePath: "dags/hello.py",
      action: "update",
      desiredHash: "d".repeat(64),
      observedHash: "e".repeat(64),
      ownedHash: "e".repeat(64),
      sizeBytes: 15,
      reason: "Update DAG.",
    },
  ],
};

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
      description: "Managed",
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
    metadata: { deploymentId: "airflow-apply" },
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

function makePlan(
  action: PlannedAction,
  observedStateHash: string,
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash,
    ...(physicalId ? { physicalId } : {}),
    ...(action === "update" || action === "no-op"
      ? { apacheAirflowFiles: filePlan }
      : {}),
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-airflow-apply-"),
  );
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  const fail = vi.fn(async () => {
    throw new Error("Lakehouse adapter should not be called.");
  });
  return {
    plan: fail,
    create: fail,
    update: fail,
    resumeCreate: fail,
    verify: fail,
  };
}

function adapter(
  plannedAction: "create" | "update" | "no-op",
  observedStateHash: string,
  currentFiles = filePlan,
) {
  const definitionHash = hashApacheAirflowDefinition(
    bundle.definition,
    apacheAirflowIncludesPlatformPart(bundle.definition),
  );
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction === "create"
        ? {}
        : {
            physicalId: "airflow-1",
            stagedDefinitionHash: definitionHash,
            managedMetadataMatches: true,
            apacheAirflowFiles: currentFiles,
          }),
    })),
    create: vi.fn(
      async (
        _workspace: string,
        _desired: ItemDefinition,
        _bundle: typeof bundle,
        onMutationAccepted?: (id: string) => void,
        onOperationAccepted?: (operation: {
          physicalId?: string;
          shellDefinitionHash?: string;
        }) => void,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onOperationAccepted?.({
          physicalId: "airflow-1",
          shellDefinitionHash: definitionHash,
        });
        onMutationAccepted?.("airflow-1");
        return {
          id: "airflow-1",
          displayName: "HelloAirflow",
        };
      },
    ),
    update: vi.fn(
      async (
        _workspace: string,
        id: string,
        _desired: ItemDefinition,
        _bundle: typeof bundle,
        onMutationAccepted?: (id: string) => void,
        onUpdateCheckpoint?: (state: {
          phase: "definition-staged";
          stagedDefinitionHash: string;
        }) => void,
      ) => {
        onUpdateCheckpoint?.({
          phase: "definition-staged",
          stagedDefinitionHash: definitionHash,
        });
        onMutationAccepted?.(id);
        return {
          id,
          displayName: "HelloAirflow",
        };
      },
    ),
    resumeCreate: vi.fn(),
    verify: vi.fn(async (_workspace: string, id: string) => ({
      id,
      displayName: "HelloAirflow",
    })),
  };
}

describe("guarded Apache Airflow apply", () => {
  it("creates an Apache Airflow Job with its captured bundle", async () => {
    const plan = makePlan("create", "absent");
    const apacheAirflowAdapter = adapter("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      apacheAirflowAdapter,
      allowCreate: true,
      allowUpdate: false,
      ...files(),
    });

    expect(result.items[0]?.status).toBe("created");
    expect(apacheAirflowAdapter.create).toHaveBeenCalledWith(
      "workspace",
      loaded.itemDefinitions.airflow,
      bundle,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it("recovers when an interrupted update has only approved file progress", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "airflow-1",
    );
    const currentPlan = makePlan(
      "update",
      "partial",
      "airflow-1",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    const definitionHash = hashApacheAirflowDefinition(
      bundle.definition,
      true,
    );
    checkpoint.pendingUpdates.airflow = {
      logicalId: "airflow",
      action: "update",
      physicalId: "airflow-1",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: definitionHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const completedFiles: PlannedApacheAirflowFiles = {
      ...filePlan,
      operations: [
        {
          ...filePlan.operations[0]!,
          action: "no-op",
          observedHash: "d".repeat(64),
          ownedHash: "d".repeat(64),
        },
      ],
    };
    const apacheAirflowAdapter = adapter(
      "update",
      "partial",
      completedFiles,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      apacheAirflowAdapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(apacheAirflowAdapter.update).toHaveBeenCalledOnce();
  });

  it("fails closed when an owned DAG changed to unapproved content", async () => {
    const approvedPlan = makePlan(
      "update",
      "before",
      "airflow-1",
    );
    const currentPlan = makePlan(
      "update",
      "drifted",
      "airflow-1",
    );
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.airflow = {
      logicalId: "airflow",
      action: "update",
      physicalId: "airflow-1",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: hashApacheAirflowDefinition(
        bundle.definition,
        true,
      ),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);
    const driftedFiles: PlannedApacheAirflowFiles = {
      ...filePlan,
      operations: [
        {
          ...filePlan.operations[0]!,
          action: "blocked",
          observedHash: "f".repeat(64),
        },
      ],
    };
    const apacheAirflowAdapter = adapter(
      "update",
      "drifted",
      driftedFiles,
    );

    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        apacheAirflowAdapter,
        allowCreate: false,
        allowUpdate: true,
        ...output,
      }),
    ).rejects.toThrow("cannot be reconciled");
    expect(apacheAirflowAdapter.update).not.toHaveBeenCalled();
  });
});
