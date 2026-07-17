import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  FabricDefinition,
  FabricDefinitionPart,
} from "./definition";

const PIPELINE_CONTENT_PATH = "pipeline-content.json";

export function loadPipelineDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const contentPath = path.join(
    definitionDirectory,
    PIPELINE_CONTENT_PATH,
  );
  if (!existsSync(contentPath) || !statSync(contentPath).isFile()) {
    throw new Error(
      "Data Pipeline definition must include definition/pipeline-content.json.",
    );
  }

  const platformPath = path.join(definitionDirectory, ".platform");
  const supportedFiles = new Set([
    contentPath,
    ...(existsSync(platformPath) && statSync(platformPath).isFile()
      ? [platformPath]
      : []),
  ]);
  const unsupported = listFiles(definitionDirectory).filter(
    (filePath) => !supportedFiles.has(filePath),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Data Pipeline definition path '${path
        .relative(definitionDirectory, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }

  const parts: FabricDefinitionPart[] = [
    {
      path: PIPELINE_CONTENT_PATH,
      payload: readFileSync(contentPath).toString("base64"),
      payloadType: "InlineBase64",
    },
  ];
  if (supportedFiles.has(platformPath)) {
    parts.push({
      path: ".platform",
      payload: readFileSync(platformPath).toString("base64"),
      payloadType: "InlineBase64",
    });
  }

  const definition = {
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
  validatePipelineDefinition(definition);
  return definition;
}

export function hashPipelineDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
): string {
  validatePipelineDefinition(definition);
  const parts = definition.parts
    .filter((part) => includePlatform || part.path !== ".platform")
    .map((part) => ({
      path: part.path,
      payload: stableJson(parseJsonPart(part)),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(stableJson(parts));
}

export function pipelineIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) => part.path === ".platform");
}

function validatePipelineDefinition(
  definition: FabricDefinition,
): void {
  const contentParts = definition.parts.filter(
    (part) => part.path === PIPELINE_CONTENT_PATH,
  );
  const platformParts = definition.parts.filter(
    (part) => part.path === ".platform",
  );
  if (contentParts.length !== 1) {
    throw new Error(
      "Data Pipeline definition must contain exactly one pipeline-content.json part.",
    );
  }
  if (platformParts.length > 1) {
    throw new Error(
      "Data Pipeline definition must not contain multiple .platform parts.",
    );
  }
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    if (
      part.path !== PIPELINE_CONTENT_PATH &&
      part.path !== ".platform"
    ) {
      throw new Error(
        `Unsupported Data Pipeline definition part '${part.path}'.`,
      );
    }
  }

  parseJsonPart(contentParts[0]!);
  if (platformParts[0]) {
    const platform = parseJsonPart(platformParts[0]);
    if (containsProperty(platform, "sensitivityLabelId")) {
      throw new Error(
        "Data Pipeline .platform sensitivity labels are not supported; manage the label outside the definition deployment.",
      );
    }
  }
}

function parseJsonPart(
  part: FabricDefinitionPart,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(part.payload, "base64").toString("utf8"),
    );
  } catch {
    throw new Error(
      `Data Pipeline definition part '${part.path}' must contain valid JSON.`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `Data Pipeline definition part '${part.path}' must contain a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function containsProperty(
  value: unknown,
  propertyName: string,
): boolean {
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

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile() && statSync(entryPath).isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
