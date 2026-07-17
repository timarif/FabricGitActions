import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import Ajv, { type ErrorObject } from "ajv";
import { parse } from "yaml";

import { sha256, stableJson } from "../hash";
import type { ItemDefinition } from "../types";

export const SPARK_CUSTOM_POOL_NODE_FAMILIES = [
  "MemoryOptimized",
] as const;
export type SparkCustomPoolNodeFamily =
  (typeof SPARK_CUSTOM_POOL_NODE_FAMILIES)[number];

export const SPARK_CUSTOM_POOL_NODE_SIZES = [
  "Small",
  "Medium",
  "Large",
  "XLarge",
  "XXLarge",
] as const;
export type SparkCustomPoolNodeSize =
  (typeof SPARK_CUSTOM_POOL_NODE_SIZES)[number];

export interface SparkCustomPoolAutoScale {
  enabled: boolean;
  minNodeCount: number;
  maxNodeCount: number;
}

export interface SparkCustomPoolDynamicExecutorAllocation {
  enabled: boolean;
  minExecutors: number;
  maxExecutors: number;
}

export interface SparkCustomPoolDefinition {
  nodeFamily: SparkCustomPoolNodeFamily;
  nodeSize: SparkCustomPoolNodeSize;
  autoScale: SparkCustomPoolAutoScale;
  dynamicExecutorAllocation: SparkCustomPoolDynamicExecutorAllocation;
}

const poolDefinitionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "nodeFamily",
    "nodeSize",
    "autoScale",
    "dynamicExecutorAllocation",
  ],
  properties: {
    nodeFamily: {
      enum: SPARK_CUSTOM_POOL_NODE_FAMILIES,
    },
    nodeSize: {
      enum: SPARK_CUSTOM_POOL_NODE_SIZES,
    },
    autoScale: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "minNodeCount", "maxNodeCount"],
      properties: {
        enabled: { type: "boolean" },
        minNodeCount: {
          type: "integer",
          minimum: 1,
          maximum: 200,
        },
        maxNodeCount: {
          type: "integer",
          minimum: 1,
          maximum: 200,
        },
      },
    },
    dynamicExecutorAllocation: {
      type: "object",
      additionalProperties: false,
      required: ["enabled", "minExecutors", "maxExecutors"],
      properties: {
        enabled: { type: "boolean" },
        minExecutors: {
          type: "integer",
          minimum: 1,
        },
        maxExecutors: {
          type: "integer",
          minimum: 1,
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePoolDefinition = ajv.compile(poolDefinitionSchema);

export function loadSparkCustomPoolDefinition(
  itemDirectory: string,
): SparkCustomPoolDefinition {
  const definitionPath = path.join(
    itemDirectory,
    "definition",
    "pool.yaml",
  );
  if (!existsSync(definitionPath) || !statSync(definitionPath).isFile()) {
    throw new Error(
      `Spark custom pool definition requires definition/pool.yaml: ${definitionPath}`,
    );
  }
  const definitionDirectory = path.dirname(definitionPath);
  const unsupported = listFiles(definitionDirectory).filter(
    (filePath) => filePath !== definitionPath,
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Unsupported Spark custom pool definition path '${path
        .relative(definitionDirectory, unsupported[0]!)
        .replaceAll("\\", "/")}'.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parse(readFileSync(definitionPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Spark custom pool definition is not valid YAML: ${formatCause(error)}`,
    );
  }

  return assertValidSparkCustomPoolDefinition(parsed);
}

export function assertValidSparkCustomPoolDefinition(
  value: unknown,
): SparkCustomPoolDefinition {
  if (!validatePoolDefinition(value)) {
    throw new Error(
      `Invalid Spark custom pool definition: ${formatValidationErrors(
        validatePoolDefinition.errors,
      )}`,
    );
  }

  const definition = value as SparkCustomPoolDefinition;
  if (definition.autoScale.minNodeCount > definition.autoScale.maxNodeCount) {
    throw new Error(
      "Invalid Spark custom pool definition: autoScale.minNodeCount must be less than or equal to autoScale.maxNodeCount.",
    );
  }
  if (
    definition.dynamicExecutorAllocation.minExecutors >
    definition.dynamicExecutorAllocation.maxExecutors
  ) {
    throw new Error(
      "Invalid Spark custom pool definition: dynamicExecutorAllocation.minExecutors must be less than or equal to dynamicExecutorAllocation.maxExecutors.",
    );
  }

  return definition;
}

export function hashSparkCustomPoolDefinition(
  definition: SparkCustomPoolDefinition,
): string {
  return sha256(
    stableJson(assertValidSparkCustomPoolDefinition(definition)),
  );
}

export function assertValidSparkCustomPoolItemDefinition(
  definition: ItemDefinition,
): void {
  if (
    definition.displayName.length < 1 ||
    definition.displayName.length > 64 ||
    !/^[A-Za-z0-9 _-]+$/.test(definition.displayName)
  ) {
    throw new Error(
      `Spark custom pool name '${definition.displayName}' must be 1-64 characters and contain only letters, numbers, spaces, dashes, and underscores.`,
    );
  }
  if (definition.description !== undefined) {
    throw new Error("Spark custom pools do not support description.");
  }
  if (definition.folderId !== undefined) {
    throw new Error("Spark custom pools do not support folderId.");
  }
  if (definition.enableSchemas !== undefined) {
    throw new Error("Spark custom pools do not support enableSchemas.");
  }
  if (Object.keys(definition.references ?? {}).length > 0) {
    throw new Error("Spark custom pools do not support references.");
  }
  if ((definition.bindings?.length ?? 0) > 0) {
    throw new Error("Spark custom pools do not support bindings.");
  }
}

function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  return (errors ?? [])
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

function formatCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
