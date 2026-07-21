/**
 * Copy Job definition loader, validator, and semantic hasher.
 *
 * The Fabric Copy Job public definition exposes only `properties.jobMode`
 * from `copyjob-content.json`. All other fields (activities, connections,
 * transformations) are managed through the Fabric UI or private APIs and are
 * NOT part of the public definition contract. Empirically confirmed via live
 * API probe: the server strips every field except `properties.jobMode` from
 * submitted definitions, so extra fields would hide user-managed drift.
 * This loader therefore rejects extra fields to make that normalization explicit.
 *
 * Authoritative source: microsoft/fabric-rest-api-specs:copyJob/definitions.json
 */

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COPY_JOB_CONTENT_PATH = "copyjob-content.json";
export const COPY_JOB_MODES = ["Batch", "CDC"] as const;
export type CopyJobMode = (typeof COPY_JOB_MODES)[number];

/**
 * The only valid sentinel value for `.platform` `config.logicalId` for items
 * deployed without Git integration.  Confirmed via live API probe: the Fabric
 * service always returns this value for non-Git-integrated items and the field
 * is server-managed — it cannot be set by a client.  Non-zero values (used by
 * Git-integrated items) are rejected to prevent silent hash suppression.
 */
const ZERO_LOGICAL_ID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Loads and validates a Copy Job definition from `itemDirectory/definition/`.
 * Requires exactly one `copyjob-content.json` file containing only
 * `{ "properties": { "jobMode": "Batch" | "CDC" } }`.
 * An optional `.platform` may be included; sensitivity labels are rejected.
 */
export function loadCopyJobDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const contentPath = path.join(
    definitionDirectory,
    COPY_JOB_CONTENT_PATH,
  );
  if (
    !existsSync(contentPath) ||
    !statSync(contentPath).isFile()
  ) {
    throw new Error(
      "Copy Job definition must include definition/copyjob-content.json.",
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
      `Unsupported Copy Job definition path '${path
        .relative(definitionDirectory, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }

  const parts: FabricDefinitionPart[] = [
    {
      path: COPY_JOB_CONTENT_PATH,
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

  const definition: FabricDefinition = {
    parts: parts.sort((a, b) =>
      compareCanonicalStrings(a.path, b.path),
    ),
  };
  validateCopyJobDefinition(definition);
  return definition;
}

// ---------------------------------------------------------------------------
// Hasher
// ---------------------------------------------------------------------------

/**
 * Produces a stable SHA-256 hash of the Copy Job definition, normalizing
 * whitespace and key ordering. When `includePlatform` is false, the `.platform`
 * part is excluded (used when the user has not declared platform management).
 *
 * `.platform` server-managed fields (`config.logicalId`) are stripped before
 * hashing to prevent spurious drift on items created without Git integration,
 * where the server always returns the zeroed UUID.
 */
export function hashCopyJobDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
): string {
  validateCopyJobDefinition(definition);
  const parts = definition.parts
    .filter((part) => includePlatform || part.path !== ".platform")
    .map((part) => {
      const parsed = parseJsonPart(part);
      const normalized =
        part.path === ".platform"
          ? normalizePlatform(parsed)
          : parsed;
      return {
        path: part.path,
        payload: stableJson(normalized),
      };
    })
    .sort((a, b) => compareCanonicalStrings(a.path, b.path));
  return sha256(stableJson(parts));
}

/**
 * Produces a stable SHA-256 hash of a **server-returned** Copy Job definition
 * by projecting `copyjob-content.json` to the managed surface before hashing.
 *
 * Portal-managed fields (`activities`, `properties.source`,
 * `properties.destination`, `properties.policy`, and any future additions) are
 * silently discarded so they do not cause spurious drift between a minimal
 * desired definition and a fully-configured live definition.
 *
 * The managed surface is identical to that of `hashCopyJobDefinition` —
 * `properties.jobMode` plus accepted normalised `.platform` metadata.  When
 * both the desired and current definitions have the same jobMode (and the same
 * `.platform` when `includePlatform` is true), both hash functions produce
 * the same value, enabling correct no-op / update / blocked decisions.
 *
 * Use this function whenever hashing a definition received from the Fabric
 * service (`getDefinition` responses).  Always use `hashCopyJobDefinition` for
 * user-provided desired definitions — that function validates structure too.
 */
export function hashServerCopyJobDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
): string {
  const contentParts = definition.parts.filter(
    (p) => p.path === COPY_JOB_CONTENT_PATH,
  );
  if (contentParts.length !== 1) {
    throw new Error(
      "Server Copy Job definition must contain exactly one copyjob-content.json part.",
    );
  }
  const parts = definition.parts
    // Exclude .platform when the desired definition does not manage it
    .filter((part) => includePlatform || part.path !== ".platform")
    // Ignore any unexpected parts the server might return
    .filter(
      (part) =>
        part.path === COPY_JOB_CONTENT_PATH ||
        part.path === ".platform",
    )
    .map((part) => {
      if (part.payloadType !== "InlineBase64") {
        throw new Error(
          `Unsupported Fabric definition payload type '${part.payloadType}'.`,
        );
      }
      const parsed = parseJsonPart(part);
      const normalized =
        part.path === ".platform"
          ? normalizePlatform(parsed)
          : projectCopyJobContent(parsed); // project to managed surface only
      return {
        path: part.path,
        payload: stableJson(normalized),
      };
    })
    .sort((a, b) => compareCanonicalStrings(a.path, b.path));
  return sha256(stableJson(parts));
}

export function copyJobIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) => part.path === ".platform");
}

/**
 * Reads `properties.jobMode` from the definition.
 * The definition must have passed `validateCopyJobDefinition` first.
 */
export function readCopyJobMode(
  definition: FabricDefinition,
): CopyJobMode {
  const contentPart = definition.parts.find(
    (p) => p.path === COPY_JOB_CONTENT_PATH,
  );
  if (!contentPart) {
    throw new Error(
      "Copy Job definition is missing copyjob-content.json.",
    );
  }
  const parsed = parseJsonPart(contentPart);
  const props = parsed.properties;
  if (
    props === null ||
    typeof props !== "object" ||
    Array.isArray(props)
  ) {
    throw new Error(
      "Copy Job definition copyjob-content.json must have a 'properties' object.",
    );
  }
  const jobMode = (props as Record<string, unknown>).jobMode;
  if (!isValidJobMode(jobMode)) {
    throw new Error(
      `Copy Job definition copyjob-content.json has invalid jobMode '${String(jobMode)}'. Expected 'Batch' or 'CDC'.`,
    );
  }
  return jobMode;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateCopyJobDefinition(
  definition: FabricDefinition,
): void {
  const contentParts = definition.parts.filter(
    (part) => part.path === COPY_JOB_CONTENT_PATH,
  );
  const platformParts = definition.parts.filter(
    (part) => part.path === ".platform",
  );
  if (contentParts.length !== 1) {
    throw new Error(
      "Copy Job definition must contain exactly one copyjob-content.json part.",
    );
  }
  if (platformParts.length > 1) {
    throw new Error(
      "Copy Job definition must not contain multiple .platform parts.",
    );
  }
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    if (
      part.path !== COPY_JOB_CONTENT_PATH &&
      part.path !== ".platform"
    ) {
      throw new Error(
        `Unsupported Copy Job definition part '${part.path}'.`,
      );
    }
  }

  // Validate copyjob-content.json structure
  const contentPart = contentParts[0]!;
  const content = parseJsonPart(contentPart);
  validateCopyJobContent(content);

  // Validate .platform if present
  if (platformParts[0]) {
    const platform = parseJsonPart(platformParts[0]);
    if (containsProperty(platform, "sensitivityLabelId")) {
      throw new Error(
        "Copy Job .platform sensitivity labels are not supported; manage the label outside the definition deployment.",
      );
    }
    // Reject non-zero logicalId values: they are server-managed (assigned
    // when the item is integrated with a Git repository) and cannot be
    // applied by this action.  Only absent or the zero sentinel is accepted.
    if (
      platform.config !== null &&
      typeof platform.config === "object" &&
      !Array.isArray(platform.config)
    ) {
      const config = platform.config as Record<string, unknown>;
      if (
        Object.hasOwn(config, "logicalId") &&
        config.logicalId !== ZERO_LOGICAL_ID
      ) {
        throw new Error(
          `Copy Job .platform config.logicalId must be absent or the zero GUID "${ZERO_LOGICAL_ID}". ` +
            "Non-zero values are assigned by Fabric when the item is integrated with a Git repository " +
            "and are server-managed — they cannot be applied by this action. " +
            "Remove the logicalId field or set it to the zero sentinel.",
        );
      }
    }
  }
}

function validateCopyJobContent(
  content: Record<string, unknown>,
): void {
  // Reject extra top-level fields to prevent hidden normalization drift.
  // The server only preserves properties.jobMode; extra fields are silently
  // dropped, which would create a permanent hash mismatch.
  const allowedTopLevel = new Set(["properties"]);
  const extraTopLevel = Object.keys(content).filter(
    (k) => !allowedTopLevel.has(k),
  );
  if (extraTopLevel.length > 0) {
    throw new Error(
      `Copy Job copyjob-content.json contains unsupported top-level field(s): ${extraTopLevel.map((k) => `'${k}'`).join(", ")}. The Fabric Copy Job public definition only supports 'properties.jobMode'.`,
    );
  }

  const props = content.properties;
  if (
    props === undefined ||
    props === null ||
    typeof props !== "object" ||
    Array.isArray(props)
  ) {
    throw new Error(
      "Copy Job copyjob-content.json must contain a 'properties' object.",
    );
  }

  const properties = props as Record<string, unknown>;
  const { jobMode, ...extraProps } = properties;

  // Reject extra properties fields (activities, connections, etc. are server-managed)
  const extraPropKeys = Object.keys(extraProps);
  if (extraPropKeys.length > 0) {
    throw new Error(
      `Copy Job copyjob-content.json 'properties' contains unsupported field(s): ${extraPropKeys.map((k) => `'${k}'`).join(", ")}. ` +
        "Activities, connections, and other Copy Job fields are managed through the Fabric portal and are not part of the public definition. " +
        "Only 'jobMode' is supported.",
    );
  }

  if (!isValidJobMode(jobMode)) {
    throw new Error(
      `Copy Job copyjob-content.json 'properties.jobMode' must be 'Batch' or 'CDC'; received '${String(jobMode)}'.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidJobMode(value: unknown): value is CopyJobMode {
  return value === "Batch" || value === "CDC";
}

/**
 * Projects a server-returned `copyjob-content.json` payload to the managed
 * surface — only `properties.jobMode` is retained; portal-managed fields
 * (`activities`, `properties.source`, `properties.destination`,
 * `properties.policy`, and any future additions) are silently ignored.
 *
 * This ensures that plan/verify/recovery hash comparisons between a minimal
 * desired definition and a fully-configured server definition produce equal
 * hashes whenever the managed surface (jobMode) is the same.
 */
function projectCopyJobContent(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  const props = parsed.properties;
  if (
    props === undefined ||
    props === null ||
    typeof props !== "object" ||
    Array.isArray(props)
  ) {
    throw new Error(
      "Server Copy Job definition copyjob-content.json must contain a 'properties' object.",
    );
  }
  const jobMode = (props as Record<string, unknown>).jobMode;
  if (!isValidJobMode(jobMode)) {
    throw new Error(
      `Server Copy Job definition has invalid jobMode '${String(jobMode)}'. Expected 'Batch' or 'CDC'.`,
    );
  }
  return { properties: { jobMode } };
}

/**
 * Strips `config.logicalId` from the `.platform` object before hashing.
 * `logicalId` is a server-managed field: Fabric always returns the zero GUID
 * (`"00000000-0000-0000-0000-000000000000"`) for items deployed without Git
 * integration.  Validation in `validateCopyJobDefinition` already rejects
 * non-zero values, so stripping here prevents a spurious always-update from
 * items that do not include the field vs. those that include the zero sentinel.
 */
function normalizePlatform(
  platform: Record<string, unknown>,
): Record<string, unknown> {
  if (
    platform.config !== null &&
    typeof platform.config === "object" &&
    !Array.isArray(platform.config)
  ) {
    const config = { ...(platform.config as Record<string, unknown>) };
    delete config.logicalId;
    return { ...platform, config };
  }
  return platform;
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
      `Copy Job definition part '${part.path}' must contain valid JSON.`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `Copy Job definition part '${part.path}' must contain a JSON object.`,
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
