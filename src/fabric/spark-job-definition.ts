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

const CONFIG_PATH = "SparkJobDefinitionV1.json";
const CONFIG_PROPERTIES = new Set([
  "executableFile",
  "defaultLakehouseArtifactId",
  "mainClass",
  "additionalLakehouseIds",
  "retryPolicy",
  "commandLineArguments",
  "additionalLibraryUris",
  "language",
  "environmentArtifactId",
]);

export function loadSparkJobDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const mainFiles = ["main.py", "main.scala"]
    .map((name) => path.join(definitionDirectory, name))
    .filter(
      (filePath) =>
        existsSync(filePath) && statSync(filePath).isFile(),
    );
  if (mainFiles.length !== 1) {
    throw new Error(
      "Spark Job Definition must include exactly one definition/main.py or definition/main.scala file.",
    );
  }
  const mainFile = mainFiles[0]!;
  const mainName = path.basename(mainFile);
  const language = mainName.endsWith(".scala") ? "Scala" : "Python";
  const libraryDirectory = path.join(definitionDirectory, "libs");
  const libraryFiles = (
    existsSync(libraryDirectory)
      ? listFiles(libraryDirectory)
      : []
  ).sort((left, right) =>
    compareCanonicalStrings(
      path.relative(libraryDirectory, left).replaceAll("\\", "/"),
      path.relative(libraryDirectory, right).replaceAll("\\", "/"),
    ),
  );
  const libraryNames = libraryFiles
    .map((filePath) => path.basename(filePath))
    .sort(compareCanonicalStrings);
  const invalidLibraryNames = libraryNames.filter(
    (name) => !/^[A-Za-z0-9._~-]+$/.test(name),
  );
  if (invalidLibraryNames.length > 0) {
    throw new Error(
      `Spark Job Definition library file names contain unsupported characters: ${invalidLibraryNames.join(", ")}.`,
    );
  }
  const duplicateLibraryNames = findDuplicates(libraryNames);
  if (duplicateLibraryNames.length > 0) {
    throw new Error(
      `Spark Job Definition has duplicate library file names: ${duplicateLibraryNames.join(", ")}.`,
    );
  }
  for (const libraryFile of libraryFiles) {
    if (path.extname(libraryFile).toLowerCase() === ".jar") {
      throw new Error(
        "SparkJobDefinitionV2 does not support inline .jar libraries; use an external abfss:// URI.",
      );
    }
  }

  const configPath = path.join(definitionDirectory, CONFIG_PATH);
  const sourceConfig = existsSync(configPath)
    ? parseJsonObject(readFileSync(configPath, "utf8"), CONFIG_PATH)
    : {};
  assertKnownConfigProperties(sourceConfig);
  const config = buildConfig(
    sourceConfig,
    mainName,
    language,
    libraryNames,
  );
  const parts: FabricDefinitionPart[] = [
    {
      path: CONFIG_PATH,
      payload: Buffer.from(
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      ).toString("base64"),
      payloadType: "InlineBase64",
    },
    {
      path: `Main/${mainName}`,
      payload: readFileSync(mainFile).toString("base64"),
      payloadType: "InlineBase64",
    },
    ...libraryFiles.map((filePath) => ({
      path: `Libs/${path.basename(filePath)}`,
      payload: readFileSync(filePath).toString("base64"),
      payloadType: "InlineBase64" as const,
    })),
  ];
  const platformPath = path.join(definitionDirectory, ".platform");
  if (existsSync(platformPath) && statSync(platformPath).isFile()) {
    parts.push({
      path: ".platform",
      payload: readFileSync(platformPath).toString("base64"),
      payloadType: "InlineBase64",
    });
  }
  assertNoUnsupportedFiles(
    definitionDirectory,
    new Set([
      mainFile,
      ...(existsSync(configPath) ? [configPath] : []),
      ...libraryFiles,
      ...(existsSync(platformPath) ? [platformPath] : []),
    ]),
  );
  validateSparkJobDefinition({ format: "SparkJobDefinitionV2", parts });
  return {
    format: "SparkJobDefinitionV2",
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
}

export function hashSparkJobDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
  options: {
    allowExternalExecutable?: boolean;
  } = {},
): string {
  validateSparkJobDefinition(
    definition,
    options.allowExternalExecutable ?? false,
  );
  const parts = definition.parts
    .filter((part) => includePlatform || part.path !== ".platform")
    .map((part) => ({
      path: part.path,
      payload: canonicalPayload(part),
    }))
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return sha256(stableJson({ format: "SparkJobDefinitionV2", parts }));
}

export function sparkJobIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) => part.path === ".platform");
}

export function sparkJobDefinitionFormat(
  definition: FabricDefinition,
): "SparkJobDefinitionV2" {
  validateSparkJobDefinition(definition);
  return "SparkJobDefinitionV2";
}

function buildConfig(
  source: Record<string, unknown>,
  mainName: string,
  language: "Python" | "Scala",
  libraryNames: string[],
): Record<string, unknown> {
  const executableFile = source.executableFile ?? mainName;
  if (executableFile !== mainName) {
    throw new Error(
      `Spark Job Definition executableFile must be '${mainName}' when the main file is uploaded inline.`,
    );
  }
  const configuredLanguage = source.language ?? language;
  if (configuredLanguage !== language) {
    throw new Error(
      `Spark Job Definition language must be '${language}' for '${mainName}'.`,
    );
  }
  const configuredLibraries =
    source.additionalLibraryUris ?? libraryNames;
  if (!Array.isArray(configuredLibraries)) {
    throw new Error(
      "Spark Job Definition additionalLibraryUris must be an array.",
    );
  }
  const libraryUris = configuredLibraries.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        "Spark Job Definition additionalLibraryUris must contain nonempty strings.",
      );
    }
    return value;
  });
  if (new Set(libraryUris).size !== libraryUris.length) {
    throw new Error(
      "Spark Job Definition additionalLibraryUris must not contain duplicates.",
    );
  }
  for (const libraryName of libraryNames) {
    if (!libraryUris.includes(libraryName)) {
      throw new Error(
        `Spark Job Definition inline library '${libraryName}' is missing from additionalLibraryUris.`,
      );
    }
  }
  for (const value of libraryUris) {
    if (
      !value.startsWith("abfss://") &&
      !libraryNames.includes(value)
    ) {
      throw new Error(
        `Spark Job Definition library '${value}' has no matching definition/libs file.`,
      );
    }
  }

  const additionalLakehouseIds =
    source.additionalLakehouseIds ?? [];
  if (
    !Array.isArray(additionalLakehouseIds) ||
    !additionalLakehouseIds.every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new Error(
      "Spark Job Definition additionalLakehouseIds must be an array of nonempty strings.",
    );
  }
  return {
    executableFile: mainName,
    defaultLakehouseArtifactId:
      readOptionalString(source.defaultLakehouseArtifactId) ?? "",
    mainClass: readOptionalString(source.mainClass) ?? "",
    additionalLakehouseIds,
    retryPolicy: source.retryPolicy ?? null,
    commandLineArguments:
      readOptionalString(source.commandLineArguments) ?? "",
    additionalLibraryUris: libraryUris,
    language,
    environmentArtifactId:
      readNullableString(source.environmentArtifactId),
  };
}

function validateSparkJobDefinition(
  definition: FabricDefinition,
  allowExternalExecutable = false,
): void {
  const format = definition.format ?? "SparkJobDefinitionV2";
  if (format !== "SparkJobDefinitionV2") {
    throw new Error(
      `Unsupported Spark Job Definition format '${format}'.`,
    );
  }
  const configParts = definition.parts.filter(
    (part) => part.path === CONFIG_PATH,
  );
  const mainParts = definition.parts.filter((part) =>
    part.path.startsWith("Main/"),
  );
  if (
    configParts.length !== 1 ||
    mainParts.length > 1 ||
    (!allowExternalExecutable && mainParts.length !== 1)
  ) {
    throw new Error(
      allowExternalExecutable
        ? "SparkJobDefinitionV2 requires one SparkJobDefinitionV1.json part and at most one Main/ part."
        : "SparkJobDefinitionV2 requires one SparkJobDefinitionV1.json part and one Main/ part.",
    );
  }
  const config = parseJsonPart(configParts[0]!, CONFIG_PATH);
  if (mainParts.length === 0) {
    const executableFile = config.executableFile;
    if (
      executableFile !== null &&
      executableFile !== undefined &&
      !(
        typeof executableFile === "string" &&
        executableFile.startsWith("abfss://")
      )
    ) {
      throw new Error(
        "SparkJobDefinitionV2 without a Main/ part requires a null or abfss:// executableFile.",
      );
    }
  }
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    if (
      part.path !== CONFIG_PATH &&
      part.path !== ".platform" &&
      !part.path.startsWith("Main/") &&
      !part.path.startsWith("Libs/")
    ) {
      throw new Error(
        `Unsupported Spark Job Definition part '${part.path}'.`,
      );
    }
  }
  const platform = definition.parts.find(
    (part) => part.path === ".platform",
  );
  if (platform) {
    parseJsonPart(platform, ".platform");
  }
}

function canonicalPayload(part: FabricDefinitionPart): string {
  if (part.path === CONFIG_PATH) {
    return stableJson(
      canonicalSparkConfig(parseJsonPart(part, part.path)),
    );
  }
  if (part.path === ".platform") {
    return stableJson(parseJsonPart(part, part.path));
  }
  const bytes = Buffer.from(part.payload, "base64");
  if (
    part.path.endsWith(".py") ||
    part.path.endsWith(".scala") ||
    part.path.endsWith(".r") ||
    part.path.endsWith(".sql")
  ) {
    return bytes.toString("utf8").replace(/\r\n?/g, "\n");
  }
  return bytes.toString("base64");
}

function canonicalSparkConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...config,
    defaultLakehouseArtifactId: normalizeNullableIdentifier(
      config.defaultLakehouseArtifactId,
    ),
    environmentArtifactId: normalizeNullableIdentifier(
      config.environmentArtifactId,
    ),
  };
}

function normalizeNullableIdentifier(value: unknown): unknown {
  return value === "" || value === undefined ? null : value;
}

function assertKnownConfigProperties(
  config: Record<string, unknown>,
): void {
  const unknown = Object.keys(config).filter(
    (key) => !CONFIG_PROPERTIES.has(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Spark Job Definition config contains unsupported properties: ${unknown.join(", ")}.`,
    );
  }
}

function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      "Spark Job Definition string properties must contain strings.",
    );
  }
  return value;
}

function readNullableString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(
      "Spark Job Definition environmentArtifactId must be a string or null.",
    );
  }
  return value;
}

function parseJsonPart(
  part: FabricDefinitionPart,
  description: string,
): Record<string, unknown> {
  return parseJsonObject(
    Buffer.from(part.payload, "base64").toString("utf8"),
    description,
  );
}

function parseJsonObject(
  value: string,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${description} must contain valid JSON.`);
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(`${description} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function assertNoUnsupportedFiles(
  definitionDirectory: string,
  supportedFiles: Set<string>,
): void {
  const unsupported = listFiles(definitionDirectory).filter(
    (filePath) => !supportedFiles.has(filePath),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Spark Job Definition path '${path
        .relative(definitionDirectory, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }
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
