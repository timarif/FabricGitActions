import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import type { DeploymentPlan } from "./types";

export function writePlan(
  plan: DeploymentPlan,
  planFile: string,
  itemDirectories: string[] = [],
): string {
  const absolutePlanPath = path.resolve(planFile);
  assertOutputPathOutsideItems(
    absolutePlanPath,
    itemDirectories,
    "Plan file",
  );

  mkdirSync(path.dirname(absolutePlanPath), { recursive: true });
  writeFileSync(absolutePlanPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return absolutePlanPath;
}

export function assertOutputPathOutsideItems(
  outputPath: string,
  itemDirectories: string[],
  label: string,
): void {
  const absolutePath = path.resolve(outputPath);
  const resolvedPath = resolveFuturePath(absolutePath);
  for (const itemDirectory of itemDirectories) {
    if (isContainedPath(itemDirectory, resolvedPath)) {
      throw new Error(
        `${label} must not be written inside a deployable item directory: ${absolutePath}`,
      );
    }
  }
}

export function assertDistinctFilePaths(
  files: Array<{ label: string; filePath: string }>,
): void {
  const seenPaths = new Map<string, string>();
  const seenFiles = new Map<string, string>();
  for (const file of files) {
    const absolutePath = path.resolve(file.filePath);
    const resolvedPath = resolveFuturePath(absolutePath);
    const pathKey =
      process.platform === "win32" || process.platform === "darwin"
        ? resolvedPath.toLowerCase()
        : resolvedPath;
    const existingPathLabel = seenPaths.get(pathKey);
    if (existingPathLabel) {
      throw new Error(
        `${file.label} must not use the same path as ${existingPathLabel}: ${absolutePath}`,
      );
    }
    seenPaths.set(pathKey, file.label);

    if (existsSync(resolvedPath)) {
      const stats = statSync(resolvedPath);
      if (stats.ino > 0) {
        const fileKey = `${stats.dev}:${stats.ino}`;
        const existingFileLabel = seenFiles.get(fileKey);
        if (existingFileLabel) {
          throw new Error(
            `${file.label} must not reference the same file as ${existingFileLabel}: ${absolutePath}`,
          );
        }
        seenFiles.set(fileKey, file.label);
      }
    }
  }
}

function resolveFuturePath(targetPath: string): string {
  assertNoDanglingSymlinks(targetPath);
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

function assertNoDanglingSymlinks(targetPath: string): void {
  const absolutePath = path.resolve(targetPath);
  const root = path.parse(absolutePath).root;
  const segments = path
    .relative(root, absolutePath)
    .split(path.sep)
    .filter(Boolean);
  let currentPath = root;

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(currentPath);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    if (!stats.isSymbolicLink()) {
      continue;
    }
    try {
      realpathSync(currentPath);
    } catch (error) {
      if (
        isFileSystemError(error, "ENOENT") ||
        isFileSystemError(error, "ELOOP")
      ) {
        throw new Error(
          `Deployment artifact path contains a dangling symbolic link: ${currentPath}`,
        );
      }
      throw error;
    }
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
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
