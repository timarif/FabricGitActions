import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { compareCanonicalStrings, sha256, stableJson } from "../hash";

export const FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY =
  "spark.fabric.deploy.definitionHash";

export interface FabricDefinitionPart {
  path: string;
  payload: string;
  payloadType: "InlineBase64";
}

export interface FabricDefinition {
  format?: string;
  parts: FabricDefinitionPart[];
}

export function loadEnvironmentDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const files = listFiles(definitionDirectory);
  const parts = files.map((filePath) => ({
    path: environmentPartPath(
      path.relative(definitionDirectory, filePath).replaceAll("\\", "/"),
    ),
    payload: readFileSync(filePath).toString("base64"),
    payloadType: "InlineBase64" as const,
  }));
  const duplicatePaths = findDuplicates(parts.map((part) => part.path));
  if (duplicatePaths.length > 0) {
    throw new Error(
      `Environment definition maps multiple files to: ${duplicatePaths.join(", ")}.`,
    );
  }
  if (
    !parts.some(
      (part) => part.path === "Libraries/PublicLibraries/environment.yml",
    )
  ) {
    throw new Error(
      "Environment definition must include definition/environment.yml.",
    );
  }
  if (
    includesCustomLibraryParts({ parts }) &&
    !includesSparkComputePart({ parts })
  ) {
    throw new Error(
      "Environment definitions with custom libraries must include definition/Sparkcompute.yml so published content can be verified.",
    );
  }
  assertReservedSparkPropertyIsUnused({ parts });
  return {
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
}

export function hashFabricDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
  includeSparkCompute = true,
): string {
  const parts = definition.parts
    .filter(
      (part) =>
        (includePlatform || part.path !== ".platform") &&
        (includeSparkCompute || part.path !== "Setting/Sparkcompute.yml"),
    )
    .map((part) => {
      if (part.payloadType !== "InlineBase64") {
        throw new Error(
          `Unsupported Fabric definition payload type '${part.payloadType}'.`,
        );
      }
      return {
        path: part.path,
        payload: canonicalPayload(part),
      };
    })
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return sha256(stableJson(parts));
}

export function includesPlatformPart(definition: FabricDefinition): boolean {
  return definition.parts.some((part) => part.path === ".platform");
}

export function includesSparkComputePart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) => part.path === "Setting/Sparkcompute.yml",
  );
}

export function includesCustomLibraryParts(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) =>
    part.path.startsWith("Libraries/CustomLibraries/"),
  );
}

export function getFabricDeploymentMarker(
  definition: FabricDefinition,
): string | undefined {
  return includesSparkComputePart(definition)
    ? hashFabricDefinition(definition, true)
    : undefined;
}

export function getEmbeddedFabricDeploymentMarker(
  definition: FabricDefinition,
): string | undefined {
  const sparkPart = definition.parts.find(
    (part) => part.path === "Setting/Sparkcompute.yml",
  );
  if (!sparkPart) {
    return undefined;
  }
  const settings = parseYamlObject(sparkPart);
  const sparkConf = readOptionalRecord(settings.spark_conf, "spark_conf");
  const marker = sparkConf[FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY];
  return typeof marker === "string" ? marker : undefined;
}

export function withFabricDeploymentMarker(
  definition: FabricDefinition,
): FabricDefinition {
  const marker = getFabricDeploymentMarker(definition);
  if (!marker) {
    return definition;
  }
  return withSparkDeploymentProperty(definition, marker);
}

export function withFabricDeploymentMarkerRemoval(
  definition: FabricDefinition,
): FabricDefinition {
  return includesSparkComputePart(definition)
    ? withSparkDeploymentProperty(definition, null)
    : definition;
}

function withSparkDeploymentProperty(
  definition: FabricDefinition,
  value: string | null,
): FabricDefinition {
  return {
    ...definition,
    parts: definition.parts.map((part) => {
      if (part.path !== "Setting/Sparkcompute.yml") {
        return part;
      }
      const settings = parseYamlObject(part);
      const sparkConf = readOptionalRecord(
        settings.spark_conf,
        "spark_conf",
      );
      return {
        ...part,
        payload: Buffer.from(
          stringifyYaml(
            {
              ...settings,
              spark_conf: {
                ...sparkConf,
                [FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY]: value,
              },
            },
            { lineWidth: 0 },
          ),
          "utf8",
        ).toString("base64"),
      };
    }),
  };
}

export function canonicalYaml(value: string): string {
  return stableJson(parseYaml(value));
}

function canonicalPayload(part: FabricDefinitionPart): string {
  const bytes = Buffer.from(part.payload, "base64");
  if (part.path === ".platform") {
    try {
      return stableJson(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new Error("Environment .platform definition is not valid JSON.");
    }
  }
  if (part.path.endsWith(".yml")) {
    const parsed = parseYaml(bytes.toString("utf8"));
    if (
      part.path === "Setting/Sparkcompute.yml" &&
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const settings = {
        ...(parsed as Record<string, unknown>),
      };
      const sparkConf = readOptionalRecord(
        settings.spark_conf,
        "spark_conf",
      );
      const {
        [FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY]: _marker,
        ...managedSparkConf
      } = sparkConf;
      if (Object.keys(managedSparkConf).length > 0) {
        settings.spark_conf = managedSparkConf;
      } else {
        delete settings.spark_conf;
      }
      return stableJson(settings);
    }
    return stableJson(parsed);
  }
  return bytes.toString("base64");
}

function assertReservedSparkPropertyIsUnused(
  definition: FabricDefinition,
): void {
  const sparkPart = definition.parts.find(
    (part) => part.path === "Setting/Sparkcompute.yml",
  );
  if (!sparkPart) {
    return;
  }
  const settings = parseYamlObject(sparkPart);
  const sparkConf = readOptionalRecord(settings.spark_conf, "spark_conf");
  if (Object.hasOwn(sparkConf, FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY)) {
    throw new Error(
      `Spark property '${FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY}' is reserved for deployment verification.`,
    );
  }
}

function parseYamlObject(
  part: FabricDefinitionPart,
): Record<string, unknown> {
  const parsed = parseYaml(
    Buffer.from(part.payload, "base64").toString("utf8"),
  );
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Environment definition part '${part.path}' must contain a YAML object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function readOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Environment Spark setting '${field}' must be an object.`);
  }
  return value as Record<string, unknown>;
}

function environmentPartPath(relativePath: string): string {
  const normalized = relativePath.replace(/^\.\/+/, "");
  const lower = normalized.toLowerCase();
  const customLibrary = /^libraries\/customlibraries\/([^/]+)$/i.exec(
    normalized,
  );
  const mapped =
    lower === "environment.yml"
      ? "Libraries/PublicLibraries/environment.yml"
      : lower === "sparkcompute.yml"
        ? "Setting/Sparkcompute.yml"
        : customLibrary
          ? `Libraries/CustomLibraries/${customLibrary[1]}`
          : normalized;
  if (!isSupportedEnvironmentPart(mapped)) {
    throw new Error(
      `Unsupported Environment definition path '${relativePath}'.`,
    );
  }
  return mapped;
}

function isSupportedEnvironmentPart(partPath: string): boolean {
  return (
    partPath === ".platform" ||
    partPath === "Libraries/PublicLibraries/environment.yml" ||
    partPath === "Setting/Sparkcompute.yml" ||
    /^Libraries\/CustomLibraries\/[^/]+\.(?:jar|py|whl|tar\.gz)$/i.test(
      partPath,
    )
  );
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

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort(compareCanonicalStrings);
}
