import {
  existsSync,
  lstatSync,
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

const DEFINITION_PROPERTIES_PATH = "definition.pbir";
const LEGACY_REPORT_PATH = "report.json";
const PLATFORM_PATH = ".platform";
const DIAGRAM_LAYOUT_PATH = "semanticModelDiagramLayout.json";
const PBIR_DIRECTORY = "definition";
const STATIC_RESOURCES_DIRECTORY = "StaticResources";
const SYMBOLIC_CONNECTION_STRING =
  "semanticmodelid=<fabric-deploy-logical-reference>";
const PBIR_SCHEMA_PATTERN =
  /^https:\/\/developer\.microsoft\.com\/json-schemas\/fabric\/item\/report\/definitionProperties\/2\.[0-9]+\.[0-9]+\/schema\.json$/;
const VERSION_METADATA_SCHEMA_URL =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json";
const PAGES_METADATA_SCHEMA_URL =
  "https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.0.0/schema.json";
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export type ReportDefinitionFormat = "PBIR" | "PBIR-Legacy";

export function loadReportDefinition(
  itemDirectory: string,
): FabricDefinition {
  const definitionDirectory = path.join(itemDirectory, "definition");
  if (
    !existsSync(definitionDirectory) ||
    !statSync(definitionDirectory).isDirectory()
  ) {
    throw new Error(
      "Report definition must include a definition directory.",
    );
  }

  const parts = listFiles(definitionDirectory).map((filePath) => {
    const relativePath = path
      .relative(definitionDirectory, filePath)
      .replaceAll("\\", "/");
    return {
      path: canonicalReportPartPath(relativePath),
      payload: readFileSync(filePath).toString("base64"),
      payloadType: "InlineBase64" as const,
    };
  });
  const definition: FabricDefinition = {
    format: inferReportDefinitionFormat(parts),
    parts: parts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
  validateDesiredDefinitionProperties(definition);
  validateReportDefinition(definition);
  return definition;
}

export function hashReportDefinition(
  definition: FabricDefinition,
  includePlatform: boolean,
  includeDiagramLayout: boolean,
  includePhysicalBinding = true,
): string {
  validateReportDefinition(definition);
  const format = reportDefinitionFormat(definition);
  const parts = definition.parts
    .map((part) => ({
      part,
      path: canonicalReportPartPath(part.path),
    }))
    .filter(
      ({ path: partPath }) =>
        (includePlatform || partPath !== PLATFORM_PATH) &&
        (includeDiagramLayout ||
          partPath !== DIAGRAM_LAYOUT_PATH),
    )
    .map(({ part, path: partPath }) => ({
      path: partPath,
      payload: isJsonReportPart(partPath)
        ? stableJson(
            canonicalReportJsonValue(
              partPath,
              parseJsonObjectPart(part),
              includePhysicalBinding,
            ),
          )
        : requireCanonicalBase64(part),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(stableJson({ format, parts }));
}

export function hashReportSourceDefinition(
  definition: FabricDefinition,
): string {
  return hashReportDefinition(
    definition,
    reportIncludesPlatformPart(definition),
    reportIncludesDiagramLayoutPart(definition),
    false,
  );
}

export function reportDefinitionFormat(
  definition: FabricDefinition,
): ReportDefinitionFormat {
  const inferred = inferReportDefinitionFormat(definition.parts);
  const format = definition.format ?? inferred;
  if (format !== "PBIR" && format !== "PBIR-Legacy") {
    throw new Error(
      `Unsupported Report definition format '${format}'.`,
    );
  }
  if (format !== inferred) {
    throw new Error(
      `Report definition format '${format}' does not match its definition parts.`,
    );
  }
  return format;
}

export function reportIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) => canonicalReportPartPath(part.path) === PLATFORM_PATH,
  );
}

export function reportIncludesDiagramLayoutPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) =>
      canonicalReportPartPath(part.path) === DIAGRAM_LAYOUT_PATH,
  );
}

export function reportPlatformLogicalId(
  definition: FabricDefinition,
): string | undefined {
  const platformPart = definition.parts.find(
    (part) => canonicalReportPartPath(part.path) === PLATFORM_PATH,
  );
  if (!platformPart) {
    return undefined;
  }
  let platform: Record<string, unknown>;
  try {
    platform = parseJsonObjectPart(platformPart);
  } catch {
    return undefined;
  }
  const config = platform.config;
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    return undefined;
  }
  const logicalId = (config as Record<string, unknown>).logicalId;
  return typeof logicalId === "string" &&
    UUID_PATTERN.test(logicalId)
    ? logicalId.toLowerCase()
    : undefined;
}

export function reportBindingConnectionString(
  definition: FabricDefinition,
): string {
  const part = definition.parts.find(
    (candidate) =>
      canonicalReportPartPath(candidate.path) ===
      DEFINITION_PROPERTIES_PATH,
  );
  if (!part) {
    throw new Error(
      "Report definition must contain exactly one definition.pbir part.",
    );
  }
  const properties = parseJsonObjectPart(part);
  assertAllowedKeys(
    properties,
    new Set(["$schema", "version", "datasetReference"]),
    "Report definition.pbir",
  );
  const datasetReference = properties.datasetReference;
  if (
    datasetReference === null ||
    typeof datasetReference !== "object" ||
    Array.isArray(datasetReference)
  ) {
    throw new Error(
      "Report definition.pbir must include a datasetReference object.",
    );
  }
  const reference = datasetReference as Record<string, unknown>;
  if (Object.hasOwn(reference, "byPath")) {
    throw new Error(
      "Report definition.pbir datasetReference.byPath is not supported for REST deployment; use byConnection.",
    );
  }
  assertAllowedKeys(
    reference,
    new Set(["byConnection"]),
    "Report definition.pbir datasetReference",
  );
  const byConnection = reference.byConnection;
  if (
    byConnection === null ||
    typeof byConnection !== "object" ||
    Array.isArray(byConnection)
  ) {
    throw new Error(
      "Report definition.pbir must include datasetReference.byConnection.",
    );
  }
  const byConnectionObject =
    byConnection as Record<string, unknown>;
  assertAllowedKeys(
    byConnectionObject,
    new Set(["connectionString"]),
    "Report definition.pbir datasetReference.byConnection",
  );
  const connectionString = byConnectionObject.connectionString;
  if (
    typeof connectionString !== "string" ||
    connectionString.trim() === ""
  ) {
    throw new Error(
      "Report definition.pbir datasetReference.byConnection.connectionString must be a non-empty string.",
    );
  }
  return connectionString;
}

export function assertReportBinding(
  definition: FabricDefinition,
  semanticModelId: string,
): void {
  const actual = semanticModelIdFromConnectionString(
    reportBindingConnectionString(definition),
  );
  if (actual !== semanticModelId) {
    throw new Error(
      `Report binding verification failed: expected Semantic Model '${semanticModelId}', received '${actual}'.`,
    );
  }
}

export function auxiliaryReportParts(
  definition: FabricDefinition,
): FabricDefinitionPart[] {
  return definition.parts.filter((part) => {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalReportPartPath(part.path);
    } catch {
      return false;
    }
    return isAuxiliaryReportPath(canonicalPath);
  });
}

export function hashAuxiliaryReportParts(
  parts: readonly FabricDefinitionPart[],
): string {
  const canonical = parts
    .map((part) => {
      const canonicalPath = canonicalReportPartPath(part.path);
      return {
        path: canonicalPath,
        payload: stableJson(
          canonicalAuxiliaryJsonValue(
            canonicalPath,
            parseJsonObjectPart(part),
          ),
        ),
      };
    })
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(stableJson(canonical));
}

/**
 * Report definition updates are full replacements. Preserve only the
 * documented service/user-managed auxiliary parts that desired omitted.
 * Core PBIR, PBIR-Legacy, and StaticResources content remains exclusively
 * desired-owned so obsolete or cross-format content is not retained.
 */
export function buildEffectiveReportDefinition(
  desired: FabricDefinition,
  current: FabricDefinition,
): FabricDefinition {
  const desiredPaths = new Set(
    desired.parts.map((part) =>
      canonicalReportPartPath(part.path),
    ),
  );
  const preserved: FabricDefinitionPart[] = [];
  for (const part of current.parts) {
    let canonicalPath: string;
    try {
      canonicalPath = canonicalReportPartPath(part.path);
    } catch {
      continue;
    }
    if (
      isAuxiliaryReportPath(canonicalPath) &&
      !desiredPaths.has(canonicalPath)
    ) {
      preserved.push({ ...part, path: canonicalPath });
    }
  }
  return {
    format: reportDefinitionFormat(desired),
    parts: [
      ...desired.parts.map((part) => ({
        ...part,
        path: canonicalReportPartPath(part.path),
      })),
      ...preserved,
    ].sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  };
}

/**
 * Returns the captured source definition with the environment-specific model
 * ID replaced by a stable sentinel. The logical binding remains in item.yaml
 * and is included independently in the item content hash.
 */
export function symbolicReportDefinition(
  definition: FabricDefinition,
): FabricDefinition {
  validateReportDefinition(definition);
  return {
    ...definition,
    format: reportDefinitionFormat(definition),
    parts: definition.parts
      .map((part) => {
        const canonicalPath = canonicalReportPartPath(part.path);
        if (canonicalPath !== DEFINITION_PROPERTIES_PATH) {
          return { ...part, path: canonicalPath };
        }
        const properties = parseJsonObjectPart(part);
        const datasetReference =
          properties.datasetReference as Record<string, unknown>;
        const byConnection = {
          connectionString: SYMBOLIC_CONNECTION_STRING,
        };
        return {
          ...part,
          path: canonicalPath,
          payload: Buffer.from(
            stableJson({
              ...properties,
              datasetReference: {
                ...datasetReference,
                byConnection,
              },
            }),
            "utf8",
          ).toString("base64"),
        };
      })
      .sort((left, right) =>
        compareCanonicalStrings(left.path, right.path),
      ),
  };
}

function validateReportDefinition(
  definition: FabricDefinition,
): void {
  const canonicalParts = definition.parts.map((part) => ({
    part,
    path: canonicalReportPartPath(part.path),
  }));
  const duplicates = findCaseInsensitiveDuplicates(
    canonicalParts.map(({ path: partPath }) => partPath),
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Report definition contains duplicate or case-colliding paths: ${duplicates.join(", ")}.`,
    );
  }
  for (const { part } of canonicalParts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    requireCanonicalBase64(part);
  }

  const properties = canonicalParts.filter(
    ({ path: partPath }) =>
      partPath === DEFINITION_PROPERTIES_PATH,
  );
  if (properties.length !== 1) {
    throw new Error(
      "Report definition must contain exactly one definition.pbir part.",
    );
  }
  const format = reportDefinitionFormat(definition);
  const legacyParts = canonicalParts.filter(
    ({ path: partPath }) => partPath === LEGACY_REPORT_PATH,
  );
  const pbirParts = canonicalParts.filter(({ path: partPath }) =>
    partPath.startsWith(`${PBIR_DIRECTORY}/`),
  );
  if (legacyParts.length > 0 && pbirParts.length > 0) {
    throw new Error(
      "Report definition must not mix PBIR definition/** parts with PBIR-Legacy report.json.",
    );
  }
  if (format === "PBIR-Legacy" && legacyParts.length !== 1) {
    throw new Error(
      "PBIR-Legacy Report definition must contain exactly one root report.json part.",
    );
  }
  if (
    format === "PBIR" &&
    (!canonicalParts.some(
      ({ path: partPath }) =>
        partPath === "definition/report.json",
    ) ||
      !canonicalParts.some(
        ({ path: partPath }) =>
          partPath === "definition/version.json",
      ))
  ) {
    throw new Error(
      "PBIR Report definition must contain definition/report.json and definition/version.json.",
    );
  }

  for (const { part, path: partPath } of canonicalParts) {
    if (!isJsonReportPart(partPath)) {
      continue;
    }
    const value = parseJsonObjectPart(part);
    if (containsSensitivityLabelDeclaration(value)) {
      throw new Error(
        `Report definition part '${partPath}' declares a sensitivity label; manage labels outside definition deployment.`,
      );
    }
  }
  reportBindingConnectionString(definition);
}

function validateDesiredDefinitionProperties(
  definition: FabricDefinition,
): void {
  const part = definition.parts.find(
    (candidate) =>
      canonicalReportPartPath(candidate.path) ===
      DEFINITION_PROPERTIES_PATH,
  );
  if (!part) {
    return;
  }
  const properties = parseJsonObjectPart(part);
  if (
    typeof properties.$schema !== "string" ||
    !PBIR_SCHEMA_PATTERN.test(properties.$schema)
  ) {
    throw new Error(
      "Report definition.pbir must use the documented definitionProperties/2.x.x schema so the binding is represented only by connectionString.",
    );
  }
  if (typeof properties.version !== "string") {
    throw new Error(
      "Report definition.pbir must include a version string.",
    );
  }
  const versionMatch = /^([0-9]+)\.([0-9]+)$/.exec(
    properties.version,
  );
  if (!versionMatch) {
    throw new Error(
      `Report definition.pbir version '${properties.version}' is invalid.`,
    );
  }
  const major = Number(versionMatch[1]);
  const minor = Number(versionMatch[2]);
  if (
    major <= 0 ||
    (major === 1 && minor !== 0) ||
    (major >= 2 && major <= 3)
  ) {
    throw new Error(
      `Report definition.pbir version '${properties.version}' is not supported.`,
    );
  }
  if (
    major === 1 &&
    reportDefinitionFormat(definition) !== "PBIR-Legacy"
  ) {
    throw new Error(
      "Report definition.pbir version 1.0 supports PBIR-Legacy only; use version 4.0 or higher for PBIR.",
    );
  }
  if (reportDefinitionFormat(definition) === "PBIR") {
    const versionPart = definition.parts.find(
      (candidate) =>
        canonicalReportPartPath(candidate.path) ===
        "definition/version.json",
    );
    if (!versionPart) {
      return;
    }
    const versionMetadata = parseJsonObjectPart(versionPart);
    assertAllowedKeys(
      versionMetadata,
      new Set(["$schema", "version"]),
      "Report definition/version.json",
    );
    if (
      versionMetadata.$schema !==
      VERSION_METADATA_SCHEMA_URL
    ) {
      throw new Error(
        `Report definition/version.json must use '${VERSION_METADATA_SCHEMA_URL}'.`,
      );
    }
    if (
      typeof versionMetadata.version !== "string" ||
      !/^[1-9][0-9]*\.(0|[1-9][0-9]*)\.0$/.test(
        versionMetadata.version,
      )
    ) {
      throw new Error(
        "Report definition/version.json version must use major.minor.0 format.",
      );
    }
    const pagesMetadataPart = definition.parts.find(
      (candidate) =>
        canonicalReportPartPath(candidate.path) ===
        "definition/pages/pages.json",
    );
    const pageParts = definition.parts.filter((candidate) =>
      /^definition\/pages\/[^/]+\/page\.json$/.test(
        canonicalReportPartPath(candidate.path),
      ),
    );
    if (!pagesMetadataPart || pageParts.length === 0) {
      throw new Error(
        "PBIR Report definition must include definition/pages/pages.json and at least one page definition.",
      );
    }
    const pagesMetadata = parseJsonObjectPart(
      pagesMetadataPart,
    );
    assertAllowedKeys(
      pagesMetadata,
      new Set(["$schema", "pageOrder", "activePageName"]),
      "Report definition/pages/pages.json",
    );
    if (pagesMetadata.$schema !== PAGES_METADATA_SCHEMA_URL) {
      throw new Error(
        `Report definition/pages/pages.json must use '${PAGES_METADATA_SCHEMA_URL}'.`,
      );
    }
    const pageNames = new Set(
      pageParts.map((part) => {
        const canonicalPath = canonicalReportPartPath(
          part.path,
        );
        const pageName = canonicalPath.split("/")[2]!;
        const page = parseJsonObjectPart(part);
        if (page.name !== pageName) {
          throw new Error(
            `Report page '${canonicalPath}' must declare name '${pageName}'.`,
          );
        }
        return pageName;
      }),
    );
    if (pagesMetadata.pageOrder !== undefined) {
      if (
        !Array.isArray(pagesMetadata.pageOrder) ||
        pagesMetadata.pageOrder.some(
          (pageName) =>
            typeof pageName !== "string" ||
            !pageNames.has(pageName),
        )
      ) {
        throw new Error(
          "Report definition/pages/pages.json pageOrder must reference declared page definitions.",
        );
      }
    }
    if (
      pagesMetadata.activePageName !== undefined &&
      (typeof pagesMetadata.activePageName !== "string" ||
        !pageNames.has(pagesMetadata.activePageName))
    ) {
      throw new Error(
        "Report definition/pages/pages.json activePageName must reference a declared page definition.",
      );
    }
  }
}

function inferReportDefinitionFormat(
  parts: readonly FabricDefinitionPart[],
): ReportDefinitionFormat {
  const paths = parts.map((part) =>
    canonicalReportPartPath(part.path),
  );
  const hasLegacy = paths.includes(LEGACY_REPORT_PATH);
  const hasPbir = paths.some((partPath) =>
    partPath.startsWith(`${PBIR_DIRECTORY}/`),
  );
  if (hasLegacy && hasPbir) {
    throw new Error(
      "Report definition must not mix PBIR definition/** parts with PBIR-Legacy report.json.",
    );
  }
  if (hasLegacy) {
    return "PBIR-Legacy";
  }
  if (hasPbir) {
    return "PBIR";
  }
  throw new Error(
    "Report definition must include root report.json for PBIR-Legacy or definition/report.json and definition/version.json for PBIR.",
  );
}

function canonicalReportPartPath(partPath: string): string {
  const normalized = partPath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `Unsupported Report definition path '${partPath}'.`,
    );
  }
  const lower = normalized.toLowerCase();
  if (lower === DEFINITION_PROPERTIES_PATH.toLowerCase()) {
    return DEFINITION_PROPERTIES_PATH;
  }
  if (lower === LEGACY_REPORT_PATH.toLowerCase()) {
    return LEGACY_REPORT_PATH;
  }
  if (lower === PLATFORM_PATH) {
    return PLATFORM_PATH;
  }
  if (lower === DIAGRAM_LAYOUT_PATH.toLowerCase()) {
    return DIAGRAM_LAYOUT_PATH;
  }
  if (
    segments[0]?.toLowerCase() ===
    STATIC_RESOURCES_DIRECTORY.toLowerCase()
  ) {
    if (segments.length < 2) {
      throw new Error(
        `Unsupported Report definition path '${partPath}'.`,
      );
    }
    return [
      STATIC_RESOURCES_DIRECTORY,
      ...segments.slice(1),
    ].join("/");
  }
  if (segments[0]?.toLowerCase() !== PBIR_DIRECTORY) {
    throw new Error(
      `Unsupported Report definition path '${partPath}'.`,
    );
  }
  const relative = segments.slice(1);
  const lowered = relative.map((segment) => segment.toLowerCase());
  if (
    relative.length === 1 &&
    (lowered[0] === "report.json" ||
      lowered[0] === "version.json" ||
      lowered[0] === "reportextensions.json")
  ) {
    const fileName =
      lowered[0] === "reportextensions.json"
        ? "reportExtensions.json"
        : lowered[0];
    return `${PBIR_DIRECTORY}/${fileName}`;
  }
  if (
    relative.length === 2 &&
    lowered[0] === "pages" &&
    lowered[1] === "pages.json"
  ) {
    return `${PBIR_DIRECTORY}/pages/pages.json`;
  }
  if (
    relative.length === 3 &&
    lowered[0] === "pages" &&
    lowered[2] === "page.json"
  ) {
    return `${PBIR_DIRECTORY}/pages/${relative[1]}/page.json`;
  }
  if (
    relative.length === 5 &&
    lowered[0] === "pages" &&
    lowered[2] === "visuals" &&
    (lowered[4] === "visual.json" ||
      lowered[4] === "mobile.json")
  ) {
    return `${PBIR_DIRECTORY}/pages/${relative[1]}/visuals/${relative[3]}/${lowered[4]}`;
  }
  if (
    relative.length === 2 &&
    lowered[0] === "bookmarks" &&
    (lowered[1] === "bookmarks.json" ||
      lowered[1]?.endsWith(".bookmark.json"))
  ) {
    return `${PBIR_DIRECTORY}/bookmarks/${
      lowered[1] === "bookmarks.json"
        ? "bookmarks.json"
        : relative[1]
    }`;
  }
  throw new Error(
    `Unsupported Report definition path '${partPath}'.`,
  );
}

function isJsonReportPart(canonicalPath: string): boolean {
  return !canonicalPath.startsWith(
    `${STATIC_RESOURCES_DIRECTORY}/`,
  );
}

function isAuxiliaryReportPath(canonicalPath: string): boolean {
  return (
    canonicalPath === PLATFORM_PATH ||
    canonicalPath === DIAGRAM_LAYOUT_PATH
  );
}

function parseJsonObjectPart(
  part: FabricDefinitionPart,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(requireCanonicalBase64(part), "base64"),
      ),
    );
  } catch {
    throw new Error(
      `Report definition part '${part.path}' must contain valid UTF-8 JSON.`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `Report definition part '${part.path}' must contain a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function canonicalReportJsonValue(
  canonicalPath: string,
  value: Record<string, unknown>,
  includePhysicalBinding: boolean,
): Record<string, unknown> {
  if (canonicalPath !== DEFINITION_PROPERTIES_PATH) {
    return value;
  }
  const datasetReference =
    value.datasetReference as Record<string, unknown>;
  const byConnection =
    datasetReference.byConnection as Record<string, unknown>;
  const connectionString =
    typeof byConnection.connectionString === "string"
      ? byConnection.connectionString
      : "";
  return {
    ...value,
    datasetReference: {
      ...datasetReference,
      byConnection: {
        ...byConnection,
        connectionString: includePhysicalBinding
          ? `semanticmodelid=${semanticModelIdFromConnectionString(
              connectionString,
            )}`
          : SYMBOLIC_CONNECTION_STRING,
      },
    },
  };
}

function semanticModelIdFromConnectionString(
  connectionString: string,
): string {
  const matches = connectionString
    .split(";")
    .map((segment) => {
      const separator = segment.indexOf("=");
      return separator < 0
        ? undefined
        : {
            key: segment.slice(0, separator).trim(),
            value: segment.slice(separator + 1).trim(),
          };
    })
    .filter(
      (
        entry,
      ): entry is {
        key: string;
        value: string;
      } =>
        entry !== undefined &&
        entry.key.toLowerCase() === "semanticmodelid",
    );
  if (
    matches.length !== 1 ||
    matches[0]!.value === ""
  ) {
    throw new Error(
      "Report definition.pbir connectionString must contain exactly one non-empty semanticmodelid value.",
    );
  }
  return matches[0]!.value;
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
  return { ...value, metadata: normalizedMetadata };
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
    ([key, child]) =>
      key.toLowerCase().startsWith("sensitivitylabel") ||
      containsSensitivityLabelDeclaration(child),
  );
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  description: string,
): void {
  const unsupported = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort(compareCanonicalStrings);
  if (unsupported.length > 0) {
    throw new Error(
      `${description} contains unsupported properties: ${unsupported.join(", ")}.`,
    );
  }
}

function requireCanonicalBase64(
  part: FabricDefinitionPart,
): string {
  const value = part.payload;
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error(
      `Report definition part '${part.path}' must contain canonical base64 data.`,
    );
  }
  return value;
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  })) {
    const entryPath = path.join(directory, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        "Report definition must not contain symbolic links or junctions.",
      );
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile() && statSync(entryPath).isFile()) {
      files.push(entryPath);
    } else {
      throw new Error(
        `Report definition contains unsupported filesystem entry '${entry.name}'.`,
      );
    }
  }
  return files;
}

function findCaseInsensitiveDuplicates(
  values: readonly string[],
): string[] {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    const existing = seen.get(key);
    if (existing) {
      duplicates.add(existing);
      duplicates.add(value);
    } else {
      seen.set(key, value);
    }
  }
  return [...duplicates].sort(compareCanonicalStrings);
}
