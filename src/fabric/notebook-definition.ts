import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  FabricDefinition,
  FabricDefinitionPart,
} from "./definition";

const FABRIC_GIT_EXTENSIONS = new Set([
  ".py",
  ".r",
  ".scala",
  ".sql",
]);

export function loadNotebookDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const files = listFiles(definitionDirectory);
  const contentFiles = files.filter((filePath) =>
    isNotebookContentExtension(path.extname(filePath).toLowerCase()),
  );
  if (contentFiles.length !== 1) {
    throw new Error(
      "Notebook definition must include exactly one .py, .scala, .r, .sql, or .ipynb content file.",
    );
  }
  const platformFiles = files.filter(
    (filePath) => path.basename(filePath).toLowerCase() === ".platform",
  );
  if (platformFiles.length > 1) {
    throw new Error(
      "Notebook definition must not contain multiple .platform files.",
    );
  }

  const supportedFiles = new Set([
    contentFiles[0]!,
    ...platformFiles,
  ]);
  const unsupported = files.filter(
    (filePath) => !supportedFiles.has(filePath),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Notebook definition path '${path
        .relative(definitionDirectory, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }

  const extension = path.extname(contentFiles[0]!).toLowerCase();
  const format = extension === ".ipynb" ? "ipynb" : "fabricGitSource";
  const parts: FabricDefinitionPart[] = [
    {
      path: `notebook-content${extension}`,
      payload: readFileSync(contentFiles[0]!).toString("base64"),
      payloadType: "InlineBase64",
    },
  ];
  const platformFile = platformFiles[0];
  if (platformFile) {
    parts.push({
      path: ".platform",
      payload: readFileSync(platformFile).toString("base64"),
      payloadType: "InlineBase64",
    });
  }
  validateNotebookDefinition({
    format,
    parts,
  });
  return {
    format,
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
}

export function hashNotebookDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
): string {
  validateNotebookDefinition(definition);
  const format = normalizeNotebookFormat(definition);
  const parts = definition.parts
    .filter((part) => includePlatform || part.path !== ".platform")
    .map((part) => ({
      path: canonicalNotebookPartPath(part.path, format),
      payload: canonicalNotebookPayload(part, format),
    }))
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return sha256(stableJson({ format, parts }));
}

export function notebookIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) => part.path === ".platform");
}

export function notebookDefinitionFormat(
  definition: FabricDefinition,
): "fabricGitSource" | "ipynb" {
  return normalizeNotebookFormat(definition);
}

function validateNotebookDefinition(definition: FabricDefinition): void {
  const format = normalizeNotebookFormat(definition);
  const contentParts = definition.parts.filter(
    (part) => part.path !== ".platform",
  );
  if (contentParts.length !== 1) {
    throw new Error(
      "Notebook definition must contain exactly one content part.",
    );
  }
  const contentExtension = path
    .extname(contentParts[0]!.path)
    .toLowerCase();
  if (
    (format === "ipynb" && contentExtension !== ".ipynb") ||
    (format === "fabricGitSource" &&
      !FABRIC_GIT_EXTENSIONS.has(contentExtension))
  ) {
    throw new Error(
      `Notebook definition format '${format}' does not match content path '${contentParts[0]!.path}'.`,
    );
  }
  const platformParts = definition.parts.filter(
    (part) => part.path === ".platform",
  );
  if (platformParts.length > 1) {
    throw new Error(
      "Notebook definition must not contain multiple .platform parts.",
    );
  }
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
  }
  if (format === "ipynb") {
    parseJsonObject(contentParts[0]!, "Notebook content");
  }
  if (platformParts[0]) {
    parseJsonObject(platformParts[0], "Notebook .platform");
  }
}

function normalizeNotebookFormat(
  definition: FabricDefinition,
): "fabricGitSource" | "ipynb" {
  const contentPart = definition.parts.find(
    (part) => part.path !== ".platform",
  );
  const inferredFormat =
    contentPart &&
    path.extname(contentPart.path).toLowerCase() === ".ipynb"
      ? "ipynb"
      : "fabricGitSource";
  const format = definition.format ?? inferredFormat;
  if (format !== "fabricGitSource" && format !== "ipynb") {
    throw new Error(`Unsupported Notebook definition format '${format}'.`);
  }
  return format;
}

function canonicalNotebookPartPath(
  partPath: string,
  format: "fabricGitSource" | "ipynb",
): string {
  if (partPath === ".platform") {
    return partPath;
  }
  const extension = path.extname(partPath).toLowerCase();
  if (
    (format === "ipynb" && extension !== ".ipynb") ||
    (format === "fabricGitSource" &&
      !FABRIC_GIT_EXTENSIONS.has(extension))
  ) {
    throw new Error(`Unsupported Notebook definition path '${partPath}'.`);
  }
  return `notebook-content${extension}`;
}

function canonicalNotebookPayload(
  part: FabricDefinitionPart,
  format: "fabricGitSource" | "ipynb",
): string {
  const content = Buffer.from(part.payload, "base64").toString("utf8");
  if (part.path === ".platform" || format === "ipynb") {
    return stableJson(parseJsonObject(part, "Notebook definition"));
  }
  return content.replace(/\r\n?/g, "\n");
}

function parseJsonObject(
  part: FabricDefinitionPart,
  description: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(part.payload, "base64").toString("utf8"),
    );
  } catch {
    throw new Error(`${description} is not valid JSON.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function isNotebookContentExtension(extension: string): boolean {
  return extension === ".ipynb" || FABRIC_GIT_EXTENSIONS.has(extension);
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile() && statSync(entryPath).isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
