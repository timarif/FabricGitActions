import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

import { loadEnvironmentDefinition } from "./fabric/definition";
import { loadEventstreamDefinition } from "./fabric/eventstream-definition";
import { loadNotebookDefinition } from "./fabric/notebook-definition";
import { loadCopyJobDefinition } from "./fabric/copy-job-definition";
import { loadReportDefinition } from "./fabric/report-definition";
import { loadSemanticModelDefinition } from "./fabric/semantic-model-definition";
import {
  assertValidSparkCustomPoolItemDefinition,
  loadSparkCustomPoolDefinition,
} from "./fabric/spark-custom-pool-definition";
import { substituteVariables } from "./substitution";
import type {
  DeploymentItem,
  FabricItemType,
  ItemDefinition,
} from "./types";

const itemDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["displayName"],
  properties: {
    displayName: { type: "string", minLength: 1, maxLength: 256 },
    description: { type: "string", maxLength: 256 },
    desiredState: { enum: ["present", "absent"] },
    folderId: { type: "string", minLength: 1 },
    enableSchemas: { const: true },
    minimumConsumptionUnits: {
      type: "number",
      minimum: 0,
      maximum: 322,
    },
    databaseType: {
      const: "ReadWrite",
    },
    collationType: {
      type: "string",
      enum: [
        "Latin1_General_100_BIN2_UTF8",
        "Latin1_General_100_CI_AS_KS_WS_SC_UTF8",
      ],
    },
    scope: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type"],
          properties: {
            type: { const: "Tenant" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "domainId"],
          properties: {
            type: { const: "Domain" },
            domainId: {
              type: "string",
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
            },
          },
        },
      ],
    },
    tags: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
      },
    },
    references: {
      type: "object",
      additionalProperties: {
        type: "string",
        minLength: 1,
      },
    },
    bindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "valueFrom"],
        properties: {
          target: {
            type: "string",
            pattern: "^/",
          },
          valueFrom: {
            type: "string",
            minLength: 1,
          },
        },
      },
    },
  },
} as const;

function formatValidationErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export function loadAndValidateItemDefinition(
  item: DeploymentItem,
  itemDirectory: string,
  itemTypes: ReadonlyMap<string, FabricItemType>,
  dependencies: Set<string>,
  variables: Record<string, string>,
): ItemDefinition {
  const definitionPath = path.join(itemDirectory, "item.yaml");
  if (!existsSync(definitionPath) || !statSync(definitionPath).isFile()) {
    throw new Error(`Item '${item.logicalId}' requires an item.yaml file.`);
  }

  const parsed = parse(readFileSync(definitionPath, "utf8")) as unknown;
  const resolved = substituteVariables(parsed, variables);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(itemDefinitionSchema);
  if (!validate(resolved)) {
    throw new Error(
      `Invalid item definition for '${item.logicalId}': ${formatValidationErrors(
        validate.errors,
      )}`,
    );
  }

  const definition = resolved as ItemDefinition;
  const manifestDesiredState = item.desiredState ?? "present";
  const definitionDesiredState = definition.desiredState ?? "present";
  if (manifestDesiredState !== definitionDesiredState) {
    throw new Error(
      `Item '${item.logicalId}' item.yaml desiredState '${definitionDesiredState}' does not match deployment manifest desiredState '${manifestDesiredState}'.`,
    );
  }
  if (
    item.type === "LakehouseTables" &&
    (resolved === null ||
      typeof resolved !== "object" ||
      !Object.hasOwn(resolved, "desiredState"))
  ) {
    throw new Error(
      `Item '${item.logicalId}' (LakehouseTables) must explicitly set desiredState: present.`,
    );
  }
  if (manifestDesiredState === "absent") {
    validateDeletionDefinition(item, definition);
    return definition;
  }
  validateReferences(item.logicalId, definition, itemTypes, dependencies);
  validateBindings(item.logicalId, definition, itemTypes, dependencies);
  validateTags(item, definition, itemTypes, dependencies);
  validateTypeSpecificDefinition(item, itemDirectory, definition);
  return definition;
}

function validateDeletionDefinition(
  item: DeploymentItem,
  definition: ItemDefinition,
): void {
  if (
    definition.description !== undefined ||
    definition.enableSchemas !== undefined ||
    definition.minimumConsumptionUnits !== undefined ||
    definition.databaseType !== undefined ||
    definition.collationType !== undefined ||
    definition.scope !== undefined ||
    definition.tags !== undefined ||
    definition.references !== undefined ||
    definition.bindings !== undefined
  ) {
    throw new Error(
      `Deletion item '${item.logicalId}' supports only displayName, desiredState, and optional folderId.`,
    );
  }

  switch (item.type) {
    case "Lakehouse":
    case "Environment":
    case "Notebook":
    case "SparkJobDefinition":
    case "DataPipeline":
    case "CopyJob":
    case "SemanticModel":
    case "Eventstream":
      return;
    case "Eventhouse":
    case "KQLDatabase":
    case "FabricTag":
    case "LakehouseTables":
    case "SparkCustomPool":
    case "Report":
    case "Warehouse":
      throw new Error(
        `Item '${item.logicalId}' of type ${item.type} does not support desiredState: absent.`,
      );
    default:
      assertNever(item.type);
  }
}

function validateReferences(
  logicalId: string,
  definition: ItemDefinition,
  itemTypes: ReadonlyMap<string, FabricItemType>,
  dependencies: Set<string>,
): void {
  for (const [name, target] of Object.entries(definition.references ?? {})) {
    if (!itemTypes.has(target)) {
      throw new Error(
        `Item '${logicalId}' reference '${name}' targets unknown logicalId '${target}'.`,
      );
    }
    requireDependency(logicalId, target, dependencies, `reference '${name}'`);
  }
}

function validateBindings(
  logicalId: string,
  definition: ItemDefinition,
  itemTypes: ReadonlyMap<string, FabricItemType>,
  dependencies: Set<string>,
): void {
  for (const binding of definition.bindings ?? []) {
    const itemMatch = /^(?:item|items)\.([A-Za-z][A-Za-z0-9_-]*)\.id$/.exec(
      binding.valueFrom,
    );
    if (itemMatch) {
      const target = itemMatch[1];
      if (!target || !itemTypes.has(target)) {
        throw new Error(
          `Item '${logicalId}' binding targets unknown logicalId '${target ?? ""}'.`,
        );
      }
      requireDependency(
        logicalId,
        target,
        dependencies,
        `binding '${binding.target}'`,
      );
      continue;
    }

    if (!/^parameter\.[A-Za-z_][A-Za-z0-9_]*$/.test(binding.valueFrom)) {
      throw new Error(
        `Item '${logicalId}' binding valueFrom '${binding.valueFrom}' is invalid.`,
      );
    }
  }
}

function validateTags(
  item: DeploymentItem,
  definition: ItemDefinition,
  itemTypes: ReadonlyMap<string, FabricItemType>,
  dependencies: Set<string>,
): void {
  if (!definition.tags) {
    return;
  }
  if (
    item.type === "FabricTag" ||
    item.type === "LakehouseTables" ||
    item.type === "SparkCustomPool"
  ) {
    throw new Error(
      `Item '${item.logicalId}' of type ${item.type} does not support Fabric tag assignment.`,
    );
  }
  for (const target of definition.tags) {
    const targetType = itemTypes.get(target);
    if (!targetType) {
      throw new Error(
        `Item '${item.logicalId}' tag targets unknown logicalId '${target}'.`,
      );
    }
    if (targetType !== "FabricTag") {
      throw new Error(
        `Item '${item.logicalId}' tag '${target}' must target a FabricTag item.`,
      );
    }
    requireDependency(
      item.logicalId,
      target,
      dependencies,
      `tag '${target}'`,
    );
  }
}

function requireDependency(
  logicalId: string,
  target: string,
  dependencies: Set<string>,
  source: string,
): void {
  if (!dependencies.has(target)) {
    throw new Error(
      `Item '${logicalId}' ${source} targets '${target}', but dependsOn does not include it.`,
    );
  }
}

function validateTypeSpecificDefinition(
  item: DeploymentItem,
  itemDirectory: string,
  definition: ItemDefinition,
): void {
  if (item.type !== "Lakehouse" && definition.enableSchemas !== undefined) {
    throw new Error(
      `Item '${item.logicalId}' can use enableSchemas only when type is Lakehouse.`,
    );
  }
  if (item.type !== "FabricTag" && definition.scope !== undefined) {
    throw new Error(
      `Item '${item.logicalId}' can use scope only when type is FabricTag.`,
    );
  }
  if (
    item.type !== "Eventhouse" &&
    definition.minimumConsumptionUnits !== undefined
  ) {
    throw new Error(
      `Item '${item.logicalId}' can use minimumConsumptionUnits only when type is Eventhouse.`,
    );
  }
  if (
    item.type !== "KQLDatabase" &&
    definition.databaseType !== undefined
  ) {
    throw new Error(
      `Item '${item.logicalId}' can use databaseType only when type is KQLDatabase.`,
    );
  }
  if (
    item.type !== "Warehouse" &&
    definition.collationType !== undefined
  ) {
    throw new Error(
      `Item '${item.logicalId}' can use collationType only when type is Warehouse.`,
    );
  }

  switch (item.type) {
    case "Lakehouse":
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,122}$/.test(
          definition.displayName,
        )
      ) {
        throw new Error(
          `Item '${item.logicalId}' Lakehouse displayName must begin with a letter, contain only letters, numbers, and underscores, and be at most 123 characters.`,
        );
      }
      return;
    case "Eventhouse":
      if (!/^[A-Za-z0-9_.-]+$/.test(definition.displayName)) {
        throw new Error(
          `Item '${item.logicalId}' Eventhouse displayName can contain only letters, numbers, underscores, periods, and hyphens.`,
        );
      }
      if (
        definition.minimumConsumptionUnits !== undefined &&
        !isSupportedMinimumConsumptionUnits(
          definition.minimumConsumptionUnits,
        )
      ) {
        throw new Error(
          `Item '${item.logicalId}' minimumConsumptionUnits must be one of 0, 2.25, 4.25, 8.5, 13, 18, 26, 34, 50, or any number from 51 through 322.`,
        );
      }
      assertNoDefinitionDirectory(item, itemDirectory);
      return;
    case "KQLDatabase":
      if (!/^[A-Za-z0-9_.-]{1,123}$/.test(definition.displayName)) {
        throw new Error(
          `Item '${item.logicalId}' KQLDatabase displayName must be at most 123 characters and can contain only letters, numbers, underscores, periods, and hyphens.`,
        );
      }
      assertNoDefinitionDirectory(item, itemDirectory);
      return;
    case "LakehouseTables":
      definitionDirectory(item, itemDirectory);
      return;
    case "FabricTag":
      if (definition.displayName.length > 40) {
        throw new Error(
          `Item '${item.logicalId}' FabricTag displayName must be at most 40 characters.`,
        );
      }
      if (
        definition.description !== undefined ||
        definition.folderId !== undefined ||
        definition.enableSchemas !== undefined ||
        definition.references !== undefined ||
        definition.bindings !== undefined ||
        definition.tags !== undefined ||
        (item.dependsOn?.length ?? 0) > 0
      ) {
        throw new Error(
          `Item '${item.logicalId}' FabricTag supports only displayName, desiredState, and scope.`,
        );
      }
      return;
    case "Environment":
      definitionDirectory(item, itemDirectory);
      loadEnvironmentDefinition(itemDirectory);
      return;
    case "SparkCustomPool":
      definitionDirectory(item, itemDirectory);
      assertValidSparkCustomPoolItemDefinition(definition);
      loadSparkCustomPoolDefinition(itemDirectory);
      return;
    case "Notebook":
      definitionDirectory(item, itemDirectory);
      loadNotebookDefinition(itemDirectory);
      return;
    case "SparkJobDefinition":
      requireSparkJobDefinition(item, itemDirectory);
      return;
    case "DataPipeline":
      requirePipelineDefinition(item, itemDirectory);
      return;
    case "CopyJob":
      requireCopyJobDefinition(item, itemDirectory);
      return;
    case "SemanticModel":
      definitionDirectory(item, itemDirectory);
      loadSemanticModelDefinition(itemDirectory);
      return;
    case "Report":
      definitionDirectory(item, itemDirectory);
      loadReportDefinition(itemDirectory);
      return;
    case "Warehouse":
      // No definition directory — all warehouse DDL is applied via T-SQL
      // through the SQL endpoint (deferred to a future WarehouseTables adapter).
      assertNoWarehouseDefinitionDirectory(item, itemDirectory);
      return;
    case "Eventstream":
      definitionDirectory(item, itemDirectory);
      loadEventstreamDefinition(itemDirectory);
      return;
    default:
      assertNever(item.type);
  }
}

function definitionDirectory(item: DeploymentItem, itemDirectory: string): string {
  const directory = path.join(itemDirectory, "definition");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(
      `Item '${item.logicalId}' (${item.type}) requires a definition directory.`,
    );
  }
  return directory;
}

function assertNoDefinitionDirectory(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const directory = path.join(itemDirectory, "definition");
  if (existsSync(directory)) {
    throw new Error(
      `Item '${item.logicalId}' (${item.type}) does not support a definition directory; configure minimumConsumptionUnits in item.yaml.`,
    );
  }
}

function assertNoWarehouseDefinitionDirectory(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const directory = path.join(itemDirectory, "definition");
  if (existsSync(directory)) {
    throw new Error(
      `Item '${item.logicalId}' (Warehouse) does not support a definition directory. ` +
        `Warehouse schema and table DDL is managed separately via T-SQL through the SQL endpoint.`,
    );
  }
}

function isSupportedMinimumConsumptionUnits(value: number): boolean {
  return (
    Number.isFinite(value) &&
    (value === 0 ||
      value === 2.25 ||
      value === 4.25 ||
      value === 8.5 ||
      value === 13 ||
      value === 18 ||
      value === 26 ||
      value === 34 ||
      value === 50 ||
      (value >= 51 && value <= 322))
  );
}

function requireSparkJobDefinition(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const directory = definitionDirectory(item, itemDirectory);
  const candidates = ["main.py", "main.jar"].filter((name) =>
    existsSync(path.join(directory, name)) &&
    statSync(path.join(directory, name)).isFile(),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Item '${item.logicalId}' requires exactly one definition/main.py or definition/main.jar file.`,
    );
  }
}

function requirePipelineDefinition(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const pipelinePath = path.join(
    definitionDirectory(item, itemDirectory),
    "pipeline-content.json",
  );
  if (!existsSync(pipelinePath) || !statSync(pipelinePath).isFile()) {
    throw new Error(
      `Item '${item.logicalId}' requires definition/pipeline-content.json.`,
    );
  }
  parseJsonObject(pipelinePath, item.logicalId, "pipeline");
}

function parseJsonObject(
  filePath: string,
  logicalId: string,
  description: string,
): void {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(
      `Item '${logicalId}' ${description} definition is not valid JSON.`,
    );
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      `Item '${logicalId}' ${description} definition must be a JSON object.`,
    );
  }
}

function requireCopyJobDefinition(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const copyJobContentPath = path.join(
    definitionDirectory(item, itemDirectory),
    "copyjob-content.json",
  );
  if (
    !existsSync(copyJobContentPath) ||
    !statSync(copyJobContentPath).isFile()
  ) {
    throw new Error(
      `Item '${item.logicalId}' requires definition/copyjob-content.json.`,
    );
  }
  loadCopyJobDefinition(itemDirectory);
}

function assertNever(value: FabricItemType): never {
  throw new Error(`Unsupported Fabric item type '${value}'.`);
}
