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

const EVENTSTREAM_CONTENT_PATH = "eventstream.json";
const EVENTSTREAM_PROPERTIES_PATH = "eventstreamProperties.json";
const PLATFORM_PATH = ".platform";

/** The three valid Eventstream throughput levels in upgrade order. */
export type EventstreamThroughputLevel = "Low" | "Medium" | "High";

/**
 * Numeric rank for throughput level comparisons.
 * Used by the plan() method to detect service-impossible downgrades before
 * dispatching an updateDefinition request.
 */
export const THROUGHPUT_ORDER: Record<EventstreamThroughputLevel, number> = {
  Low: 0,
  Medium: 1,
  High: 2,
};

/**
 * Reads the observed eventThroughputLevel from a definition's
 * eventstreamProperties.json part.  Returns "Low" (the server default) when
 * the part is absent or the field is missing.
 *
 * This must only be called on validated definitions; it is intentionally
 * lenient for the observed (server-returned) definition path.
 */
export function getEventstreamThroughputLevel(
  definition: FabricDefinition,
): EventstreamThroughputLevel {
  const part = definition.parts.find(
    (p) => p.path === EVENTSTREAM_PROPERTIES_PATH,
  );
  if (!part) return "Low";
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(part.payload, "base64").toString("utf8"),
    );
  } catch {
    return "Low";
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return "Low";
  }
  const level = (parsed as Record<string, unknown>).eventThroughputLevel;
  if (level === "Low" || level === "Medium" || level === "High") return level;
  return "Low";
}

/**
 * Loads an Eventstream definition from an item directory.
 *
 * Required file: definition/eventstream.json
 * Optional files: definition/eventstreamProperties.json, definition/.platform
 *
 * Live probe evidence (workspace a67215a2, 2026-07-21):
 *  - Server always injects UUIDs into "id" fields of sources/destinations/
 *    operators/streams nodes — these are stripped for canonical hashing.
 *  - Server PRESERVES eventstreamProperties.json (and .platform) when those
 *    parts are omitted from updateDefinition — it does NOT reset them to
 *    defaults. The shell create always returns defaults
 *    { retentionTimeInDays: 1, eventThroughputLevel: "Low" } in getDefinition.
 *    Drift detection skips these parts when the user does not manage them.
 *  - eventThroughputLevel is upgrade-only: Low→Medium→High is allowed;
 *    downgrading returns 400 "The throughput level can only be upgraded into
 *    a higher level. Once applied, it cannot be downgraded."
 *  - compatibilityLevel is normalised to "1.1" by the server; users should
 *    write "1.1" in their source files for stable round-trips.
 *  - definition.format is absent ("") from getDefinition responses — the
 *    adapter hard-codes "eventstream" when submitting.
 */
export function loadEventstreamDefinition(
  itemDirectory: string,
): FabricDefinition {
  const defDir = path.join(itemDirectory, "definition");
  const contentPath = path.join(defDir, EVENTSTREAM_CONTENT_PATH);

  if (!existsSync(contentPath) || !statSync(contentPath).isFile()) {
    throw new Error(
      "Eventstream definition must include definition/eventstream.json.",
    );
  }

  const propertiesPath = path.join(defDir, EVENTSTREAM_PROPERTIES_PATH);
  const platformPath = path.join(defDir, PLATFORM_PATH);

  const supportedFiles = new Set([
    contentPath,
    ...(existsSync(propertiesPath) && statSync(propertiesPath).isFile()
      ? [propertiesPath]
      : []),
    ...(existsSync(platformPath) && statSync(platformPath).isFile()
      ? [platformPath]
      : []),
  ]);

  const allFiles = listFiles(defDir);
  const unsupported = allFiles.filter(
    (filePath) => !supportedFiles.has(filePath),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Eventstream definition path '${path
        .relative(defDir, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }

  const parts: FabricDefinitionPart[] = [
    {
      path: EVENTSTREAM_CONTENT_PATH,
      payload: readFileSync(contentPath).toString("base64"),
      payloadType: "InlineBase64",
    },
  ];

  if (supportedFiles.has(propertiesPath)) {
    parts.push({
      path: EVENTSTREAM_PROPERTIES_PATH,
      payload: readFileSync(propertiesPath).toString("base64"),
      payloadType: "InlineBase64",
    });
  }

  if (supportedFiles.has(platformPath)) {
    parts.push({
      path: PLATFORM_PATH,
      payload: readFileSync(platformPath).toString("base64"),
      payloadType: "InlineBase64",
    });
  }

  const definition: FabricDefinition = {
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
  validateEventstreamDefinition(definition);
  return definition;
}

/**
 * Computes a content-addressable hash of the Eventstream definition.
 *
 * Server-injected node `id` fields are stripped from eventstream.json before
 * hashing so that a stable definition produces the same hash on every
 * getDefinition round-trip.
 *
 * @param definition   The definition to hash (from file or from getDefinition).
 * @param includePlatform Whether to include the .platform part in the hash.
 * @param includeProperties Whether to include eventstreamProperties.json.
 *   Pass `true` only when the user's desired definition manages that file.
 */
export function hashEventstreamDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
  includeProperties: boolean,
): string {
  validateEventstreamDefinition(definition);
  const parts = definition.parts
    .filter(
      (part) =>
        (includePlatform || part.path !== PLATFORM_PATH) &&
        (includeProperties ||
          part.path !== EVENTSTREAM_PROPERTIES_PATH),
    )
    .map((part) => ({
      path: part.path,
      payload: canonicalEventstreamPartPayload(part),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(stableJson(parts));
}

export function eventstreamIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some((part) => part.path === PLATFORM_PATH);
}

export function eventstreamIncludesPropertiesPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) => part.path === EVENTSTREAM_PROPERTIES_PATH,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function validateEventstreamDefinition(
  definition: FabricDefinition,
): void {
  const contentParts = definition.parts.filter(
    (part) => part.path === EVENTSTREAM_CONTENT_PATH,
  );
  if (contentParts.length !== 1) {
    throw new Error(
      "Eventstream definition must contain exactly one eventstream.json part.",
    );
  }
  const propertiesParts = definition.parts.filter(
    (part) => part.path === EVENTSTREAM_PROPERTIES_PATH,
  );
  if (propertiesParts.length > 1) {
    throw new Error(
      "Eventstream definition must not contain multiple eventstreamProperties.json parts.",
    );
  }
  const platformParts = definition.parts.filter(
    (part) => part.path === PLATFORM_PATH,
  );
  if (platformParts.length > 1) {
    throw new Error(
      "Eventstream definition must not contain multiple .platform parts.",
    );
  }
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Eventstream definition payload type '${part.payloadType}'.`,
      );
    }
    if (
      part.path !== EVENTSTREAM_CONTENT_PATH &&
      part.path !== EVENTSTREAM_PROPERTIES_PATH &&
      part.path !== PLATFORM_PATH
    ) {
      throw new Error(
        `Unsupported Eventstream definition path '${part.path}'.`,
      );
    }
  }
  // Validate all parts are valid JSON objects, then apply structural validation
  const contentParsed = parseJsonPart(
    contentParts[0]!,
    "Eventstream eventstream.json",
  );
  validateEventstreamContent(contentParsed);
  if (propertiesParts[0]) {
    const propsParsed = parseJsonPart(
      propertiesParts[0],
      "Eventstream eventstreamProperties.json",
    );
    validateEventstreamPropertiesStrict(propsParsed);
  }
  if (platformParts[0]) {
    parseJsonPart(platformParts[0], "Eventstream .platform");
  }
}

// ---------------------------------------------------------------------------
// Structural validators (called from validateEventstreamDefinition)
// ---------------------------------------------------------------------------

/**
 * Validates the schema structure of a parsed eventstream.json object.
 * Must be called before normalization/hashing so that malformed desired
 * definitions fail at manifest load time, not silently produce wrong hashes.
 *
 * Checks:
 *  - sources, destinations, operators, streams are all present and are arrays
 *    (null and non-array values are rejected; missing keys are rejected)
 *  - Each node entry in those arrays is a non-null object (primitives/nulls
 *    in the node lists are rejected)
 *  - compatibilityLevel, if present, is a string
 */
function validateEventstreamContent(
  content: Record<string, unknown>,
): void {
  const COLLECTION_FIELDS = [
    "sources",
    "destinations",
    "operators",
    "streams",
  ] as const;

  for (const field of COLLECTION_FIELDS) {
    if (!(field in content)) {
      throw new Error(
        `eventstream.json must contain a '${field}' array (field is missing).`,
      );
    }
    const value = content[field];
    if (!Array.isArray(value)) {
      throw new Error(
        `eventstream.json '${field}' must be an array; got ${value === null ? "null" : typeof value}.`,
      );
    }
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(
          `eventstream.json '${field}[${i}]' must be an object; got ${entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry}.`,
        );
      }
    }
  }

  if ("compatibilityLevel" in content) {
    const level = content.compatibilityLevel;
    if (typeof level !== "string") {
      throw new Error(
        `eventstream.json 'compatibilityLevel' must be a string; got ${level === null ? "null" : typeof level}.`,
      );
    }
    if (level !== "1.0" && level !== "1.1") {
      throw new Error(
        `eventstream.json 'compatibilityLevel' must be "1.0" or "1.1"; got ${JSON.stringify(level)}.`,
      );
    }
  }
}

/**
 * Strict load-time validation for eventstreamProperties.json.
 *
 * Differs from normalizeEventstreamProperties (which fills defaults) in that
 * it treats explicit null as an error rather than treating it as "omitted":
 *   - null retentionTimeInDays  → error (not silently defaulted to 1)
 *   - null eventThroughputLevel → error (not silently defaulted to "Low")
 *
 * A malformed properties file must fail at manifest load so that a
 * corrupted desired state can never hash as a valid no-op.
 */
function validateEventstreamPropertiesStrict(
  props: Record<string, unknown>,
): void {
  if (props.retentionTimeInDays === null) {
    throw new Error(
      "eventstreamProperties.json 'retentionTimeInDays' must not be null; " +
        "omit the field to use the server default (1), or supply an integer 1–90.",
    );
  }
  if (props.eventThroughputLevel === null) {
    throw new Error(
      "eventstreamProperties.json 'eventThroughputLevel' must not be null; " +
        'omit the field to use the server default ("Low"), or supply "Low", "Medium", or "High".',
    );
  }
  if (
    props.retentionTimeInDays !== undefined &&
    (typeof props.retentionTimeInDays !== "number" ||
      !Number.isInteger(props.retentionTimeInDays) ||
      props.retentionTimeInDays < 1 ||
      props.retentionTimeInDays > 90)
  ) {
    throw new Error(
      `eventstreamProperties.json retentionTimeInDays must be an integer between 1 and 90; got ${JSON.stringify(props.retentionTimeInDays)}.`,
    );
  }
  if (
    props.eventThroughputLevel !== undefined &&
    props.eventThroughputLevel !== "Low" &&
    props.eventThroughputLevel !== "Medium" &&
    props.eventThroughputLevel !== "High"
  ) {
    throw new Error(
      `eventstreamProperties.json eventThroughputLevel must be "Low", "Medium", or "High"; got ${JSON.stringify(props.eventThroughputLevel)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers (applied during canonical hashing)
// ---------------------------------------------------------------------------

/**
 * Returns the canonical payload string for hashing.
 *
 * For eventstream.json: parses to JSON, strips server-injected node `id`
 * fields from sources/destinations/operators/streams arrays, then
 * re-serialises with stableJson for key-order independence.
 *
 * For eventstreamProperties.json and .platform: normalise with stableJson.
 */
function canonicalEventstreamPartPayload(
  part: FabricDefinitionPart,
): string {
  const parsed = parseJsonPart(
    part,
    `Eventstream definition part '${part.path}'`,
  );
  if (part.path === EVENTSTREAM_CONTENT_PATH) {
    return stableJson(normalizeEventstreamContent(parsed));
  }
  if (part.path === EVENTSTREAM_PROPERTIES_PATH) {
    return stableJson(normalizeEventstreamProperties(parsed));
  }
  // .platform is a stable JSON object (no normalization)
  return stableJson(parsed);
}

/**
 * Removes server-injected `id` fields from all node arrays in
 * eventstream.json so hashes are stable across round-trips.
 *
 * Live proof (workspace a67215a2): submitting nodes without `id` causes the
 * server to assign new UUIDs on every updateDefinition call. Stripping them
 * before hashing lets the desired definition and the getDefinition response
 * produce identical hashes for topologically identical graphs.
 */
function stripTopologyNodeIds(
  topology: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...topology,
    sources: stripIds(topology.sources, "sources"),
    destinations: stripIds(topology.destinations, "destinations"),
    operators: stripIds(topology.operators, "operators"),
    streams: stripIds(topology.streams, "streams"),
  };
}

function stripIds(items: unknown, fieldName: string): unknown[] {
  // validateEventstreamContent() is always called before this; the array
  // assertion here is a defensive guard against internal logic errors.
  if (!Array.isArray(items)) {
    throw new Error(
      `Internal error: '${fieldName}' must be an array before ID stripping; got ${items === null ? "null" : typeof items}.`,
    );
  }
  return items.map((item) => {
    if (
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      return item as unknown;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...rest } = item as Record<string, unknown>;
    return rest;
  });
}

/**
 * Normalizes eventstream.json content for stable hashing.
 * - compatibilityLevel: omitted or "1.0" → "1.1" (server normalises to 1.1)
 */
function normalizeEventstreamContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = stripTopologyNodeIds(content);
  const raw = stripped.compatibilityLevel;
  const level =
    raw === undefined || raw === null || raw === "1.0" ? "1.1" : raw;
  return {
    ...stripped,
    compatibilityLevel: level,
  };
}

/**
 * Normalizes eventstreamProperties.json content for stable hashing.
 * - Missing (undefined) retentionTimeInDays → default 1
 * - Missing (undefined) eventThroughputLevel → default "Low"
 * - Explicit null for either field is rejected (validateEventstreamPropertiesStrict
 *   ensures this never reaches here from a user-managed file; this guard
 *   remains for defensive correctness when hashing server-returned definitions).
 * Validates known field types and ranges.
 * Note: eventThroughputLevel is upgrade-only once set above "Low" on the
 * server. Client-side validation only checks the enum; the server will reject
 * a downgrade with 400 EventStreamBadWebRequest.
 */
function normalizeEventstreamProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  if (props.retentionTimeInDays === null) {
    throw new Error(
      "eventstreamProperties.json 'retentionTimeInDays' must not be null.",
    );
  }
  if (props.eventThroughputLevel === null) {
    throw new Error(
      "eventstreamProperties.json 'eventThroughputLevel' must not be null.",
    );
  }
  const retention =
    props.retentionTimeInDays === undefined ? 1 : props.retentionTimeInDays;
  const throughput =
    props.eventThroughputLevel === undefined ? "Low" : props.eventThroughputLevel;
  if (
    typeof retention !== "number" ||
    !Number.isInteger(retention) ||
    retention < 1 ||
    retention > 90
  ) {
    throw new Error(
      `eventstreamProperties.json retentionTimeInDays must be an integer between 1 and 90; got ${JSON.stringify(retention)}.`,
    );
  }
  if (
    throughput !== "Low" &&
    throughput !== "Medium" &&
    throughput !== "High"
  ) {
    throw new Error(
      `eventstreamProperties.json eventThroughputLevel must be "Low", "Medium", or "High"; got ${JSON.stringify(throughput)}.`,
    );
  }
  return {
    ...props,
    retentionTimeInDays: retention,
    eventThroughputLevel: throughput,
  };
}

function parseJsonPart(
  part: FabricDefinitionPart,
  description: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(part.payload, "base64").toString("utf8"),
    );
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

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (
      entry.isFile() &&
      statSync(entryPath).isFile()
    ) {
      files.push(entryPath);
    }
  }
  return files;
}
