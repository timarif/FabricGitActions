import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "../hash";
import type {
  FabricDefinition,
  FabricDefinitionPart,
} from "./definition";

const DEFINITION_PROPERTIES_PATH = "definition.pbism";
const MODEL_BIM_PATH = "model.bim";
const DIAGRAM_LAYOUT_PATH = "diagramLayout.json";
const PLATFORM_PATH = ".platform";
const TMDL_DIRECTORY = "definition";
const COPILOT_DIRECTORY = "Copilot";

const PBISM_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/semanticModel\/definitionProperties\/1\.[0-9]+\.[0-9]+\/schema\.json$/;
const PBISM_SCHEMA_EXAMPLE =
  "https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json";
const PLATFORM_SCHEMA_URL =
  "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json";

/** Safe file extensions accepted under the Copilot/ auxiliary folder. */
const SAFE_COPILOT_EXTENSIONS = new Set([".json", ".md"]);

/** UUID pattern used to validate .platform config.logicalId values. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export type SemanticModelDefinitionFormat = "TMDL" | "TMSL";

export function loadSemanticModelDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  if (
    !existsSync(definitionDirectory) ||
    !statSync(definitionDirectory).isDirectory()
  ) {
    throw new Error(
      "Semantic Model definition must include a definition directory.",
    );
  }

  const parts = listFiles(definitionDirectory).map((filePath) => {
    const relativePath = path
      .relative(definitionDirectory, filePath)
      .replaceAll("\\", "/");
    return {
      path: canonicalSemanticModelPartPath(relativePath),
      payload: readFileSync(filePath).toString("base64"),
      payloadType: "InlineBase64" as const,
    };
  });
  const format = inferSemanticModelDefinitionFormat(parts);
  const definition: FabricDefinition = {
    format,
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
  validateSemanticModelDefinition(definition);
  // Additional validations for user-authored desired definitions only.
  validateDesiredPbism(definition);
  validateDesiredPlatformV2(definition);
  return definition;
}

export function hashSemanticModelDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
  includeDiagramLayout: boolean,
  includeCopilot = false,
): string {
  validateSemanticModelDefinition(definition);
  const format = semanticModelDefinitionFormat(definition);
  const parts = definition.parts
    .map((part) => ({
      part,
      path: canonicalSemanticModelPartPath(part.path),
    }))
    .filter(
      ({ path: partPath }) =>
        (includePlatform || partPath !== PLATFORM_PATH) &&
        (includeDiagramLayout || partPath !== DIAGRAM_LAYOUT_PATH) &&
        (includeCopilot || !isCopilotPart(partPath)),
    )
    .map(({ part, path: partPath }) => ({
      path: partPath,
      payload: isTextSemanticModelPart(partPath)
        ? decodePart(part).replace(/\r\n?/g, "\n")
        : canonicalSemanticModelJsonPayload(partPath, part),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(stableJson({ format, parts }));
}

export function semanticModelDefinitionFormat(
  definition: FabricDefinition,
): SemanticModelDefinitionFormat {
  const inferred = inferSemanticModelDefinitionFormat(
    definition.parts,
  );
  const format = definition.format ?? inferred;
  if (format !== "TMDL" && format !== "TMSL") {
    throw new Error(
      `Unsupported Semantic Model definition format '${format}'.`,
    );
  }
  if (format !== inferred) {
    throw new Error(
      `Semantic Model definition format '${format}' does not match its definition parts.`,
    );
  }
  return format;
}

export function semanticModelIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) =>
      canonicalSemanticModelPartPath(part.path) === PLATFORM_PATH,
  );
}

export function semanticModelIncludesDiagramLayoutPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) =>
      canonicalSemanticModelPartPath(part.path) ===
      DIAGRAM_LAYOUT_PATH,
  );
}

export function semanticModelIncludesCopilotParts(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) =>
    isCopilotPart(canonicalSemanticModelPartPath(part.path)),
  );
}

/**
 * Extracts the `config.logicalId` UUID from a definition's `.platform` part.
 * Returns `undefined` if the part is absent, malformed, or lacks a valid UUID.
 */
export function semanticModelPlatformLogicalId(
  definition: FabricDefinition,
): string | undefined {
  const platformPart = definition.parts.find(
    (part) =>
      canonicalSemanticModelPartPath(part.path) === PLATFORM_PATH,
  );
  if (!platformPart) {
    return undefined;
  }
  let platform: unknown;
  try {
    platform = JSON.parse(decodePart(platformPart));
  } catch {
    return undefined;
  }
  if (
    platform === null ||
    typeof platform !== "object" ||
    Array.isArray(platform)
  ) {
    return undefined;
  }
  const config = (platform as Record<string, unknown>).config;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    return undefined;
  }
  const logicalId = (config as Record<string, unknown>).logicalId;
  if (typeof logicalId !== "string" || !UUID_PATTERN.test(logicalId)) {
    return undefined;
  }
  return logicalId.toLowerCase();
}

/**
 * Returns the auxiliary parts of a definition: `.platform`, `diagramLayout.json`,
 * and any `Copilot/**` parts. These are the parts preserved during a full-replacement
 * update when the desired definition omits them.
 */
export function auxiliarySemanticModelParts(
  definition: FabricDefinition,
): FabricDefinitionPart[] {
  return definition.parts.filter((part) => {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalSemanticModelPartPath(part.path);
    } catch {
      return false;
    }
    return isAuxiliarySemanticModelPath(canonicalPath);
  });
}

/**
 * Produces a canonical hash of a set of auxiliary parts (`.platform`,
 * `diagramLayout.json`, `Copilot/**`), suitable for interrupted-update recovery
 * proof that preserved parts were not lost.
 */
export function hashAuxiliarySemanticModelParts(
  parts: readonly FabricDefinitionPart[],
): string {
  const canonical = parts
    .map((part) => {
      const canonicalPath = canonicalSemanticModelPartPath(part.path);
      const payload = isTextSemanticModelPart(canonicalPath)
        ? decodePart(part).replace(/\r\n?/g, "\n")
        : stableJson(
            canonicalAuxiliaryJsonValue(
              canonicalPath,
              parseJsonObjectPart(part),
            ),
          );
      return { path: canonicalPath, payload };
    })
    .sort((a, b) => compareCanonicalStrings(a.path, b.path));
  return sha256(stableJson(canonical));
}

/**
 * Builds the effective definition to send to `updateDefinition`.
 *
 * The update API is a full replacement: it erases all current parts and
 * replaces them with the submitted definition. To avoid losing service- or
 * user-managed auxiliary state (`.platform`, `diagramLayout.json`,
 * `Copilot/**`), this function merges the desired definition with any
 * auxiliary parts currently on the service that the desired definition omits.
 *
 * Core parts (`definition.pbism`, `model.bim`, `definition/**\/*.tmdl`) are
 * always taken exclusively from `desired`; stale cross-format core parts are
 * not preserved.
 */
export function buildEffectiveSemanticModelDefinition(
  desired: FabricDefinition,
  current: FabricDefinition,
): FabricDefinition {
  const desiredPaths = new Set(
    desired.parts.map((p) =>
      canonicalSemanticModelPartPath(p.path),
    ),
  );

  const preservedParts: FabricDefinitionPart[] = [];
  for (const part of current.parts) {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalSemanticModelPartPath(part.path);
    } catch {
      // Service returned an unknown path — skip rather than propagate.
      continue;
    }
    if (
      isAuxiliarySemanticModelPath(canonicalPath) &&
      !desiredPaths.has(canonicalPath)
    ) {
      preservedParts.push({ ...part, path: canonicalPath });
    }
  }

  const effectiveParts = [
    ...desired.parts.map((p) => ({
      ...p,
      path: canonicalSemanticModelPartPath(p.path),
    })),
    ...preservedParts,
  ].sort((a, b) => compareCanonicalStrings(a.path, b.path));

  return {
    format: desired.format,
    parts: effectiveParts,
  };
}

function validateSemanticModelDefinition(
  definition: FabricDefinition,
): void {
  const canonicalParts = definition.parts.map((part) => ({
    part,
    path: canonicalSemanticModelPartPath(part.path),
  }));
  const duplicatePaths = findDuplicates(
    canonicalParts.map(({ path: partPath }) => partPath),
  );
  if (duplicatePaths.length > 0) {
    throw new Error(
      `Semantic Model definition contains duplicate canonical paths: ${duplicatePaths.join(", ")}.`,
    );
  }
  for (const { part } of canonicalParts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
  }

  const definitionProperties = canonicalParts.filter(
    ({ path: partPath }) =>
      partPath === DEFINITION_PROPERTIES_PATH,
  );
  if (definitionProperties.length !== 1) {
    throw new Error(
      "Semantic Model definition must contain exactly one definition.pbism part.",
    );
  }
  const modelParts = canonicalParts.filter(
    ({ path: partPath }) => partPath === MODEL_BIM_PATH,
  );
  const tmdlParts = canonicalParts.filter(({ path: partPath }) =>
    isTmdlPart(partPath),
  );
  if (modelParts.length > 0 && tmdlParts.length > 0) {
    throw new Error(
      "Semantic Model definition must not mix TMSL model.bim and TMDL definition/*.tmdl parts.",
    );
  }

  const format = semanticModelDefinitionFormat(definition);
  if (format === "TMSL" && modelParts.length !== 1) {
    throw new Error(
      "TMSL Semantic Model definition must contain exactly one model.bim part.",
    );
  }
  if (format === "TMDL" && tmdlParts.length === 0) {
    throw new Error(
      "TMDL Semantic Model definition must contain one or more definition/**/*.tmdl parts.",
    );
  }

  for (const { part, path: partPath } of canonicalParts) {
    // Skip TMDL and plain-text auxiliary parts (e.g. Copilot/*.md).
    if (isTmdlPart(partPath) || isTextSemanticModelPart(partPath)) {
      continue;
    }
    const value = parseJsonObjectPart(part);
    if (
      partPath === PLATFORM_PATH &&
      containsSensitivityLabelDeclaration(value)
    ) {
      throw new Error(
        "Semantic Model .platform sensitivity labels are not supported; manage the label outside the definition deployment.",
      );
    }
  }
}

function inferSemanticModelDefinitionFormat(
  parts: readonly FabricDefinitionPart[],
): SemanticModelDefinitionFormat {
  const canonicalPaths = parts.map((part) =>
    canonicalSemanticModelPartPath(part.path),
  );
  const hasModel = canonicalPaths.includes(MODEL_BIM_PATH);
  const hasTmdl = canonicalPaths.some(isTmdlPart);
  if (hasModel && hasTmdl) {
    throw new Error(
      "Semantic Model definition must not mix TMSL model.bim and TMDL definition/*.tmdl parts.",
    );
  }
  if (hasModel) {
    return "TMSL";
  }
  if (hasTmdl) {
    return "TMDL";
  }
  throw new Error(
    "Semantic Model definition must include model.bim for TMSL or one or more definition/**/*.tmdl files for TMDL.",
  );
}

function canonicalSemanticModelPartPath(partPath: string): string {
  const normalized = partPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(
      `Unsupported Semantic Model definition path '${partPath}'.`,
    );
  }
  const lower = normalized.toLowerCase();
  if (lower === DEFINITION_PROPERTIES_PATH.toLowerCase()) {
    return DEFINITION_PROPERTIES_PATH;
  }
  if (lower === MODEL_BIM_PATH.toLowerCase()) {
    return MODEL_BIM_PATH;
  }
  if (lower === DIAGRAM_LAYOUT_PATH.toLowerCase()) {
    return DIAGRAM_LAYOUT_PATH;
  }
  if (lower === PLATFORM_PATH) {
    return PLATFORM_PATH;
  }

  const segments = normalized.split("/");

  // Copilot auxiliary folder: accept safe JSON and Markdown paths.
  if (segments[0]?.toLowerCase() === COPILOT_DIRECTORY.toLowerCase()) {
    if (segments.length < 2 || segments[1] === "") {
      throw new Error(
        `Unsupported Semantic Model definition path '${partPath}'.`,
      );
    }
    const lastSegment = segments.at(-1)!;
    const ext = path.extname(lastSegment).toLowerCase();
    if (!SAFE_COPILOT_EXTENSIONS.has(ext)) {
      throw new Error(
        `Unsupported Semantic Model definition path '${partPath}'.`,
      );
    }
    return [COPILOT_DIRECTORY, ...segments.slice(1)].join("/");
  }

  if (
    segments.length >= 2 &&
    segments[0]?.toLowerCase() === TMDL_DIRECTORY &&
    segments.at(-1)?.toLowerCase().endsWith(".tmdl")
  ) {
    return [
      TMDL_DIRECTORY,
      ...segments.slice(1, -1),
      `${path.basename(segments.at(-1)!, path.extname(segments.at(-1)!))}.tmdl`,
    ].join("/");
  }
  throw new Error(
    `Unsupported Semantic Model definition path '${partPath}'.`,
  );
}

function isTmdlPart(partPath: string): boolean {
  return (
    partPath.startsWith(`${TMDL_DIRECTORY}/`) &&
    partPath.endsWith(".tmdl")
  );
}

function isCopilotPart(partPath: string): boolean {
  return partPath.startsWith(`${COPILOT_DIRECTORY}/`);
}

/** Returns true for parts that are hashed as plain text (TMDL and Copilot markdown). */
function isTextSemanticModelPart(canonicalPath: string): boolean {
  if (isTmdlPart(canonicalPath)) {
    return true;
  }
  if (isCopilotPart(canonicalPath) && canonicalPath.endsWith(".md")) {
    return true;
  }
  return false;
}

function isAuxiliarySemanticModelPath(canonicalPath: string): boolean {
  return (
    canonicalPath === PLATFORM_PATH ||
    canonicalPath === DIAGRAM_LAYOUT_PATH ||
    isCopilotPart(canonicalPath)
  );
}

function parseJsonObjectPart(
  part: FabricDefinitionPart,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodePart(part));
  } catch {
    throw new Error(
      `Semantic Model definition part '${part.path}' must contain valid JSON.`,
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(
      `Semantic Model definition part '${part.path}' must contain a JSON object.`,
    );
  }
  return value as Record<string, unknown>;
}

function canonicalSemanticModelJsonPayload(
  canonicalPath: string,
  part: FabricDefinitionPart,
): string {
  const value = parseJsonObjectPart(part);
  if (canonicalPath === DEFINITION_PROPERTIES_PATH) {
    return stableJson({
      ...value,
      // Fabric currently normalizes supported PBISM versions on import.
      // The settings carry the desired behavior; the serialization version
      // itself is not a stable service-side property.
      version: "<service-normalized>",
    });
  }
  if (canonicalPath === MODEL_BIM_PATH) {
    return stableJson(removeEmptyArrayProperties(value));
  }
  return stableJson(value);
}

function removeEmptyArrayProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeEmptyArrayProperties);
  }
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([, entryValue]) =>
          !(
            Array.isArray(entryValue) &&
            entryValue.length === 0
          ),
      )
      .map(([key, entryValue]) => [
        key,
        removeEmptyArrayProperties(entryValue),
      ]),
  );
}

function canonicalAuxiliaryJsonValue(
  canonicalPath: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (canonicalPath !== PLATFORM_PATH) {
    return value;
  }
  const metadata = value.metadata;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    return value;
  }
  const normalizedMetadata = {
    ...(metadata as Record<string, unknown>),
  };
  delete normalizedMetadata.displayName;
  delete normalizedMetadata.description;
  return {
    ...value,
    metadata: normalizedMetadata,
  };
}

function decodePart(part: FabricDefinitionPart): string {
  return Buffer.from(part.payload, "base64").toString("utf8");
}

function containsSensitivityLabelDeclaration(
  value: unknown,
): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsSensitivityLabelDeclaration);
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      key.toLowerCase().startsWith("sensitivitylabel") ||
      containsSensitivityLabelDeclaration(entry),
  );
}

/**
 * Validates definition.pbism for user-authored (desired) definitions.
 * Enforces the documented 1.x $schema family, a strict version string, and
 * format compatibility: version 1.0 is TMSL-only; version ≥ 4.0 supports both;
 * versions 2.x and 3.x are not supported.
 */
function validateDesiredPbism(definition: FabricDefinition): void {
  const pbismPart = definition.parts.find(
    (p) => p.path === DEFINITION_PROPERTIES_PATH,
  );
  if (!pbismPart) {
    return; // Already caught by validateSemanticModelDefinition.
  }
  const pbism = parseJsonObjectPart(pbismPart);

  if (typeof pbism.$schema !== "string" || pbism.$schema === "") {
    throw new Error(
      `Semantic Model definition.pbism must include a '$schema' string. Expected: ${PBISM_SCHEMA_EXAMPLE}`,
    );
  }
  if (!PBISM_SCHEMA_PATTERN.test(pbism.$schema)) {
    throw new Error(
      `Semantic Model definition.pbism '$schema' must use the documented 1.x schema family, for example '${PBISM_SCHEMA_EXAMPLE}'.`,
    );
  }
  if (typeof pbism.version !== "string" || pbism.version === "") {
    throw new Error(
      "Semantic Model definition.pbism must include a 'version' string.",
    );
  }

  const versionMatch = /^([0-9]+)\.([0-9]+)$/.exec(
    pbism.version,
  );
  if (!versionMatch) {
    throw new Error(
      `Semantic Model definition.pbism 'version' value '${pbism.version}' is not a valid version number.`,
    );
  }
  const majorVersion = Number(versionMatch[1]);
  const minorVersion = Number(versionMatch[2]);

  if (
    majorVersion <= 0 ||
    (majorVersion === 1 && minorVersion !== 0)
  ) {
    throw new Error(
      `Semantic Model definition.pbism 'version' '${pbism.version}' is not supported.`,
    );
  }
  if (majorVersion >= 2 && majorVersion <= 3) {
    throw new Error(
      `Semantic Model definition.pbism 'version' '${pbism.version}' is not supported. Use version 1.0 for TMSL or 4.0+ for TMSL/TMDL.`,
    );
  }
  // Version 1.0: TMSL-only.
  if (majorVersion === 1) {
    const format = semanticModelDefinitionFormat(definition);
    if (format === "TMDL") {
      throw new Error(
        `Semantic Model definition.pbism 'version' '${pbism.version}' does not support TMDL. Use version 4.0 or higher for TMDL.`,
      );
    }
  }
  // Version 4.0+: both TMSL and TMDL are supported — no additional restriction.
}

/**
 * Validates the v2 `.platform` structure for user-authored Semantic Models.
 * Current Microsoft documentation shows the version at the top level, while
 * the downloadable v2 schema requires it under config. Accept either shape,
 * but reject conflicting or non-v2 values.
 */
function validateDesiredPlatformV2(definition: FabricDefinition): void {
  const platformPart = definition.parts.find(
    (p) => p.path === PLATFORM_PATH,
  );
  if (!platformPart) {
    return; // .platform is optional.
  }
  const platform = parseJsonObjectPart(platformPart);

  if (
    typeof platform.$schema !== "string" ||
    platform.$schema === ""
  ) {
    throw new Error(
      "Semantic Model .platform must include a '$schema' string.",
    );
  }
  if (platform.$schema !== PLATFORM_SCHEMA_URL) {
    throw new Error(
      `Semantic Model .platform '$schema' must be '${PLATFORM_SCHEMA_URL}'.`,
    );
  }
  const config = platform.config;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    throw new Error(
      "Semantic Model .platform must include a 'config' object (v2 format required).",
    );
  }
  const configObj = config as Record<string, unknown>;
  const topLevelVersion = platform.version;
  const configVersion = configObj.version;
  if (
    (topLevelVersion !== undefined &&
      topLevelVersion !== "2.0") ||
    (configVersion !== undefined &&
      configVersion !== "2.0") ||
    (topLevelVersion !== "2.0" &&
      configVersion !== "2.0")
  ) {
    throw new Error(
      "Semantic Model .platform must declare version \"2.0\" at the top level or in config.version.",
    );
  }
  if (
    typeof configObj.logicalId !== "string" ||
    !UUID_PATTERN.test(configObj.logicalId)
  ) {
    throw new Error(
      "Semantic Model .platform config.logicalId must be a valid UUID.",
    );
  }
  const metadata = platform.metadata;
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new Error(
      "Semantic Model .platform must include a 'metadata' object.",
    );
  }
  const metadataObj = metadata as Record<string, unknown>;
  if (metadataObj.type !== "SemanticModel") {
    throw new Error(
      "Semantic Model .platform metadata.type must be 'SemanticModel'.",
    );
  }
  if (
    typeof metadataObj.displayName !== "string" ||
    metadataObj.displayName.trim() === ""
  ) {
    throw new Error(
      "Semantic Model .platform metadata.displayName must be a non-empty string.",
    );
  }
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

function findDuplicates(values: readonly string[]): string[] {
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
