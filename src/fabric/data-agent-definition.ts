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

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

/** Root config file — required whenever a definition is provided. */
const ROOT_CONFIG_PATH = "Files/Config/data_agent.json";

/** Draft-stage AI instructions. */
const DRAFT_STAGE_CONFIG_PATH = "Files/Config/draft/stage_config.json";

/** Prefix for draft datasource sub-directories. */
const DRAFT_DATASOURCE_PREFIX = "Files/Config/draft/";

/** Prefix for published content — server-managed, never authored by the tool. */
const PUBLISHED_PREFIX = "Files/Config/published/";

/** Server-managed publish metadata — excluded from authoring. */
const PUBLISH_INFO_PATH = "Files/Config/publish_info.json";

/**
 * Server-generated git integration metadata returned by getDefinition.
 * Lives at root (not under Files/Config/) and is never authored.
 */
const PLATFORM_PATH = ".platform";

// ---------------------------------------------------------------------------
// Schema URL patterns
// ---------------------------------------------------------------------------

const ROOT_CONFIG_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/dataAgent\/definition\/dataAgent\/[0-9]+\.[0-9]+\.[0-9]+\/schema\.json$/;

const ROOT_CONFIG_SCHEMA_EXAMPLE =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";

const STAGE_CONFIG_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/dataAgent\/definition\/stageConfiguration\/[0-9]+\.[0-9]+\.[0-9]+\/schema\.json$/;

const FEWSHOTS_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/dataAgent\/definition\/fewShots\/[0-9]+\.[0-9]+\.[0-9]+\/schema\.json$/;

const DATASOURCE_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/dataAgent\/definition\/dataSource\/[0-9]+\.[0-9]+\.[0-9]+\/schema\.json$/;

const DATASOURCE_SCHEMA_EXAMPLE =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataSource/1.0.0/schema.json";

/** Valid datasource type values surfaced in datasource.json. */
const VALID_DATASOURCE_TYPES = new Set([
  "lakehouse_tables",
  "lakehouse",
  "data_warehouse",
  "kusto",
  "semantic_model",
  "graph",
  "mirrored_database",
  "mirrored_azure_databricks",
  "unknown",
]);

/** UUID v1–v5 pattern (also accepts v0/nil in practice — same structural form). */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// Payload normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises a base64-encoded payload for hashing.
 *
 * The Fabric API pretty-prints JSON on storage, so the raw bytes of a
 * server-returned part differ from the user's authored bytes even when the
 * content is semantically identical.  Hashing the raw bytes would produce
 * perpetual "update" actions and would cause verify() to fail after every
 * successful update.
 *
 * Fix: decode → parse as JSON → re-serialise with stableJson (compact,
 * recursively sorted keys) → re-encode. Non-JSON binary payloads are
 * returned unchanged.
 */
function normalizePartPayload(payload: string): string {
  try {
    const raw = Buffer.from(payload, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(raw);
    const normalised = stableJson(parsed);
    return Buffer.from(normalised).toString("base64");
  } catch {
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Loads a DataAgent definition from a directory on disk.
 *
 * The directory layout mirrors the REST API definition parts:
 *
 *   <itemDir>/
 *     Files/Config/data_agent.json          (required when definition present)
 *     Files/Config/draft/stage_config.json  (optional)
 *     Files/Config/draft/<type>-<name>/datasource.json  (optional)
 *     Files/Config/draft/<type>-<name>/fewshots.json    (optional)
 *
 * The following paths are explicitly rejected — they are server-managed and
 * must never be authored by the deploy tool:
 *   Files/Config/published/**
 *   Files/Config/publish_info.json
 *
 * Returns a FabricDefinition ready for comparison or dispatch to the API.
 * Returns undefined when the Files/Config directory does not exist, which
 * signals a "shell" DataAgent (create without definition).
 */
export function loadDataAgentDefinition(
  itemDirectory: string,
): FabricDefinition | undefined {
  const configDir = path.join(itemDirectory, "Files", "Config");

  if (
    !existsSync(configDir) ||
    !statSync(configDir).isDirectory()
  ) {
    // Shell: no definition directory — valid; caller creates without definition
    return undefined;
  }

  const parts: FabricDefinitionPart[] = [];
  collectParts(configDir, configDir, parts);

  if (parts.length === 0) {
    // Empty config directory also means shell
    return undefined;
  }

  const definition: FabricDefinition = {
    parts: parts.sort((a, b) =>
      compareCanonicalStrings(a.path, b.path),
    ),
  };

  validateDataAgentDefinition(definition);
  return definition;
}

/**
 * Hashes a DataAgent definition for drift detection.
 *
 * Hash surface:
 *   - Files/Config/data_agent.json
 *   - Files/Config/draft/**  (all draft files — stage_config, datasources, fewshots)
 *
 * Explicitly excluded from hash (server-managed, not authored):
 *   - Files/Config/published/**
 *   - Files/Config/publish_info.json
 *   - .platform
 *
 * Returns sha256 of the canonical JSON of the included part payloads.
 */
export function hashDataAgentDefinition(
  definition: FabricDefinition,
): string {
  const authoredParts = definition.parts
    .filter((p) => isAuthoredPartPath(p.path))
    .sort((a, b) => compareCanonicalStrings(a.path, b.path))
    .map((p) => ({ ...p, payload: normalizePartPayload(p.payload) }));
  return sha256(stableJson(authoredParts));
}

/**
 * Returns true if the given definition part is a server-generated default
 * that should be ignored when absent from the desired definition.
 *
 * The only currently recognised service default is:
 *   Files/Config/draft/stage_config.json with { $schema, aiInstructions: null }
 *   and optional experimental: {} for backwards compatibility.
 *
 * The Fabric DataAgent service adds this part automatically to every agent,
 * even when the user did not provide it. Treating it as "authored" would
 * produce perpetual drift for users who omit stage_config from their definition.
 */
export function isServiceGeneratedDefault(part: FabricDefinitionPart): boolean {
  if (canonicalise(part.path) !== DRAFT_STAGE_CONFIG_PATH) {
    return false;
  }
  try {
    const json = JSON.parse(
      Buffer.from(part.payload, "base64").toString("utf-8"),
    );
    if (json === null || typeof json !== "object") {
      return false;
    }
    const obj = json as Record<string, unknown>;
    const allowedKeys = new Set(["$schema", "aiInstructions", "experimental"]);
    if (Object.keys(obj).some((key) => !allowedKeys.has(key))) {
      return false;
    }
    const schema = obj["$schema"];
    if (
      typeof schema !== "string" ||
      !STAGE_CONFIG_SCHEMA_PATTERN.test(schema)
    ) {
      return false;
    }
    if (obj["aiInstructions"] !== null) {
      return false;
    }
    const experimental = obj["experimental"];
    if (
      experimental !== undefined &&
      !(
        typeof experimental === "object" &&
        experimental !== null &&
        !Array.isArray(experimental) &&
        Object.keys(experimental).length === 0
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the server definition matches the untouched shell state —
 * the exact default produced by a shell POST (displayName-only create) before
 * any definition staging.
 *
 * Used as a content-proof gate in LRO-resume: when no pre-completion shell
 * hash was checkpointed, we require the live definition to still be an
 * untouched shell before staging the desired definition.  Any external
 * modification (added datasource, changed aiInstructions, etc.) causes
 * LRO-resume to fail closed.
 *
 * Criteria (tolerant readback — ignores .platform):
 *  - Exactly two authored parts: Files/Config/data_agent.json +
 *    Files/Config/draft/stage_config.json
 *  - data_agent.json payload contains only a valid $schema reference
 *  - stage_config.json is the service-default (aiInstructions: null, optional
 *    empty experimental) — verified via isServiceGeneratedDefault()
 *  - No datasource, fewshots, or other authored parts
 */
export function isUntouchedDataAgentShellDefinition(
  definition: FabricDefinition,
): boolean {
  const authoredParts = definition.parts.filter((p) =>
    isAuthoredPartPath(p.path),
  );

  // Must have exactly root config + service-default stage config
  if (authoredParts.length !== 2) {
    return false;
  }

  const byPath = new Map(
    authoredParts.map((p) => [canonicalise(p.path), p]),
  );

  const rootPart = byPath.get(ROOT_CONFIG_PATH);
  const stagePart = byPath.get(DRAFT_STAGE_CONFIG_PATH);
  if (!rootPart || !stagePart) {
    return false;
  }

  // Check data_agent.json has a valid dataAgent schema reference
  try {
    const raw = Buffer.from(rootPart.payload, "base64").toString("utf-8");
    const json = JSON.parse(raw) as unknown;
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      return false;
    }
    const schema = (json as Record<string, unknown>)["$schema"];
    if (
      typeof schema !== "string" ||
      !ROOT_CONFIG_SCHEMA_PATTERN.test(schema)
    ) {
      return false;
    }
    if (
      Object.keys(json as Record<string, unknown>).some(
        (key) => key !== "$schema",
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // Check stage_config.json is the service-generated default
  return isServiceGeneratedDefault(stagePart);
}

/**
 * Builds the comparison hash for the **current** (server-side) definition,
 * given what the user **desired**.
 *
 * Semantics:
 *  - Every authored part present in `desiredDefinition` is included.
 *  - Authored parts present **only** in `currentDefinition` (not desired) are
 *    also included, UNLESS they are a service-generated default.
 *    → Removing a user-authored datasource/fewshots file is detected as drift.
 *    → The server's blank `stage_config.json` (aiInstructions:null) is NOT
 *      counted as drift when the user did not provide it.
 *
 * This replaces the old `hashDataAgentDefinitionScoped` which silently ignored
 * all current-only authored parts, allowing unmanaged files to be lost without
 * being detected as drift.
 *
 * When `desiredDefinition` is undefined (shell, no definition), returns the
 * hash of all authored current parts (excluding service defaults).
 */
export function buildDataAgentCurrentHash(
  currentDefinition: FabricDefinition,
  desiredDefinition: FabricDefinition | undefined,
): string {
  const desiredPaths = new Set(
    desiredDefinition
      ? desiredDefinition.parts
          .filter((p) => isAuthoredPartPath(p.path))
          .map((p) => canonicalise(p.path))
      : [],
  );

  const parts = currentDefinition.parts
    .filter((p) => {
      if (!isAuthoredPartPath(p.path)) return false;
      const np = canonicalise(p.path);
      if (desiredPaths.has(np)) return true;
      // Current-only part: include unless it is a service-generated default
      return !isServiceGeneratedDefault(p);
    })
    .sort((a, b) => compareCanonicalStrings(a.path, b.path))
    .map((p) => ({ ...p, payload: normalizePartPayload(p.payload) }));

  return sha256(stableJson(parts));
}

/**
 * @deprecated Use buildDataAgentCurrentHash for new callers.
 *
 * Hashes only the parts from `definition` that are also present in
 * `scopeDefinition` (after authored-path filtering).
 *
 * Kept for back-compat with any existing external test helpers; internal
 * callers (plan/verify) use buildDataAgentCurrentHash instead.
 */
export function hashDataAgentDefinitionScoped(
  definition: FabricDefinition,
  scopeDefinition: FabricDefinition,
): string {
  return buildDataAgentCurrentHash(definition, scopeDefinition);
}

/**
 * Validates a DataAgent definition received from the Fabric API during plan/verify.
 * Less strict than authoring validation — accepts server-managed published parts
 * without throwing, and normalises the absence of schema URLs in server payloads.
 */
export function validateDataAgentDefinitionResponse(
  definition: FabricDefinition,
): void {
  // Server always returns at least the root config for any agent that has a definition
  const rootPart = definition.parts.find(
    (p) => canonicalise(p.path) === ROOT_CONFIG_PATH,
  );
  if (!rootPart) {
    // An agent created without a definition will have no parts — OK
    return;
  }
  // If root config is present, validate it is parseable JSON
  decodeJson(rootPart, "root config");
}

/**
 * Returns true if the definition contains at least the root config part,
 * indicating a non-shell (has-definition) DataAgent.
 */
export function dataAgentHasDefinition(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (p) => canonicalise(p.path) === ROOT_CONFIG_PATH,
  );
}

/**
 * Builds the full effective definition to send on updateDefinition.
 *
 * For DataAgent, updateDefinition replaces the entire draft section.
 * Unlike SemanticModel where auxiliary parts must be preserved, the
 * DataAgent API does not have such auxiliary-part semantics for draft content.
 * Server-managed published/** parts are never included.
 *
 * Therefore the effective definition is simply the authored definition.
 */
export function buildEffectiveDataAgentDefinition(
  desiredDefinition: FabricDefinition,
): FabricDefinition {
  return {
    ...desiredDefinition,
    parts: desiredDefinition.parts.filter(
      (p) => isAuthoredPartPath(p.path),
    ),
  };
}

// ---------------------------------------------------------------------------
// Authoring validation (user-provided definitions)
// ---------------------------------------------------------------------------

function validateDataAgentDefinition(
  definition: FabricDefinition,
): void {
  // Reject server-managed paths
  const publishedPart = definition.parts.find(
    (p) => isServerManagedPath(p.path),
  );
  if (publishedPart) {
    throw new Error(
      `DataAgent definition part '${publishedPart.path}' is server-managed. ` +
        `Remove Files/Config/published/** and Files/Config/publish_info.json from the item directory. ` +
        `These are written by the Fabric publish operation and must not be authored.`,
    );
  }

  // Require root config
  const rootPart = definition.parts.find(
    (p) => canonicalise(p.path) === ROOT_CONFIG_PATH,
  );
  if (!rootPart) {
    throw new Error(
      `DataAgent definition is missing the required '${ROOT_CONFIG_PATH}' file. ` +
        `Expected schema: ${ROOT_CONFIG_SCHEMA_EXAMPLE}`,
    );
  }

  // Validate root config schema field
  const rootJson = decodeJson(rootPart, "root config");
  if (typeof rootJson !== "object" || rootJson === null) {
    throw new Error(
      `DataAgent '${ROOT_CONFIG_PATH}' must be a JSON object.`,
    );
  }
  const rootSchema = (rootJson as Record<string, unknown>)["$schema"];
  if (typeof rootSchema !== "string") {
    throw new Error(
      `DataAgent '${ROOT_CONFIG_PATH}' is missing the required '$schema' field. ` +
        `Expected pattern: ${ROOT_CONFIG_SCHEMA_EXAMPLE}`,
    );
  }
  if (!ROOT_CONFIG_SCHEMA_PATTERN.test(rootSchema)) {
    throw new Error(
      `DataAgent '${ROOT_CONFIG_PATH}' has an unrecognised '$schema' value '${rootSchema}'. ` +
        `Expected pattern: ${ROOT_CONFIG_SCHEMA_EXAMPLE}`,
    );
  }

  // Validate draft stage_config if present
  const stageConfigPart = definition.parts.find(
    (p) => canonicalise(p.path) === DRAFT_STAGE_CONFIG_PATH,
  );
  if (stageConfigPart) {
    const stageJson = decodeJson(stageConfigPart, "draft/stage_config");
    if (typeof stageJson !== "object" || stageJson === null) {
      throw new Error(
        `DataAgent '${DRAFT_STAGE_CONFIG_PATH}' must be a JSON object.`,
      );
    }
    const stageSchema = (stageJson as Record<string, unknown>)["$schema"];
    if (typeof stageSchema !== "string") {
      throw new Error(
        `DataAgent '${DRAFT_STAGE_CONFIG_PATH}' is missing the required '$schema' field. ` +
          `Expected a schema URL matching the stageConfiguration pattern.`,
      );
    }
    if (!STAGE_CONFIG_SCHEMA_PATTERN.test(stageSchema)) {
      throw new Error(
        `DataAgent '${DRAFT_STAGE_CONFIG_PATH}' has an unrecognised '$schema' value '${stageSchema}'.`,
      );
    }
    const instructions =
      (stageJson as Record<string, unknown>)["aiInstructions"];
    if (
      instructions !== undefined &&
      instructions !== null &&
      typeof instructions !== "string"
    ) {
      throw new Error(
        `DataAgent '${DRAFT_STAGE_CONFIG_PATH}' field 'aiInstructions' must be a string or null.`,
      );
    }
    // 'experimental' must be an object or null when present (not a primitive or array)
    const experimental =
      (stageJson as Record<string, unknown>)["experimental"];
    if (
      experimental !== undefined &&
      experimental !== null &&
      (typeof experimental !== "object" || Array.isArray(experimental))
    ) {
      throw new Error(
        `DataAgent '${DRAFT_STAGE_CONFIG_PATH}' field 'experimental' must be an object or null when present.`,
      );
    }
  }

  // Validate datasource and fewshots parts
  for (const part of definition.parts) {
    const normalPath = canonicalise(part.path);
    if (
      normalPath.startsWith(DRAFT_DATASOURCE_PREFIX) &&
      normalPath !== DRAFT_STAGE_CONFIG_PATH
    ) {
      validateDraftDataSourcePart(part);
    }
  }
}

function validateDraftDataSourcePart(part: FabricDefinitionPart): void {
  const normalPath = canonicalise(part.path);
  const suffix = normalPath.slice(DRAFT_DATASOURCE_PREFIX.length);
  const segments = suffix.split("/");

  if (segments.length < 2) {
    throw new Error(
      `DataAgent draft part '${part.path}' has an unexpected path structure. ` +
        `Expected: Files/Config/draft/<type>-<name>/datasource.json or fewshots.json`,
    );
  }

  const fileName = segments[segments.length - 1];
  if (fileName !== "datasource.json" && fileName !== "fewshots.json") {
    throw new Error(
      `DataAgent draft part '${part.path}' has unsupported filename '${fileName}'. ` +
        `Only 'datasource.json' and 'fewshots.json' are supported.`,
    );
  }

  if (fileName === "datasource.json") {
    const dsJson = decodeJson(part, `draft datasource ${segments.slice(0, -1).join("/")}`);
    if (typeof dsJson !== "object" || dsJson === null || Array.isArray(dsJson)) {
      throw new Error(
        `DataAgent datasource '${part.path}' must be a JSON object (not null or array).`,
      );
    }
    const ds = dsJson as Record<string, unknown>;
    // $schema is required and must match the official dataSource schema URL pattern
    const dsSchemaField = ds["$schema"];
    if (typeof dsSchemaField !== "string") {
      throw new Error(
        `DataAgent datasource '${part.path}' is missing the required '$schema' field. ` +
          `Expected: ${DATASOURCE_SCHEMA_EXAMPLE}`,
      );
    }
    if (!DATASOURCE_SCHEMA_PATTERN.test(dsSchemaField)) {
      throw new Error(
        `DataAgent datasource '${part.path}' has an unrecognised '$schema' value '${dsSchemaField}'. ` +
          `Expected a URL matching the dataSource schema pattern, e.g. ${DATASOURCE_SCHEMA_EXAMPLE}`,
      );
    }
    // type is required
    const dsType = ds["type"];
    if (dsType === undefined || dsType === null) {
      throw new Error(
        `DataAgent datasource '${part.path}' is missing the required 'type' field.`,
      );
    }
    if (!VALID_DATASOURCE_TYPES.has(String(dsType))) {
      throw new Error(
        `DataAgent datasource '${part.path}' has unrecognised type '${dsType}'. ` +
          `Valid types: ${[...VALID_DATASOURCE_TYPES].join(", ")}`,
      );
    }
    // artifactId is required and must be a UUID
    const artifactId = ds["artifactId"];
    if (artifactId === undefined || artifactId === null) {
      throw new Error(
        `DataAgent datasource '${part.path}' is missing the required 'artifactId' field.`,
      );
    }
    if (typeof artifactId !== "string" || !UUID_PATTERN.test(artifactId)) {
      throw new Error(
        `DataAgent datasource '${part.path}' 'artifactId' must be a valid UUID (got '${String(artifactId)}').`,
      );
    }
    // workspaceId is required and must be a UUID
    const workspaceId = ds["workspaceId"];
    if (workspaceId === undefined || workspaceId === null) {
      throw new Error(
        `DataAgent datasource '${part.path}' is missing the required 'workspaceId' field.`,
      );
    }
    if (typeof workspaceId !== "string" || !UUID_PATTERN.test(workspaceId)) {
      throw new Error(
        `DataAgent datasource '${part.path}' 'workspaceId' must be a valid UUID (got '${String(workspaceId)}').`,
      );
    }
    const displayName = ds["displayName"];
    if (displayName === undefined || displayName === null) {
      throw new Error(
        `DataAgent datasource '${part.path}' is missing the required 'displayName' field.`,
      );
    }
    if (
      typeof displayName !== "string" ||
      displayName.trim().length === 0
    ) {
      throw new Error(
        `DataAgent datasource '${part.path}' 'displayName' must be a non-empty string.`,
      );
    }
  }

  if (fileName === "fewshots.json") {
    const fewJson = decodeJson(part, `draft fewshots ${segments.slice(0, -1).join("/")}`);
    if (typeof fewJson !== "object" || fewJson === null) {
      throw new Error(
        `DataAgent '${part.path}' must be a JSON object.`,
      );
    }
    const fewSchema = (fewJson as Record<string, unknown>)["$schema"];
    if (typeof fewSchema !== "string") {
      throw new Error(
        `DataAgent '${part.path}' is missing the required '$schema' field. ` +
          `Expected a schema URL matching the fewShots pattern.`,
      );
    }
    if (!FEWSHOTS_SCHEMA_PATTERN.test(fewSchema)) {
      throw new Error(
        `DataAgent '${part.path}' has an unrecognised '$schema' value '${fewSchema}'.`,
      );
    }
    // Validate the fewShots collection — required, must be an array, each
    // entry requires a UUID id and a non-empty question string.
    const fewShots = (fewJson as Record<string, unknown>)["fewShots"];
    if (fewShots === undefined || fewShots === null) {
      throw new Error(
        `DataAgent '${part.path}' is missing the required 'fewShots' property.`,
      );
    }
    if (!Array.isArray(fewShots)) {
      throw new Error(
        `DataAgent '${part.path}' 'fewShots' must be an array (got ${typeof fewShots}).`,
      );
    }
    for (let i = 0; i < fewShots.length; i++) {
      const entry = fewShots[i];
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(
          `DataAgent '${part.path}' 'fewShots[${i}]' must be an object.`,
        );
      }
      const fe = entry as Record<string, unknown>;
      // id is required and must be a UUID
      const entryId = fe["id"];
      if (entryId === undefined || entryId === null) {
        throw new Error(
          `DataAgent '${part.path}' 'fewShots[${i}]' is missing the required 'id' field.`,
        );
      }
      if (typeof entryId !== "string" || !UUID_PATTERN.test(entryId)) {
        throw new Error(
          `DataAgent '${part.path}' 'fewShots[${i}].id' must be a valid UUID ` +
            `(got '${String(entryId)}').`,
        );
      }
      // question is required and must be non-empty
      const question = fe["question"];
      if (question === undefined || question === null) {
        throw new Error(
          `DataAgent '${part.path}' 'fewShots[${i}]' is missing the required 'question' field.`,
        );
      }
      if (typeof question !== "string" || question.trim().length === 0) {
        throw new Error(
          `DataAgent '${part.path}' 'fewShots[${i}].question' must be a non-empty string ` +
            `(got '${String(question)}').`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under a directory into FabricDefinitionParts.
 * Rejects server-managed paths eagerly.
 */
function collectParts(
  baseDir: string,
  currentDir: string,
  parts: FabricDefinitionPart[],
): void {
  for (const entry of readdirSync(currentDir)) {
    const fullPath = path.join(currentDir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      collectParts(baseDir, fullPath, parts);
    } else {
      const relativePath = path
        .relative(baseDir, fullPath)
        .replaceAll("\\", "/");
      // Prepend Files/Config/ to match the API path convention
      const apiPath = `Files/Config/${relativePath}`;
      if (isServerManagedPath(apiPath)) {
        throw new Error(
          `DataAgent item directory contains server-managed file '${apiPath}'. ` +
            `Remove Files/Config/published/** and Files/Config/publish_info.json.`,
        );
      }
      parts.push({
        path: apiPath,
        payload: readFileSync(fullPath).toString("base64"),
        payloadType: "InlineBase64" as const,
      });
    }
  }
}

/**
 * Returns true if the path is authored by the deploy tool (in hash surface).
 * Excludes server-managed published/** and publish_info.json.
 */
function isAuthoredPartPath(partPath: string): boolean {
  const normalised = canonicalise(partPath);
  return (
    !normalised.startsWith(PUBLISHED_PREFIX) &&
    normalised !== PUBLISH_INFO_PATH &&
    normalised !== PLATFORM_PATH
  );
}

/**
 * Returns true if the path is server-managed and must not be authored.
 */
function isServerManagedPath(partPath: string): boolean {
  const normalised = canonicalise(partPath);
  return (
    normalised.startsWith(PUBLISHED_PREFIX) ||
    normalised === PUBLISH_INFO_PATH
    // Note: .platform is server-generated but not blocked at authoring time
    // because it lives at root (outside Files/Config/) and the loader never
    // encounters it when scanning Files/Config/.
  );
}

function canonicalise(partPath: string): string {
  return partPath.replaceAll("\\", "/");
}

function decodeJson(
  part: FabricDefinitionPart,
  label: string,
): unknown {
  try {
    const raw = Buffer.from(part.payload, "base64").toString("utf-8");
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `DataAgent definition part '${part.path}' (${label}) is not valid JSON.`,
    );
  }
}
