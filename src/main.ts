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
import { LakehouseAdapter } from "./fabric/lakehouse";
import { enrichPlanWithFabric } from "./fabric/live-planner";
import { loadManifest } from "./manifest";
import { loadApprovedPlan } from "./plan-artifact";
import { buildPlan } from "./planner";
import {
  assertDistinctFilePaths,
  assertOutputPathOutsideItems,
  writeJobSummary,
  writePlan,
} from "./reporting";
import type { ActionMode, DeploymentPlan } from "./types";

export async function run(): Promise<void> {
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
    );
    const planFile = core.getInput("plan-file") || "fabric-plan.json";
    const sourceCommit = process.env.GITHUB_SHA || undefined;

    const loadedManifest = loadManifest(manifestPath, {
      variables,
      workspaceIdOverride: workspaceId,
    });
    let plan = buildPlan(loadedManifest, {
      mode: mode === "apply" ? "plan" : mode,
      environment,
      workspaceId,
      sourceCommit,
    });
    let approvedPlan: DeploymentPlan | undefined;
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
          filePath: loadedManifest.manifestPath,
        },
        { label: "Approved plan file", filePath: approvedPlanFile },
        { label: "Current plan file", filePath: planFile },
        { label: "Checkpoint file", filePath: checkpointFile },
        { label: "Result file", filePath: resultFile },
      ]);
      approvedPlan = loadApprovedPlan(approvedPlanFile);
      const itemDirectories = Object.values(loadedManifest.itemDirectories);
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
      const applyStartedAt = Date.now();
      initializeApplyArtifacts(
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
          filePath: loadedManifest.manifestPath,
        },
        { label: "Plan file", filePath: planFile },
      ]);
    }
    let lakehouseAdapter: LakehouseAdapter | undefined;
    let environmentAdapter: EnvironmentAdapter | undefined;
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
      environmentAdapter = new EnvironmentAdapter(client);
      plan = await enrichPlanWithFabric(plan, loadedManifest, {
        lakehouse: lakehouseAdapter,
        environment: environmentAdapter,
      });
    } else if (mode === "apply") {
      throw new Error("apply mode requires Fabric authentication.");
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
      "noop-count",
      String(plan.items.filter((item) => item.action === "no-op").length),
    );
    core.setOutput(
      "unknown-count",
      String(plan.items.filter((item) => item.action === "unknown").length),
    );
    await writeJobSummary(plan);

    if (mode === "apply") {
      if (
        !approvedPlan ||
        !checkpointFile ||
        !resultFile ||
        !lakehouseAdapter ||
        !environmentAdapter
      ) {
        throw new Error("Fabric adapters were not initialized for apply mode.");
      }
      const result = await applyApprovedPlan({
        approvedPlan,
        currentPlan: plan,
        loadedManifest,
        lakehouseAdapter,
        environmentAdapter,
        allowCreate: readBooleanInput("allow-create"),
        allowUpdate: readBooleanInput("allow-update"),
        checkpointFile,
        resultFile,
        itemDirectories: Object.values(loadedManifest.itemDirectories),
      });
      core.setOutput("status", "applied");
      core.setOutput("approved-plan-hash", approvedPlan.planHash);
      core.setOutput(
        "applied-count",
        String(result.items.filter((item) => item.status !== "resumed").length),
      );
      core.setOutput(
        "resumed-count",
        String(result.items.filter((item) => item.status === "resumed").length),
      );
    } else {
      core.setOutput("status", mode === "validate" ? "validated" : "planned");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
