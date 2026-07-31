import { readFileSync, readdirSync, statSync } from "node:fs";
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

const ROOT_DEFINITION_PATH = "definition.json";
const PLATFORM_PATH = ".platform";
const POSITIVE_INT64_PATTERN = /^[1-9][0-9]*$/;
const MAX_INT64 = 9223372036854775807n;

const ENTITY_DEFINITION_PATTERN =
  /^EntityTypes\/([1-9][0-9]*)\/definition\.json$/;
const ENTITY_DATA_BINDING_PATTERN =
  /^EntityTypes\/([1-9][0-9]*)\/DataBindings\/[^/]+\.json$/;
const ENTITY_DOCUMENT_PATTERN =
  /^EntityTypes\/([1-9][0-9]*)\/Documents\/[^/]+\.json$/;
const ENTITY_OVERVIEW_PATTERN =
  /^EntityTypes\/([1-9][0-9]*)\/Overviews\/definition\.json$/;
const ENTITY_RESOURCE_LINK_PATTERN =
  /^EntityTypes\/([1-9][0-9]*)\/ResourceLinks\/definition\.json$/;
const RELATIONSHIP_DEFINITION_PATTERN =
  /^RelationshipTypes\/([1-9][0-9]*)\/definition\.json$/;
const RELATIONSHIP_CONTEXTUALIZATION_PATTERN =
  /^RelationshipTypes\/([1-9][0-9]*)\/Contextualizations\/[^/]+\.json$/;

export function loadOntologyDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const parts = listFiles(definitionDirectory).map((filePath) => ({
    path: path
      .relative(definitionDirectory, filePath)
      .replaceAll("\\", "/"),
    payload: readFileSync(filePath).toString("base64"),
    payloadType: "InlineBase64" as const,
  }));
  const definition = {
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  } satisfies FabricDefinition;
  validateOntologyDefinition(definition);
  return definition;
}

export function hashOntologyDefinition(
  definition: FabricDefinition,
): string {
  validateOntologyDefinition(definition);
  const parts = definition.parts
    .map((part) => ({
      path: part.path,
      payload: canonicalOntologyPayload(part),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(
    stableJson({
      format: ontologyDefinitionFormat(definition),
      parts,
    }),
  );
}

export function ontologyDefinitionFormat(
  definition: FabricDefinition,
): "JSON" {
  const format = definition.format;
  if (
    format !== undefined &&
    format !== "" &&
    format !== "Default" &&
    format !== "JSON"
  ) {
    throw new Error(
      `Unsupported Ontology definition format '${format}'.`,
    );
  }
  return "JSON";
}

export function validateOntologyDefinition(
  definition: FabricDefinition,
): void {
  ontologyDefinitionFormat(definition);
  const paths = new Set<string>();
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    if (paths.has(part.path)) {
      throw new Error(
        `Ontology definition contains duplicate part '${part.path}'.`,
      );
    }
    paths.add(part.path);
    validateOntologyPart(part);
  }
  if (!paths.has(ROOT_DEFINITION_PATH)) {
    throw new Error(
      "Ontology definition must include definition/definition.json.",
    );
  }
  if (!paths.has(PLATFORM_PATH)) {
    throw new Error(
      "Ontology definition must include definition/.platform.",
    );
  }
}

function validateOntologyPart(part: FabricDefinitionPart): void {
  if (part.path === ROOT_DEFINITION_PATH) {
    const root = parseJsonObject(part, "Ontology definition.json");
    if (Object.keys(root).length !== 0) {
      throw new Error(
        "Ontology definition/definition.json must contain an empty JSON object.",
      );
    }
    return;
  }
  if (part.path === PLATFORM_PATH) {
    parseJsonObject(part, "Ontology .platform");
    return;
  }

  const entityDefinition = ENTITY_DEFINITION_PATTERN.exec(part.path);
  if (entityDefinition) {
    const value = parseJsonObject(part, `Ontology '${part.path}'`);
    assertDefinitionIdMatchesPath(
      value.id,
      entityDefinition[1]!,
      part.path,
    );
    return;
  }
  const relationshipDefinition =
    RELATIONSHIP_DEFINITION_PATTERN.exec(part.path);
  if (relationshipDefinition) {
    const value = parseJsonObject(part, `Ontology '${part.path}'`);
    assertDefinitionIdMatchesPath(
      value.id,
      relationshipDefinition[1]!,
      part.path,
    );
    return;
  }
  if (
    ENTITY_DATA_BINDING_PATTERN.test(part.path) ||
    ENTITY_DOCUMENT_PATTERN.test(part.path) ||
    ENTITY_OVERVIEW_PATTERN.test(part.path) ||
    ENTITY_RESOURCE_LINK_PATTERN.test(part.path) ||
    RELATIONSHIP_CONTEXTUALIZATION_PATTERN.test(part.path)
  ) {
    const idMatch =
      ENTITY_DATA_BINDING_PATTERN.exec(part.path) ??
      ENTITY_DOCUMENT_PATTERN.exec(part.path) ??
      ENTITY_OVERVIEW_PATTERN.exec(part.path) ??
      ENTITY_RESOURCE_LINK_PATTERN.exec(part.path) ??
      RELATIONSHIP_CONTEXTUALIZATION_PATTERN.exec(part.path);
    assertPositiveInt64(idMatch?.[1], part.path);
    parseJsonObject(part, `Ontology '${part.path}'`);
    return;
  }
  throw new Error(
    `Unsupported Ontology definition path '${part.path}'.`,
  );
}

function canonicalOntologyPayload(
  part: FabricDefinitionPart,
): string {
  const value = parseJsonObject(part, `Ontology '${part.path}'`);
  if (part.path !== PLATFORM_PATH) {
    return stableJson(normalizeOntologyJsonPart(part.path, value));
  }
  const metadata =
    value.metadata !== null &&
    typeof value.metadata === "object" &&
    !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : {};
  return stableJson({
    metadata: {
      type: metadata.type ?? null,
      displayName: metadata.displayName ?? null,
    },
  });
}

function normalizeOntologyJsonPart(
  partPath: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...value };
  delete normalized.$schema;
  if (!ENTITY_DEFINITION_PATTERN.test(partPath)) {
    return normalized;
  }
  return {
    ...normalized,
    baseEntityTypeId: normalized.baseEntityTypeId ?? null,
    entityIdParts: normalized.entityIdParts ?? [],
    displayNamePropertyId: normalized.displayNamePropertyId ?? null,
    visibility: normalized.visibility ?? "Visible",
    properties: normalizeEntityProperties(normalized.properties),
    timeseriesProperties: normalizeEntityProperties(
      normalized.timeseriesProperties,
    ),
    untypedProperties: normalized.untypedProperties ?? [],
  };
}

function normalizeEntityProperties(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((property) => {
    if (
      property === null ||
      typeof property !== "object" ||
      Array.isArray(property)
    ) {
      return property;
    }
    const normalized = {
      ...(property as Record<string, unknown>),
    };
    delete normalized.$schema;
    return {
      ...normalized,
      redefines: normalized.redefines ?? null,
      baseTypeNamespaceType:
        normalized.baseTypeNamespaceType ?? null,
    };
  });
}

function assertDefinitionIdMatchesPath(
  value: unknown,
  pathId: string,
  partPath: string,
): void {
  if (typeof value !== "string" || value !== pathId) {
    throw new Error(
      `Ontology '${partPath}' id must match path ID '${pathId}'.`,
    );
  }
  assertPositiveInt64(value, partPath);
}

function assertPositiveInt64(
  value: string | undefined,
  partPath: string,
): void {
  if (!value || !POSITIVE_INT64_PATTERN.test(value)) {
    throw new Error(
      `Ontology '${partPath}' must use a positive 64-bit integer ID.`,
    );
  }
  if (BigInt(value) > MAX_INT64) {
    throw new Error(
      `Ontology '${partPath}' ID exceeds the positive 64-bit integer range.`,
    );
  }
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
