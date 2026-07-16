import * as core from "@actions/core";

import {
  EntraTokenProvider,
  FABRIC_SCOPE,
  type AuthMode,
} from "./fabric/auth";
import { FabricClient } from "./fabric/client";
import { parseFabricEndpoints } from "./fabric/config";
import { LakehouseAdapter } from "./fabric/lakehouse";
import { enrichPlanWithFabric } from "./fabric/live-planner";
import { loadManifest } from "./manifest";
import { buildPlan } from "./planner";
import { writeJobSummary, writePlan } from "./reporting";
import type { ActionMode } from "./types";

export async function run(): Promise<void> {
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

    const loadedManifest = loadManifest(manifestPath, {
      variables,
      workspaceIdOverride: workspaceId,
    });
    let plan = buildPlan(loadedManifest, {
      mode,
      environment,
      workspaceId,
    });
    if (mode === "plan" && authMode !== "none") {
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
      plan = await enrichPlanWithFabric(
        plan,
        loadedManifest,
        new LakehouseAdapter(client),
      );
    }
    const writtenPlanFile = writePlan(
      plan,
      planFile,
      Object.values(loadedManifest.itemDirectories),
    );

    await writeJobSummary(plan);

    core.setOutput("status", mode === "validate" ? "validated" : "planned");
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
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
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
  if (value !== "validate" && value !== "plan") {
    throw new Error(`Unsupported mode '${value}'. Expected 'validate' or 'plan'.`);
  }
  return value;
}

if (require.main === module) {
  void run();
}
