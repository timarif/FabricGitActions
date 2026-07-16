import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

import { compareCanonicalStrings, sha256, stableJson } from "./hash";
import { loadAndValidateItemDefinition } from "./item-definition";
import { deploymentSchema } from "./schema";
import { substituteVariables } from "./substitution";
import type { DeploymentManifest, LoadedManifest } from "./types";

export interface LoadManifestOptions {
  variables?: Record<string, string>;
  workspaceIdOverride?: string;
}

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function loadManifest(
  manifestPath: string,
  options: LoadManifestOptions = {},
): LoadedManifest {
  const absoluteManifestPath = path.resolve(manifestPath);
  if (!existsSync(absoluteManifestPath)) {
    throw new Error(`Deployment manifest not found: ${absoluteManifestPath}`);
  }

  const source = readFileSync(absoluteManifestPath, "utf8");
  const parsed = parse(source) as unknown;
  applyWorkspaceOverride(parsed, options.workspaceIdOverride);
  const resolved = substituteVariables(parsed, options.variables ?? {});

  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(deploymentSchema);
  if (!validate(resolved)) {
    throw new Error(`Invalid deployment manifest: ${formatValidationErrors(validate.errors)}`);
  }

  const manifest = resolved as DeploymentManifest;
  validateLogicalIds(manifest);
  validateDependencies(manifest);

  const manifestDirectory = path.dirname(absoluteManifestPath);
  const itemContent = validateAndHashItemPaths(manifest, manifestDirectory);
  const logicalIds = new Set(manifest.items.map((item) => item.logicalId));
  const itemDefinitions = Object.fromEntries(
    manifest.items.map((item) => [
      item.logicalId,
      loadAndValidateItemDefinition(
        item,
        itemContent.directories[item.logicalId] ?? "",
        logicalIds,
        new Set(item.dependsOn ?? []),
        options.variables ?? {},
      ),
    ]),
  );
  validateUniqueDesiredIdentities(manifest, itemDefinitions);
  const effectiveItemHashes = Object.fromEntries(
    manifest.items.map((item) => [
      item.logicalId,
      sha256(
        stableJson({
          fileContentHash: itemContent.hashes[item.logicalId],
          resolvedDefinition: itemDefinitions[item.logicalId],
        }),
      ),
    ]),
  );

  return {
    manifest,
    manifestPath: absoluteManifestPath,
    manifestDirectory,
    sourceHash: sha256(source),
    resolvedHash: sha256(stableJson(resolved)),
    itemContentHashes: effectiveItemHashes,
    itemDirectories: itemContent.directories,
    itemDefinitions,
  };
}

function validateUniqueDesiredIdentities(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
): void {
  const lakehouseIdentities = new Map<string, string>();
  for (const item of manifest.items) {
    if (item.type !== "Lakehouse") {
      continue;
    }
    const definition = definitions[item.logicalId];
    if (!definition) {
      continue;
    }
    const identity = `${definition.folderId ?? "<root>"}\0${definition.displayName}`;
    const existing = lakehouseIdentities.get(identity);
    if (existing) {
      throw new Error(
        `Lakehouse items '${existing}' and '${item.logicalId}' resolve to the same folder and displayName.`,
      );
    }
    lakehouseIdentities.set(identity, item.logicalId);
  }
}

function applyWorkspaceOverride(parsed: unknown, workspaceIdOverride?: string): void {
  if (!workspaceIdOverride || parsed === null || typeof parsed !== "object") {
    return;
  }

  const root = parsed as Record<string, unknown>;
  const workspace =
    root.workspace !== null && typeof root.workspace === "object"
      ? (root.workspace as Record<string, unknown>)
      : {};
  workspace.id = workspaceIdOverride;
  root.workspace = workspace;
}

function validateLogicalIds(manifest: DeploymentManifest): void {
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (seen.has(item.logicalId)) {
      throw new Error(`Duplicate logicalId '${item.logicalId}'.`);
    }
    seen.add(item.logicalId);
  }
}

function validateDependencies(manifest: DeploymentManifest): void {
  const logicalIds = new Set(manifest.items.map((item) => item.logicalId));
  for (const item of manifest.items) {
    for (const dependency of item.dependsOn ?? []) {
      if (dependency === item.logicalId) {
        throw new Error(`Item '${item.logicalId}' cannot depend on itself.`);
      }
      if (!logicalIds.has(dependency)) {
        throw new Error(
          `Item '${item.logicalId}' depends on unknown logicalId '${dependency}'.`,
        );
      }
    }
  }
}

function validateAndHashItemPaths(
  manifest: DeploymentManifest,
  manifestDirectory: string,
): {
  hashes: Record<string, string>;
  directories: Record<string, string>;
} {
  const hashes: Record<string, string> = {};
  const directories: Record<string, string> = {};
  const directoryOwners = new Map<string, string>();
  const realManifestDirectory = realpathSync(manifestDirectory);

  for (const item of manifest.items) {
    const itemPath = path.resolve(manifestDirectory, item.path);
    const relativePath = path.relative(manifestDirectory, itemPath);
    if (
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`Item '${item.logicalId}' path escapes the manifest directory.`);
    }
    if (!existsSync(itemPath) || !statSync(itemPath).isDirectory()) {
      throw new Error(`Item '${item.logicalId}' directory not found: ${itemPath}`);
    }

    const realItemPath = realpathSync(itemPath);
    if (!isContainedPath(realManifestDirectory, realItemPath)) {
      throw new Error(
        `Item '${item.logicalId}' path resolves outside the manifest directory.`,
      );
    }
    const existingOwner = directoryOwners.get(realItemPath);
    if (existingOwner) {
      throw new Error(
        `Items '${existingOwner}' and '${item.logicalId}' use the same item directory.`,
      );
    }
    directoryOwners.set(realItemPath, item.logicalId);

    hashes[item.logicalId] = hashDirectory(
      realItemPath,
      realManifestDirectory,
      item.logicalId,
    );
    directories[item.logicalId] = realItemPath;
  }

  return { hashes, directories };
}

function hashDirectory(
  directory: string,
  allowedRoot: string,
  logicalId: string,
): string {
  const hash = createHash("sha256");
  const files: Array<{ relativePath: string; absolutePath: string }> = [];
  collectFiles(directory, directory, allowedRoot, logicalId, files);

  for (const file of files.sort((left, right) =>
    compareCanonicalStrings(left.relativePath, right.relativePath),
  )) {
    const normalizedPath = file.relativePath.replaceAll(path.sep, "/");
    const pathBytes = Buffer.from(normalizedPath, "utf8");
    const contentDigest = createHash("sha256")
      .update(readFileSync(file.absolutePath))
      .digest();
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(pathBytes.length);

    hash.update(pathLength);
    hash.update(pathBytes);
    hash.update(contentDigest);
  }

  return hash.digest("hex");
}

function collectFiles(
  directory: string,
  itemRoot: string,
  allowedRoot: string,
  logicalId: string,
  files: Array<{ relativePath: string; absolutePath: string }>,
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Item '${logicalId}' contains a symbolic link or junction.`);
    }

    const realPath = realpathSync(absolutePath);
    if (!isContainedPath(allowedRoot, realPath)) {
      throw new Error(`Item '${logicalId}' contains content outside the deployment root.`);
    }

    if (stats.isDirectory()) {
      collectFiles(realPath, itemRoot, allowedRoot, logicalId, files);
    } else if (stats.isFile()) {
      files.push({
        relativePath: path.relative(itemRoot, realPath),
        absolutePath: realPath,
      });
    } else {
      throw new Error(`Item '${logicalId}' contains an unsupported filesystem entry.`);
    }
  }
}

function isContainedPath(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath === "" ||
    (!path.isAbsolute(relativePath) &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${path.sep}`))
  );
}
