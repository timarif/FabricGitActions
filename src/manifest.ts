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
import { loadEnvironmentDefinition } from "./fabric/definition";
import { loadNotebookDefinition } from "./fabric/notebook-definition";
import { loadPipelineDefinition } from "./fabric/pipeline-definition";
import { loadSparkCustomPoolDefinition } from "./fabric/spark-custom-pool-definition";
import { loadSparkJobDefinition } from "./fabric/spark-job-definition";
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
  const environmentDefinitions = Object.fromEntries(
    manifest.items
      .filter((item) => item.type === "Environment")
      .map((item) => [
        item.logicalId,
        loadEnvironmentDefinition(
          itemContent.directories[item.logicalId] ?? "",
        ),
      ]),
  );
  const notebookDefinitions = Object.fromEntries(
    manifest.items
      .filter((item) => item.type === "Notebook")
      .map((item) => [
        item.logicalId,
        loadNotebookDefinition(
          itemContent.directories[item.logicalId] ?? "",
        ),
      ]),
  );
  const sparkCustomPoolDefinitions = Object.fromEntries(
    manifest.items
      .filter((item) => item.type === "SparkCustomPool")
      .map((item) => [
        item.logicalId,
        loadSparkCustomPoolDefinition(
          itemContent.directories[item.logicalId] ?? "",
        ),
      ]),
  );
  const sparkJobDefinitions = Object.fromEntries(
    manifest.items
      .filter((item) => item.type === "SparkJobDefinition")
      .map((item) => [
        item.logicalId,
        loadSparkJobDefinition(
          itemContent.directories[item.logicalId] ?? "",
        ),
      ]),
  );
  const pipelineDefinitions = Object.fromEntries(
    manifest.items
      .filter((item) => item.type === "DataPipeline")
      .map((item) => [
        item.logicalId,
        loadPipelineDefinition(
          itemContent.directories[item.logicalId] ?? "",
        ),
      ]),
  );
  validateEnvironmentPlatformMetadata(
    manifest,
    itemDefinitions,
    environmentDefinitions,
  );
  validateNotebookPlatformMetadata(
    manifest,
    itemDefinitions,
    notebookDefinitions,
  );
  validateSparkJobPlatformMetadata(
    manifest,
    itemDefinitions,
    sparkJobDefinitions,
  );
  validatePipelinePlatformMetadata(
    manifest,
    itemDefinitions,
    pipelineDefinitions,
  );
  assertItemContentUnchanged(
    manifest,
    manifestDirectory,
    itemContent.directories,
    itemContent.hashes,
  );
  validateUniqueDesiredIdentities(manifest, itemDefinitions);
  // Bind the plan to the exact definition bytes retained for apply.
  const effectiveItemHashes = Object.fromEntries(
    manifest.items.map((item) => [
      item.logicalId,
      sha256(
        stableJson({
          fileContentHash: itemContent.hashes[item.logicalId],
          resolvedDefinition: itemDefinitions[item.logicalId],
          capturedEnvironmentDefinition:
            environmentDefinitions[item.logicalId] ?? null,
          capturedNotebookDefinition:
            notebookDefinitions[item.logicalId] ?? null,
          capturedSparkJobDefinition:
            sparkJobDefinitions[item.logicalId] ?? null,
          capturedPipelineDefinition:
            pipelineDefinitions[item.logicalId] ?? null,
          capturedSparkCustomPoolDefinition:
            sparkCustomPoolDefinitions[item.logicalId] ?? null,
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
    environmentDefinitions,
    notebookDefinitions,
    sparkJobDefinitions,
    pipelineDefinitions,
    sparkCustomPoolDefinitions,
  };
}

function validatePipelinePlatformMetadata(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
  pipelineDefinitions: LoadedManifest["pipelineDefinitions"],
): void {
  for (const item of manifest.items) {
    if (item.type !== "DataPipeline") {
      continue;
    }
    const desired = definitions[item.logicalId];
    const fabricDefinition = pipelineDefinitions[item.logicalId];
    const platformPart = fabricDefinition?.parts.find(
      (part) => part.path === ".platform",
    );
    if (!desired || !platformPart) {
      continue;
    }
    validatePlatformMetadata(
      item.logicalId,
      "DataPipeline",
      desired,
      platformPart.payload,
    );
  }
}

function validateSparkJobPlatformMetadata(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
  sparkJobDefinitions: LoadedManifest["sparkJobDefinitions"],
): void {
  for (const item of manifest.items) {
    if (item.type !== "SparkJobDefinition") {
      continue;
    }
    const desired = definitions[item.logicalId];
    const fabricDefinition = sparkJobDefinitions[item.logicalId];
    const platformPart = fabricDefinition?.parts.find(
      (part) => part.path === ".platform",
    );
    if (!desired || !platformPart) {
      continue;
    }
    validatePlatformMetadata(
      item.logicalId,
      "SparkJobDefinition",
      desired,
      platformPart.payload,
    );
  }
}

function validateNotebookPlatformMetadata(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
  notebookDefinitions: LoadedManifest["notebookDefinitions"],
): void {
  for (const item of manifest.items) {
    if (item.type !== "Notebook") {
      continue;
    }
    const desired = definitions[item.logicalId];
    const fabricDefinition = notebookDefinitions[item.logicalId];
    const platformPart = fabricDefinition?.parts.find(
      (part) => part.path === ".platform",
    );
    if (!desired || !platformPart) {
      continue;
    }
    validatePlatformMetadata(
      item.logicalId,
      "Notebook",
      desired,
      platformPart.payload,
    );
  }
}

function validateEnvironmentPlatformMetadata(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
  environmentDefinitions: LoadedManifest["environmentDefinitions"],
): void {
  for (const item of manifest.items) {
    if (item.type !== "Environment") {
      continue;
    }
    const desired = definitions[item.logicalId];
    const fabricDefinition = environmentDefinitions[item.logicalId];
    const platformPart = fabricDefinition?.parts.find(
      (part) => part.path === ".platform",
    );
    if (!desired || !platformPart) {
      continue;
    }
    validatePlatformMetadata(
      item.logicalId,
      "Environment",
      desired,
      platformPart.payload,
    );
  }
}

function validatePlatformMetadata(
  logicalId: string,
  type:
    | "Environment"
    | "SparkCustomPool"
    | "Notebook"
    | "SparkJobDefinition"
    | "DataPipeline",
  desired: LoadedManifest["itemDefinitions"][string],
  payload: string,
): void {
  let platform: unknown;
  try {
    platform = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    );
  } catch {
    throw new Error(
      `${type} item '${logicalId}' has an invalid .platform JSON definition.`,
    );
  }
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  ) {
    throw new Error(
      `${type} item '${logicalId}' .platform definition must be a JSON object.`,
    );
  }
  const metadata = (platform as Record<string, unknown>).metadata;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      `${type} item '${logicalId}' .platform metadata must be a JSON object.`,
    );
  }
  const values = metadata as Record<string, unknown>;
  if (containsProperty(platform, "sensitivityLabelId")) {
    throw new Error(
      `${type} item '${logicalId}' .platform sensitivity labels are not supported; manage the label outside the definition deployment.`,
    );
  }
  if (values.type !== type) {
    throw new Error(
      `${type} item '${logicalId}' .platform metadata.type must be '${type}'.`,
    );
  }
  if (values.displayName !== desired.displayName) {
    throw new Error(
      `${type} item '${logicalId}' .platform displayName must match item.yaml.`,
    );
  }
  if (desired.description === undefined) {
    throw new Error(
      `${type} item '${logicalId}' must define item.yaml description when .platform metadata is managed.`,
    );
  }
  if ((values.description ?? "") !== (desired.description ?? "")) {
    throw new Error(
      `${type} item '${logicalId}' .platform description must match item.yaml.`,
    );
  }
}

function containsProperty(value: unknown, propertyName: string): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) =>
      containsProperty(entry, propertyName),
    );
  }
  const record = value as Record<string, unknown>;
  return (
    Object.hasOwn(record, propertyName) ||
    Object.values(record).some((entry) =>
      containsProperty(entry, propertyName),
    )
  );
}

function validateUniqueDesiredIdentities(
  manifest: DeploymentManifest,
  definitions: LoadedManifest["itemDefinitions"],
): void {
  const identities = new Map<
    | "Lakehouse"
    | "Environment"
    | "SparkCustomPool"
    | "Notebook"
    | "SparkJobDefinition"
    | "DataPipeline",
    Map<string, string>
  >([
    ["Lakehouse", new Map()],
    ["Environment", new Map()],
    ["SparkCustomPool", new Map()],
    ["Notebook", new Map()],
    ["SparkJobDefinition", new Map()],
    ["DataPipeline", new Map()],
  ]);
  for (const item of manifest.items) {
    if (
      item.type !== "Lakehouse" &&
      item.type !== "Environment" &&
      item.type !== "SparkCustomPool" &&
      item.type !== "Notebook" &&
      item.type !== "SparkJobDefinition" &&
      item.type !== "DataPipeline"
    ) {
      continue;
    }
    const definition = definitions[item.logicalId];
    if (!definition) {
      continue;
    }
    const displayName =
      item.type === "SparkCustomPool"
        ? definition.displayName.toLowerCase()
        : definition.displayName;
    const identity = `${definition.folderId ?? "<root>"}\0${displayName}`;
    const itemIdentities = identities.get(item.type)!;
    const existing = itemIdentities.get(identity);
    if (existing) {
      throw new Error(
        `${item.type} items '${existing}' and '${item.logicalId}' resolve to the same folder and displayName.`,
      );
    }
    itemIdentities.set(identity, item.logicalId);
  }
}

function assertItemContentUnchanged(
  manifest: DeploymentManifest,
  manifestDirectory: string,
  directories: Record<string, string>,
  expectedHashes: Record<string, string>,
): void {
  const realManifestDirectory = realpathSync(manifestDirectory);
  for (const item of manifest.items) {
    const directory = directories[item.logicalId];
    const expectedHash = expectedHashes[item.logicalId];
    if (!directory || !expectedHash) {
      throw new Error(
        `Item '${item.logicalId}' content snapshot is incomplete.`,
      );
    }
    const currentHash = hashDirectory(
      directory,
      realManifestDirectory,
      item.logicalId,
    );
    if (currentHash !== expectedHash) {
      throw new Error(
        `Item '${item.logicalId}' changed while the deployment manifest was being loaded. Retry from a stable checkout.`,
      );
    }
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
