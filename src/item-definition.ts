import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import path from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

import { loadEnvironmentDefinition } from "./fabric/definition";
import { loadNotebookDefinition } from "./fabric/notebook-definition";
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
    desiredState: { const: "present" },
    folderId: { type: "string", minLength: 1 },
    enableSchemas: { const: true },
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
  logicalIds: Set<string>,
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
  validateReferences(item.logicalId, definition, logicalIds, dependencies);
  validateBindings(item.logicalId, definition, logicalIds, dependencies);
  validateTypeSpecificDefinition(item, itemDirectory, definition);
  return definition;
}

function validateReferences(
  logicalId: string,
  definition: ItemDefinition,
  logicalIds: Set<string>,
  dependencies: Set<string>,
): void {
  for (const [name, target] of Object.entries(definition.references ?? {})) {
    if (!logicalIds.has(target)) {
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
  logicalIds: Set<string>,
  dependencies: Set<string>,
): void {
  for (const binding of definition.bindings ?? []) {
    const itemMatch = /^(?:item|items)\.([A-Za-z][A-Za-z0-9_-]*)\.id$/.exec(
      binding.valueFrom,
    );
    if (itemMatch) {
      const target = itemMatch[1];
      if (!target || !logicalIds.has(target)) {
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

  switch (item.type) {
    case "Lakehouse":
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

function requireSparkJobDefinition(
  item: DeploymentItem,
  itemDirectory: string,
): void {
  const directory = definitionDirectory(item, itemDirectory);
  const candidates = ["main.py", "main.scala"].filter((name) =>
    existsSync(path.join(directory, name)) &&
    statSync(path.join(directory, name)).isFile(),
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Item '${item.logicalId}' requires exactly one definition/main.py or definition/main.scala file.`,
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

function assertNever(value: FabricItemType): never {
  throw new Error(`Unsupported Fabric item type '${value}'.`);
}
