import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import type { DeploymentPlan } from "./types";

export function writePlan(
  plan: DeploymentPlan,
  planFile: string,
  itemDirectories: string[] = [],
): string {
  const absolutePlanPath = path.resolve(planFile);
  const resolvedPlanPath = resolveFuturePath(absolutePlanPath);
  for (const itemDirectory of itemDirectories) {
    if (isContainedPath(itemDirectory, resolvedPlanPath)) {
      throw new Error(
        `Plan file must not be written inside a deployable item directory: ${absolutePlanPath}`,
      );
    }
  }

  mkdirSync(path.dirname(absolutePlanPath), { recursive: true });
  writeFileSync(absolutePlanPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return absolutePlanPath;
}

function resolveFuturePath(targetPath: string): string {
  const missingSegments: string[] = [];
  let existingAncestor = targetPath;

  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  return path.resolve(realpathSync(existingAncestor), ...missingSegments);
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relativePath = path.relative(realpathSync(parent), candidate);
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`))
  );
}

export async function writeJobSummary(plan: DeploymentPlan): Promise<void> {
  core.summary
    .addHeading("Microsoft Fabric deployment plan")
    .addTable([
      [
        { data: "Deployment", header: true },
        { data: "Environment", header: true },
        { data: "Workspace", header: true },
        { data: "Items", header: true },
      ],
      [
        plan.deploymentId,
        plan.environment,
        plan.workspaceId,
        String(plan.items.length),
      ],
    ])
    .addHeading("Deployment stages", 2);

  plan.stages.forEach((stage, index) => {
    core.summary.addRaw(`${index + 1}. ${stage.join(", ")}\n`);
  });

  core.summary.addHeading("Items", 2).addTable([
    [
      { data: "Logical ID", header: true },
      { data: "Type", header: true },
      { data: "Action", header: true },
      { data: "Reason", header: true },
    ],
    ...plan.items.map((item) => [
      item.logicalId,
      item.type,
      item.action,
      item.reason,
    ]),
  ]);

  await core.summary.write();
}
