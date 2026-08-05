import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

export const APACHE_AIRFLOW_DEFINITION_PATH =
  "apacheairflowjob-content.json";
export const APACHE_AIRFLOW_DOCUMENTED_DEFINITION_PATH =
  "ApacheAirflowJobV1.json";
export const APACHE_AIRFLOW_PLATFORM_PATH = ".platform";
export const APACHE_AIRFLOW_OWNERSHIP_PATH =
  "plugins/fabric-deploy-manifest.json";
export const APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES =
  2 * 1024 * 1024;

export interface ApacheAirflowSourceFile {
  filePath: string;
  payload: string;
  contentHash: string;
  sizeBytes: number;
}

export interface LoadedApacheAirflowBundle {
  definition: FabricDefinition;
  files: ApacheAirflowSourceFile[];
}

export function loadApacheAirflowBundle(
  itemDirectory: string,
): LoadedApacheAirflowBundle {
  const definitionDirectory = path.join(itemDirectory, "definition");
  const definitionParts: FabricDefinitionPart[] = [];
  const files: ApacheAirflowSourceFile[] = [];

  for (const filePath of listFiles(definitionDirectory)) {
    const relativePath = path
      .relative(definitionDirectory, filePath)
      .replaceAll("\\", "/");
    const content = readFileSync(filePath);
    if (
      relativePath === APACHE_AIRFLOW_DEFINITION_PATH ||
      relativePath === APACHE_AIRFLOW_PLATFORM_PATH
    ) {
      definitionParts.push({
        path: relativePath,
        payload: content.toString("base64"),
        payloadType: "InlineBase64",
      });
      continue;
    }
    if (relativePath === APACHE_AIRFLOW_DOCUMENTED_DEFINITION_PATH) {
      throw new Error(
        `Apache Airflow definition/${APACHE_AIRFLOW_DOCUMENTED_DEFINITION_PATH} is rejected by the live Fabric definition APIs. Export or author definition/${APACHE_AIRFLOW_DEFINITION_PATH} instead.`,
      );
    }
    validateApacheAirflowFilePath(relativePath);
    if (relativePath === APACHE_AIRFLOW_OWNERSHIP_PATH) {
      throw new Error(
        `Apache Airflow file '${relativePath}' is reserved for Fabric Deploy ownership state.`,
      );
    }
    if (content.byteLength > APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Apache Airflow file '${relativePath}' exceeds the 2 MB Fabric file limit.`,
      );
    }
    if (relativePath.toLowerCase().endsWith(".py")) {
      assertUtf8(content, relativePath);
    }
    files.push({
      filePath: relativePath,
      payload: content.toString("base64"),
      contentHash: sha256Bytes(content),
      sizeBytes: content.byteLength,
    });
  }

  const definition = {
    parts: definitionParts.sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    ),
  } satisfies FabricDefinition;
  validateApacheAirflowDefinition(definition);
  return {
    definition,
    files: files.sort((left, right) =>
      compareCanonicalStrings(left.filePath, right.filePath),
    ),
  };
}

export function validateApacheAirflowDefinition(
  definition: FabricDefinition,
): void {
  apacheAirflowDefinitionFormat(definition);
  const paths = new Set<string>();
  for (const part of definition.parts) {
    if (part.payloadType !== "InlineBase64") {
      throw new Error(
        `Unsupported Fabric definition payload type '${part.payloadType}'.`,
      );
    }
    if (paths.has(part.path)) {
      throw new Error(
        `Apache Airflow definition contains duplicate part '${part.path}'.`,
      );
    }
    paths.add(part.path);
    if (part.path === APACHE_AIRFLOW_DEFINITION_PATH) {
      validateApacheAirflowProperties(part);
    } else if (part.path === APACHE_AIRFLOW_PLATFORM_PATH) {
      parseJsonObject(part, "Apache Airflow .platform");
    } else {
      throw new Error(
        `Unsupported Apache Airflow definition part '${part.path}'.`,
      );
    }
  }
  if (!paths.has(APACHE_AIRFLOW_DEFINITION_PATH)) {
    throw new Error(
      `Apache Airflow definition must include definition/${APACHE_AIRFLOW_DEFINITION_PATH}.`,
    );
  }
}

export function hashApacheAirflowDefinition(
  definition: FabricDefinition,
  includePlatformPart: boolean,
): string {
  validateApacheAirflowDefinition(definition);
  const parts = definition.parts
    .filter(
      (part) =>
        includePlatformPart ||
        part.path !== APACHE_AIRFLOW_PLATFORM_PATH,
    )
    .map((part) => ({
      path: part.path,
      payload: canonicalApacheAirflowPayload(part),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );
  return sha256(
    stableJson({
      format: apacheAirflowDefinitionFormat(definition),
      parts,
    }),
  );
}

export function hashApacheAirflowFiles(
  files: readonly ApacheAirflowSourceFile[],
): string {
  return sha256(
    stableJson(
      [...files]
        .map((file) => ({
          filePath: file.filePath,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
        }))
        .sort((left, right) =>
          compareCanonicalStrings(left.filePath, right.filePath),
        ),
    ),
  );
}

export function hashApacheAirflowBundle(
  bundle: LoadedApacheAirflowBundle,
): string {
  return sha256(
    stableJson({
      definitionHash: hashApacheAirflowDefinition(
        bundle.definition,
        apacheAirflowIncludesPlatformPart(bundle.definition),
      ),
      filesHash: hashApacheAirflowFiles(bundle.files),
    }),
  );
}

export function apacheAirflowIncludesPlatformPart(
  definition: FabricDefinition,
): boolean {
  return definition.parts.some(
    (part) => part.path === APACHE_AIRFLOW_PLATFORM_PATH,
  );
}

export function isUntouchedApacheAirflowShellDefinition(
  definition: FabricDefinition,
): boolean {
  try {
    validateApacheAirflowDefinition(definition);
    const part = definition.parts.find(
      (candidate) =>
        candidate.path === APACHE_AIRFLOW_DEFINITION_PATH,
    );
    if (!part) {
      return false;
    }
    const root = parseJsonObject(
      part,
      `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH}`,
    );
    const properties = requireObject(
      root.properties,
      "Apache Airflow shell properties",
    );
    const typeProperties = requireObject(
      properties.typeProperties,
      "Apache Airflow shell typeProperties",
    );
    const airflowProperties = requireObject(
      typeProperties.airflowProperties,
      "Apache Airflow shell airflowProperties",
    );
    const computeProperties = requireObject(
      typeProperties.computeProperties,
      "Apache Airflow shell computeProperties",
    );
    const packageProviderPath =
      airflowProperties.packageProviderPath;
    return (
      properties.type === "Airflow" &&
      isNonEmptyString(airflowProperties.airflowVersion) &&
      isNonEmptyString(airflowProperties.pythonVersion) &&
      isNonEmptyString(airflowProperties.airflowEnvironment) &&
      isEmptyObject(
        airflowProperties.airflowConfigurationOverrides,
      ) &&
      isEmptyObject(
        airflowProperties.airflowEnvironmentVariables,
      ) &&
      Array.isArray(airflowProperties.airflowRequirements) &&
      airflowProperties.airflowRequirements.length === 0 &&
      airflowProperties.enableAADIntegration === true &&
      airflowProperties.enableTriggerers === false &&
      (packageProviderPath === undefined ||
        packageProviderPath === "plugins") &&
      computeProperties.computePool === "StarterPool" &&
      computeProperties.computeSize === "Small" &&
      computeProperties.extraNodes === 0 &&
      computeProperties.enableAutoscale === false &&
      computeProperties.enableAvailabilityZones === true &&
      (computeProperties.poolId === undefined ||
        computeProperties.poolId ===
          "00000000-0000-0000-0000-000000000000") &&
      (computeProperties.vnetEnabled === undefined ||
        computeProperties.vnetEnabled === false)
    );
  } catch {
    return false;
  }
}

export function apacheAirflowDefinitionFormat(
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
      `Unsupported Apache Airflow definition format '${format}'.`,
    );
  }
  return "JSON";
}

export function decodeApacheAirflowFile(
  file: ApacheAirflowSourceFile,
): Uint8Array {
  const content = Buffer.from(file.payload, "base64");
  if (
    content.byteLength !== file.sizeBytes ||
    sha256Bytes(content) !== file.contentHash
  ) {
    throw new Error(
      `Apache Airflow file '${file.filePath}' no longer matches its captured source hash.`,
    );
  }
  return content;
}

export function validateApacheAirflowFilePath(
  filePath: string,
): void {
  if (
    filePath.includes("\\") ||
    filePath.startsWith("/") ||
    filePath.endsWith("/") ||
    filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    (!filePath.startsWith("dags/") &&
      !filePath.startsWith("plugins/"))
  ) {
    throw new Error(
      `Apache Airflow file path '${filePath}' must be a relative path under dags/ or plugins/.`,
    );
  }
}

function validateApacheAirflowProperties(
  part: FabricDefinitionPart,
): void {
  const root = parseJsonObject(
    part,
    `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH}`,
  );
  const properties = requireObject(
    root.properties,
    `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} properties`,
  );
  if (properties.type !== "Airflow") {
    throw new Error(
      `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} properties.type must be 'Airflow'.`,
    );
  }
  const typeProperties = requireObject(
    properties.typeProperties,
    `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} properties.typeProperties`,
  );
  const airflowProperties = requireObject(
    typeProperties.airflowProperties,
    `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} airflowProperties`,
  );
  requireObject(
    typeProperties.computeProperties,
    `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} computeProperties`,
  );
  if (
    airflowProperties.airflowRequirements !== undefined &&
    (!Array.isArray(airflowProperties.airflowRequirements) ||
      !airflowProperties.airflowRequirements.every(
        (requirement) =>
          typeof requirement === "string" &&
          requirement.trim() !== "",
      ))
  ) {
    throw new Error(
      `Apache Airflow ${APACHE_AIRFLOW_DEFINITION_PATH} airflowRequirements must be an array of non-empty strings.`,
    );
  }
}

function canonicalApacheAirflowPayload(
  part: FabricDefinitionPart,
): string {
  const value = parseJsonObject(
    part,
    `Apache Airflow '${part.path}'`,
  );
  if (part.path !== APACHE_AIRFLOW_PLATFORM_PATH) {
    return stableJson(stripSchemaProperties(value));
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

function stripSchemaProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSchemaProperties);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "$schema")
      .map(([key, entry]) => [key, stripSchemaProperties(entry)]),
  );
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
  return requireObject(value, description);
}

function requireObject(
  value: unknown,
  description: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function isEmptyObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function assertUtf8(content: Buffer, filePath: string): void {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(
      `Apache Airflow Python file '${filePath}' must contain valid UTF-8 text.`,
    );
  }
}

function sha256Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Apache Airflow definitions cannot contain symbolic links: ${entryPath}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
