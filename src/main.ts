import * as core from "@actions/core";
import { readFileSync } from "node:fs";
import path from "node:path";

import { applyApprovedPlan } from "./apply";
import {
  initializeApplyArtifacts,
  writeApplyResult,
} from "./checkpoint";
import {
  EntraTokenProvider,
  FABRIC_SCOPE,
  type AuthMode,
} from "./fabric/auth";
import { FabricClient } from "./fabric/client";
import { parseFabricEndpoints } from "./fabric/config";
import { EnvironmentAdapter } from "./fabric/environment";
import { EventhouseAdapter } from "./fabric/eventhouse";
import { KqlDatabaseAdapter } from "./fabric/kql-database";
import { WarehouseAdapter } from "./fabric/warehouse";
import { ItemDeletionAdapter } from "./fabric/item-deletion";
import { LakehouseAdapter } from "./fabric/lakehouse";
import { LakehouseTablesAdapter } from "./fabric/lakehouse-tables";
import { buildLakehouseLivyApiEndpoints } from "./fabric/livy";
import { enrichPlanWithFabric } from "./fabric/live-planner";
import {
  managedPrivateEndpointRequestMessages,
  ManagedPrivateEndpointAdapter,
  redactManagedPrivateEndpointError,
} from "./fabric/managed-private-endpoints";
import { NetworkProtectionAdapter } from "./fabric/network-protection";
import { NotebookAdapter } from "./fabric/notebook";
import { OneLakeArtifactStager } from "./fabric/onelake-artifacts";
import { PipelineAdapter } from "./fabric/pipeline";
import { ReportAdapter } from "./fabric/report";
import { SemanticModelAdapter } from "./fabric/semantic-model";
import { SparkCustomPoolAdapter } from "./fabric/spark-custom-pool";
import { assertSparkJobArtifactEndpoints } from "./fabric/spark-job-artifacts";
import { SparkJobAdapter } from "./fabric/spark-job";
import { FabricTagAdapter } from "./fabric/tags";
import { WorkspaceAdapter } from "./fabric/workspace";
import {
  loadManifest,
  loadManifestItemDirectoriesForSafety,
  loadNetworkProtectionManifest,
} from "./manifest";
import { loadApprovedPlan } from "./plan-artifact";
import { buildPlan } from "./planner";
import { recoverInterruptedNetworkProtection } from "./network-apply";
import {
  assertDistinctFilePaths,
  assertOutputPathOutsideItems,
  writeJobSummary,
  writePlan,
} from "./reporting";
import type {
  ActionMode,
  ApplyCheckpoint,
  DeploymentPlan,
} from "./types";

export async function run(): Promise<void> {
  let requestMessagesToRedact: string[] = [];
  let initializedApply:
    | {
        plan: DeploymentPlan;
        resultFile: string;
        startedAt: number;
      }
    | undefined;
  try {
    const mode = readMode(core.getInput("mode") || "plan");
    const manifestPath = core.getInput("manifest") || "fabric/deployment.yaml";
    const environment = core.getInput("environment") || "dev";
    const workspaceId = core.getInput("workspace-id") || undefined;
    const variables = readVariables(core.getInput("variables") || "{}");
    const authMode = readAuthMode(core.getInput("auth-mode") || "none");
    const endpoints = parseFabricEndpoints(
      core.getInput("fabric-api-endpoint") ||
        "https://api.fabric.microsoft.com",
      core.getInput("onelake-endpoint") ||
        "https://onelake.dfs.fabric.microsoft.com",
      core.getInput("onelake-blob-endpoint") || undefined,
    );
    const planFile = core.getInput("plan-file") || "fabric-plan.json";
    const sourceCommit = process.env.GITHUB_SHA || undefined;
    const returnLivyApiEndpoint = readBooleanInput(
      "return-livy-api-endpoint",
    );
    const allowNetworkPolicyUpdate =
      mode === "apply"
        ? readBooleanInput("allow-network-policy-update")
        : false;
    const allowNetworkPolicyRelaxation =
      mode === "apply"
        ? readBooleanInput("allow-network-policy-relaxation")
        : false;
    const allowInboundFirewallUpdate =
      mode === "apply"
        ? readBooleanInput("allow-inbound-firewall-update")
        : false;
    const allowInboundAzureResourceRuleUpdate =
      mode === "apply"
        ? readBooleanInput("allow-inbound-azure-resource-rule-update")
        : false;
    const allowInboundExternalDataSharePolicyUpdate =
      mode === "apply"
        ? readBooleanInput(
            "allow-inbound-external-data-share-policy-update",
          )
        : false;
    const allowInboundExternalDataSharePolicyRelaxation =
      mode === "apply"
        ? readBooleanInput(
            "allow-inbound-external-data-share-policy-relaxation",
          )
        : false;
    const acknowledgeFirewallLockoutRisk =
      mode === "apply"
        ? readBooleanInput("acknowledge-firewall-lockout-risk")
        : false;
    const allowOutboundCloudConnectionRuleUpdate =
      mode === "apply"
        ? readBooleanInput(
            "allow-outbound-cloud-connection-rule-update",
          )
        : false;
    const allowOutboundGatewayRuleUpdate =
      mode === "apply"
        ? readBooleanInput("allow-outbound-gateway-rule-update")
        : false;
    const allowManagedPrivateEndpointCreate =
      mode === "apply"
        ? readBooleanInput(
            "allow-managed-private-endpoint-create",
          )
        : false;
    const allowManagedPrivateEndpointDelete =
      mode === "apply"
        ? readBooleanInput(
            "allow-managed-private-endpoint-delete",
          )
        : false;
    if (returnLivyApiEndpoint && mode !== "apply") {
      throw new Error(
        "return-livy-api-endpoint is supported only when mode is apply.",
      );
    }

    let plan: DeploymentPlan;
    let approvedPlan: DeploymentPlan | undefined;
    let applyCheckpoint: ApplyCheckpoint | undefined;
    let checkpointFile: string | undefined;
    let resultFile: string | undefined;
    if (mode === "apply") {
      const approvedPlanFile = core.getInput("approved-plan-file");
      if (!approvedPlanFile) {
        throw new Error("approved-plan-file is required when mode is apply.");
      }
      checkpointFile =
        core.getInput("checkpoint-file") || "fabric-checkpoint.json";
      resultFile = core.getInput("result-file") || "fabric-result.json";
      assertDistinctFilePaths([
        {
          label: "Deployment manifest",
          filePath: manifestPath,
        },
        { label: "Approved plan file", filePath: approvedPlanFile },
        { label: "Current plan file", filePath: planFile },
        { label: "Checkpoint file", filePath: checkpointFile },
        { label: "Result file", filePath: resultFile },
      ]);
      approvedPlan = loadApprovedPlan(approvedPlanFile);
      const declaredItemDirectories =
        loadManifestItemDirectoriesForSafety(manifestPath, {
          variables,
          workspaceIdOverride: workspaceId,
        });
      assertOutputPathOutsideItems(
        checkpointFile,
        declaredItemDirectories,
        "Checkpoint file",
      );
      assertOutputPathOutsideItems(
        resultFile,
        declaredItemDirectories,
        "Result file",
      );
      const applyStartedAt = Date.now();
      applyCheckpoint = initializeApplyArtifacts(
        approvedPlan,
        checkpointFile,
        resultFile,
        applyStartedAt,
      );
      initializedApply = {
        plan: approvedPlan,
        resultFile,
        startedAt: applyStartedAt,
      };
      core.setOutput("checkpoint-file", path.resolve(checkpointFile));
      core.setOutput("result-file", path.resolve(resultFile));
    } else {
      assertDistinctFilePaths([
        {
          label: "Deployment manifest",
          filePath: manifestPath,
        },
        { label: "Plan file", filePath: planFile },
      ]);
    }
    let lakehouseAdapter: LakehouseAdapter | undefined;
    let eventhouseAdapter: EventhouseAdapter | undefined;
    let kqlDatabaseAdapter: KqlDatabaseAdapter | undefined;
    let warehouseAdapter: WarehouseAdapter | undefined;
    let environmentAdapter: EnvironmentAdapter | undefined;
    let itemDeletionAdapter: ItemDeletionAdapter | undefined;
    let notebookAdapter: NotebookAdapter | undefined;
    let sparkJobAdapter: SparkJobAdapter | undefined;
    let pipelineAdapter: PipelineAdapter | undefined;
    let semanticModelAdapter: SemanticModelAdapter | undefined;
    let reportAdapter: ReportAdapter | undefined;
    let sparkCustomPoolAdapter: SparkCustomPoolAdapter | undefined;
    let tagAdapter: FabricTagAdapter | undefined;
    let workspaceAdapter: WorkspaceAdapter | undefined;
    let lakehouseTablesAdapter: LakehouseTablesAdapter | undefined;
    let networkProtectionAdapter: NetworkProtectionAdapter | undefined;
    let managedPrivateEndpointAdapter:
      | ManagedPrivateEndpointAdapter
      | undefined;
    let oneLakeArtifactStager: OneLakeArtifactStager | undefined;
    if ((mode === "plan" || mode === "apply") && authMode !== "none") {
      const clientSecret = core.getInput("client-secret") || undefined;
      if (clientSecret) {
        core.setSecret(clientSecret);
      }
      const tokenProvider = new EntraTokenProvider({
        mode: authMode,
        tenantId: core.getInput("tenant-id"),
        clientId: core.getInput("client-id"),
        clientSecret,
        authorityHost:
          core.getInput("authority-host") ||
          "https://login.microsoftonline.com",
        getOidcToken:
          authMode === "oidc"
            ? (audience) => core.getIDToken(audience)
            : undefined,
        maskSecret: (value) => core.setSecret(value),
      });
      const client = new FabricClient({
        endpoint: endpoints.fabricApiEndpoint,
        scope: FABRIC_SCOPE,
        tokenProvider,
      });
      lakehouseAdapter = new LakehouseAdapter(client);
      eventhouseAdapter = new EventhouseAdapter(client);
      kqlDatabaseAdapter = new KqlDatabaseAdapter(client);
      warehouseAdapter = new WarehouseAdapter(client);
      lakehouseTablesAdapter = new LakehouseTablesAdapter(client);
      environmentAdapter = new EnvironmentAdapter(client);
      itemDeletionAdapter = new ItemDeletionAdapter(client);
      notebookAdapter = new NotebookAdapter(client);
      sparkJobAdapter = new SparkJobAdapter(client);
      pipelineAdapter = new PipelineAdapter(client);
      semanticModelAdapter = new SemanticModelAdapter(client);
      reportAdapter = new ReportAdapter(client);
      sparkCustomPoolAdapter = new SparkCustomPoolAdapter(client);
      tagAdapter = new FabricTagAdapter(client);
      workspaceAdapter = new WorkspaceAdapter(client);
      managedPrivateEndpointAdapter =
        new ManagedPrivateEndpointAdapter(client);
      networkProtectionAdapter = new NetworkProtectionAdapter(
        client,
        managedPrivateEndpointAdapter,
      );
      oneLakeArtifactStager = new OneLakeArtifactStager({
        dfsEndpoint: endpoints.oneLakeEndpoint,
        blobEndpoint: endpoints.oneLakeBlobEndpoint,
        tokenProvider,
      });
    } else if (mode === "apply") {
      throw new Error("apply mode requires Fabric authentication.");
    }

    if (mode === "apply") {
      if (
        !approvedPlan ||
        !applyCheckpoint ||
        !checkpointFile ||
        !networkProtectionAdapter
      ) {
        throw new Error(
          "Network protection recovery was not initialized for apply mode.",
        );
      }
      // Load only the security declaration first so unrelated item paths or
      // definitions cannot prevent completion of an already-started unit.
      const desiredNetworkProtection = loadNetworkProtectionManifest(
        manifestPath,
        {
          variables,
          workspaceIdOverride: workspaceId,
        },
      );
      requestMessagesToRedact =
        managedPrivateEndpointRequestMessages(
          desiredNetworkProtection,
        );
      await recoverInterruptedNetworkProtection({
        approvedPlan,
        currentPlan: approvedPlan,
        desired: desiredNetworkProtection,
        adapter: networkProtectionAdapter,
        managedPrivateEndpointAdapter,
        checkpoint: applyCheckpoint,
        checkpointFile,
        allowNetworkPolicyUpdate,
        allowNetworkPolicyRelaxation,
        allowInboundFirewallUpdate,
        allowInboundAzureResourceRuleUpdate,
        allowInboundExternalDataSharePolicyUpdate,
        allowInboundExternalDataSharePolicyRelaxation,
        acknowledgeFirewallLockoutRisk,
        allowOutboundCloudConnectionRuleUpdate,
        allowOutboundGatewayRuleUpdate,
        allowManagedPrivateEndpointCreate,
        allowManagedPrivateEndpointDelete,
      });
    }

    const loadedManifest = loadManifest(manifestPath, {
      variables,
      workspaceIdOverride: workspaceId,
    });
    requestMessagesToRedact =
      managedPrivateEndpointRequestMessages(
        loadedManifest.manifest.networkProtection,
      );
    if (mode === "apply") {
      if (!checkpointFile || !resultFile || !approvedPlan) {
        throw new Error(
          "Apply artifacts were not initialized before manifest validation.",
        );
      }
      const itemDirectories = Object.values(
        loadedManifest.itemDirectories,
      );
      assertOutputPathOutsideItems(
        checkpointFile,
        itemDirectories,
        "Checkpoint file",
      );
      assertOutputPathOutsideItems(
        resultFile,
        itemDirectories,
        "Result file",
      );
      for (const item of approvedPlan.items) {
        if (item.sparkJobArtifacts) {
          assertSparkJobArtifactEndpoints(
            item.sparkJobArtifacts,
            endpoints.oneLakeEndpoint,
            endpoints.oneLakeBlobEndpoint,
          );
        }
      }
    }

    plan = buildPlan(loadedManifest, {
      mode: mode === "apply" ? "plan" : mode,
      environment,
      workspaceId,
      sourceCommit,
    });
    if ((mode === "plan" || mode === "apply") && authMode !== "none") {
      if (
        !workspaceAdapter ||
        !itemDeletionAdapter ||
        !lakehouseAdapter ||
        !eventhouseAdapter ||
        !kqlDatabaseAdapter ||
        !warehouseAdapter ||
        !environmentAdapter ||
        !notebookAdapter ||
        !sparkJobAdapter ||
        !pipelineAdapter ||
        !semanticModelAdapter ||
        !reportAdapter ||
        !sparkCustomPoolAdapter ||
        !tagAdapter ||
        !lakehouseTablesAdapter ||
        !networkProtectionAdapter ||
        !oneLakeArtifactStager
      ) {
        throw new Error(
          "Fabric adapters were not initialized for authenticated planning.",
        );
      }
      plan = await enrichPlanWithFabric(plan, loadedManifest, {
        workspace: workspaceAdapter,
        deletion: itemDeletionAdapter,
        lakehouse: lakehouseAdapter,
        eventhouse: eventhouseAdapter,
        kqlDatabase: kqlDatabaseAdapter,
        warehouse: warehouseAdapter,
        environment: environmentAdapter,
        notebook: notebookAdapter,
        sparkJob: sparkJobAdapter,
        pipeline: pipelineAdapter,
        semanticModel: semanticModelAdapter,
        report: reportAdapter,
        sparkCustomPool: sparkCustomPoolAdapter,
        tags: tagAdapter,
        lakehouseTables: lakehouseTablesAdapter,
        networkProtection: networkProtectionAdapter,
        oneLakeArtifacts: {
          dfsEndpoint: endpoints.oneLakeEndpoint,
          blobEndpoint: endpoints.oneLakeBlobEndpoint,
          stager: oneLakeArtifactStager,
        },
      });
    }
    const writtenPlanFile = writePlan(
      plan,
      planFile,
      Object.values(loadedManifest.itemDirectories),
    );
    core.setOutput("plan-file", writtenPlanFile);
    core.setOutput("plan-hash", plan.planHash);
    core.setOutput("source-hash", plan.sourceHash);
    core.setOutput("item-count", String(plan.items.length));
    core.setOutput(
      "create-count",
      String(plan.items.filter((item) => item.action === "create").length),
    );
    core.setOutput(
      "update-count",
      String(plan.items.filter((item) => item.action === "update").length),
    );
    core.setOutput(
      "delete-count",
      String(plan.items.filter((item) => item.action === "delete").length),
    );
    core.setOutput(
      "noop-count",
      String(plan.items.filter((item) => item.action === "no-op").length),
    );
    core.setOutput(
      "unknown-count",
      String(plan.items.filter((item) => item.action === "unknown").length),
    );
    core.setOutput(
      "workspace-id",
      plan.workspace?.physicalId ??
        (plan.workspace ? "" : plan.workspaceId),
    );
    core.setOutput(
      "workspace-action",
      plan.workspace?.action ?? "target",
    );
    core.setOutput(
      "network-protection-action",
      plan.networkProtection?.communicationPolicy.action ?? "not-configured",
    );
    core.setOutput(
      "inbound-firewall-action",
      plan.networkProtection?.inboundFirewallRules?.action ??
        "not-configured",
    );
    core.setOutput(
      "inbound-firewall-rule-count",
      String(plan.networkProtection?.inboundFirewallRules?.ruleCount ?? 0),
    );
    core.setOutput(
      "inbound-azure-resource-rule-action",
      plan.networkProtection?.inboundAzureResourceRules?.action ??
        "not-configured",
    );
    core.setOutput(
      "inbound-azure-resource-rule-count",
      String(
        plan.networkProtection?.inboundAzureResourceRules?.ruleCount ?? 0,
      ),
    );
    core.setOutput(
      "inbound-external-data-share-policy-action",
      plan.networkProtection?.inboundExternalDataSharesPolicy?.action ??
        "not-configured",
    );
    core.setOutput(
      "inbound-external-data-share-policy-default-action",
      plan.networkProtection?.inboundExternalDataSharesPolicy
        ?.desiredDefaultAction ?? "",
    );
    const managedPrivateEndpoints =
      plan.networkProtection?.managedPrivateEndpoints ?? [];
    core.setOutput(
      "managed-private-endpoint-count",
      String(managedPrivateEndpoints.length),
    );
    for (const action of [
      "create",
      "delete",
      "no-op",
      "blocked",
      "unknown",
    ] as const) {
      core.setOutput(
        `managed-private-endpoint-${action === "no-op" ? "noop" : action}-count`,
        String(
          managedPrivateEndpoints.filter(
            (endpoint) => endpoint.action === action,
          ).length,
        ),
      );
    }
    core.setOutput("requires-item-replan", "false");
    await writeJobSummary(plan);

    if (mode === "apply") {
      if (
        !approvedPlan ||
        !checkpointFile ||
        !resultFile ||
        !lakehouseAdapter ||
        !eventhouseAdapter ||
        !kqlDatabaseAdapter ||
        !warehouseAdapter ||
        !environmentAdapter ||
        !itemDeletionAdapter ||
        !notebookAdapter ||
        !sparkJobAdapter ||
        !pipelineAdapter ||
        !semanticModelAdapter ||
        !reportAdapter ||
        !sparkCustomPoolAdapter ||
        !tagAdapter ||
        !workspaceAdapter
        || !lakehouseTablesAdapter ||
        !networkProtectionAdapter ||
        !managedPrivateEndpointAdapter ||
        !oneLakeArtifactStager
      ) {
        throw new Error("Fabric adapters were not initialized for apply mode.");
      }
      const result = await applyApprovedPlan({
        approvedPlan,
        currentPlan: plan,
        loadedManifest,
        lakehouseAdapter,
        eventhouseAdapter,
        kqlDatabaseAdapter,
        warehouseAdapter,
        environmentAdapter,
        itemDeletionAdapter,
        notebookAdapter,
        sparkJobAdapter,
        pipelineAdapter,
        semanticModelAdapter,
        reportAdapter,
        sparkCustomPoolAdapter,
        tagAdapter,
        workspaceAdapter,
        lakehouseTablesAdapter,
        networkProtectionAdapter,
        managedPrivateEndpointAdapter,
        oneLakeArtifactStager,
        oneLakeDfsEndpoint: endpoints.oneLakeEndpoint,
        oneLakeBlobEndpoint: endpoints.oneLakeBlobEndpoint,
        allowCreate: readBooleanInput("allow-create"),
        allowUpdate: readBooleanInput("allow-update"),
        allowDelete: readBooleanInput("allow-delete"),
        allowLakehouseDataLoss: readBooleanInput(
          "allow-lakehouse-data-loss",
        ),
        allowWorkspaceCreate: readBooleanInput(
          "allow-workspace-create",
        ),
        allowWorkspaceUpdate: readBooleanInput(
          "allow-workspace-update",
        ),
        allowCapacityAssignment: readBooleanInput(
          "allow-capacity-assignment",
        ),
        allowLakehouseSchemaCreate: readBooleanInput(
          "allow-lakehouse-schema-create",
        ),
        allowLakehouseTableCreate: readBooleanInput(
          "allow-lakehouse-table-create",
        ),
        allowOneLakeArtifactCreate: readBooleanInput(
          "allow-onelake-artifact-create",
        ),
        allowTagCreate: readBooleanInput("allow-tag-create"),
        allowTagAssign: readBooleanInput("allow-tag-assign"),
        allowNetworkPolicyUpdate,
        allowNetworkPolicyRelaxation,
        allowInboundFirewallUpdate,
        allowInboundAzureResourceRuleUpdate,
        allowInboundExternalDataSharePolicyUpdate,
        allowInboundExternalDataSharePolicyRelaxation,
        acknowledgeFirewallLockoutRisk,
        allowOutboundCloudConnectionRuleUpdate,
        allowOutboundGatewayRuleUpdate,
        allowManagedPrivateEndpointCreate,
        allowManagedPrivateEndpointDelete,
        checkpointFile,
        resultFile,
        itemDirectories: Object.values(loadedManifest.itemDirectories),
      });
      core.setOutput("status", "applied");
      core.setOutput("approved-plan-hash", approvedPlan.planHash);
      core.setOutput("workspace-id", result.workspaceId);
      core.setOutput(
        "workspace-action",
        approvedPlan.workspace?.action ?? "target",
      );
      core.setOutput(
        "network-protection-action",
        approvedPlan.networkProtection?.communicationPolicy.action ??
          "not-configured",
      );
      core.setOutput(
        "inbound-firewall-action",
        approvedPlan.networkProtection?.inboundFirewallRules?.action ??
          "not-configured",
      );
      core.setOutput(
        "inbound-firewall-rule-count",
        String(
          approvedPlan.networkProtection?.inboundFirewallRules
            ?.ruleCount ?? 0,
        ),
      );
      core.setOutput(
        "inbound-azure-resource-rule-action",
        approvedPlan.networkProtection?.inboundAzureResourceRules?.action ??
          "not-configured",
      );
      core.setOutput(
        "inbound-azure-resource-rule-count",
        String(
          approvedPlan.networkProtection?.inboundAzureResourceRules
            ?.ruleCount ?? 0,
        ),
      );
      core.setOutput(
        "inbound-external-data-share-policy-action",
        approvedPlan.networkProtection?.inboundExternalDataSharesPolicy
          ?.action ?? "not-configured",
      );
      core.setOutput(
        "inbound-external-data-share-policy-default-action",
        approvedPlan.networkProtection?.inboundExternalDataSharesPolicy
          ?.desiredDefaultAction ?? "",
      );
      core.setOutput(
        "requires-item-replan",
        String(result.requiresItemReplan === true),
      );
      core.setOutput(
        "applied-count",
        String(result.items.filter((item) => item.status !== "resumed").length),
      );
      core.setOutput(
        "resumed-count",
        String(result.items.filter((item) => item.status === "resumed").length),
      );
      const managedPrivateEndpointResults =
        result.networkProtection?.managedPrivateEndpoints ?? [];
      core.setOutput(
        "managed-private-endpoint-applied-count",
        String(
          managedPrivateEndpointResults.filter(
            (endpoint) => endpoint.status !== "resumed",
          ).length,
        ),
      );
      core.setOutput(
        "managed-private-endpoint-resumed-count",
        String(
          managedPrivateEndpointResults.filter(
            (endpoint) => endpoint.status === "resumed",
          ).length,
        ),
      );
      if (returnLivyApiEndpoint) {
        const livyApiEndpoints = buildLakehouseLivyApiEndpoints(
          endpoints.fabricApiEndpoint,
          result.workspaceId,
          result.items,
        );
        const endpointsByLogicalId = JSON.stringify(livyApiEndpoints);
        core.setOutput("livy-api-endpoints", endpointsByLogicalId);
        const endpointValues = Object.values(livyApiEndpoints);
        core.setOutput(
          "livy-api-endpoint",
          endpointValues.length === 1 ? endpointValues[0] : "",
        );
      }
    } else {
      core.setOutput("status", mode === "validate" ? "validated" : "planned");
    }
  } catch (error) {
    const redactedError = redactManagedPrivateEndpointError(
      error,
      requestMessagesToRedact,
    );
    const message =
      redactedError instanceof Error
        ? redactedError.message
        : String(redactedError);
    if (
      initializedApply &&
      isInProgressResult(initializedApply.resultFile)
    ) {
      const completedAt = Date.now();
      try {
        writeApplyResult(initializedApply.resultFile, {
          schemaVersion: "1",
          status: "failed",
          deploymentId: initializedApply.plan.deploymentId,
          workspaceId: initializedApply.plan.workspaceId,
          environment: initializedApply.plan.environment,
          planHash: initializedApply.plan.planHash,
          ...(initializedApply.plan.sourceCommit
            ? { sourceCommit: initializedApply.plan.sourceCommit }
            : {}),
          startedAt: new Date(initializedApply.startedAt).toISOString(),
          completedAt: new Date(completedAt).toISOString(),
          items: [
            {
              logicalId: "<apply>",
              type: "Lakehouse",
              action: "blocked",
              status: "failed",
              durationMs: completedAt - initializedApply.startedAt,
              error: message,
            },
          ],
        });
      } catch (reportingError) {
        core.setFailed(
          `${message} Result reporting also failed: ${
            reportingError instanceof Error
              ? reportingError.message
              : String(reportingError)
          }`,
        );
        return;
      }
    }
    core.setFailed(message);
  }
}

function isInProgressResult(resultFile: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path.resolve(resultFile), "utf8")) as {
      status?: unknown;
    };
    return parsed.status === "in_progress";
  } catch {
    return true;
  }
}

function readAuthMode(value: string): "none" | AuthMode {
  if (
    value !== "none" &&
    value !== "oidc" &&
    value !== "service-principal-secret"
  ) {
    throw new Error(
      `Unsupported auth-mode '${value}'. Expected 'none', 'oidc', or 'service-principal-secret'.`,
    );
  }

  return value;
}

function readBooleanInput(name: string): boolean {
  const value = (core.getInput(name) || "false").toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be either 'true' or 'false'.`);
  }
  return value === "true";
}

function readVariables(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The variables input must be a valid JSON object.");
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("The variables input must be a JSON object.");
  }

  const variables: Record<string, string> = {};
  for (const [name, variableValue] of Object.entries(parsed)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid deployment variable name '${name}'.`);
    }
    if (typeof variableValue !== "string") {
      throw new Error(`Deployment variable '${name}' must be a string.`);
    }
    variables[name] = variableValue;
  }
  return variables;
}

function readMode(value: string): ActionMode {
  if (value !== "validate" && value !== "plan" && value !== "apply") {
    throw new Error(
      `Unsupported mode '${value}'. Expected 'validate', 'plan', or 'apply'.`,
    );
  }
  return value;
}
