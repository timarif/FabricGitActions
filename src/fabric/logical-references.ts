import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "../hash";
import type {
  DeploymentItem,
  FabricItemType,
  ItemBinding,
  ItemDefinition,
} from "../types";
import type {
  FabricDefinition,
  FabricDefinitionPart,
} from "./definition";
import {
  hashSparkJobDefinition,
  sparkJobIncludesPlatformPart,
} from "./spark-job-definition";

const CONFIG_PATH = "SparkJobDefinitionV1.json";

const SUPPORTED_TARGETS = [
  {
    referenceName: "defaultLakehouse",
    target: "/properties/defaultLakehouseArtifactId",
    configurationField: "defaultLakehouseArtifactId",
    targetType: "Lakehouse",
  },
  {
    referenceName: "environment",
    target: "/properties/environmentArtifactId",
    configurationField: "environmentArtifactId",
    targetType: "Environment",
  },
] as const;

export type SupportedLogicalReferenceTarget =
  (typeof SUPPORTED_TARGETS)[number]["target"];

export type SparkJobArtifactIdField =
  (typeof SUPPORTED_TARGETS)[number]["configurationField"];

export interface CanonicalResolvedBinding {
  logicalId: string;
  valueFrom: `items.${string}.id`;
  targetType: Extract<FabricItemType, "Lakehouse" | "Environment">;
}

export type CanonicalResolvedBindingMap = Readonly<
  Partial<
    Record<SupportedLogicalReferenceTarget, CanonicalResolvedBinding>
  >
>;

export type SparkJobDefinitionSnapshot = FabricDefinition;

export interface LogicalReferenceValidationInput {
  item: DeploymentItem;
  definition: Pick<ItemDefinition, "references" | "bindings">;
  itemGraph: readonly DeploymentItem[];
}

export interface SparkJobLogicalReferenceMaterialization {
  definition: SparkJobDefinitionSnapshot;
  materializedDefinitionHash: string;
  resolvedBindingsHash: string;
}

/**
 * Validates and canonicalizes symbolic declarations without requiring live IDs.
 *
 * Explicit bindings use `/properties/<artifact field>` targets. Both the
 * canonical `items.<logicalId>.id` source and the currently accepted legacy
 * `item.<logicalId>.id` source are recognized; output always uses `items`.
 */
export function validateLogicalReferenceDeclarations(
  input: LogicalReferenceValidationInput,
): CanonicalResolvedBindingMap {
  if (input.item.type === "LakehouseTables") {
    validateLakehouseTablesReference(input);
    return {};
  }
  const declarations =
    Object.keys(input.definition.references ?? {}).length > 0 ||
    (input.definition.bindings?.length ?? 0) > 0;
  if (!declarations) {
    return {};
  }

  function validateLakehouseTablesReference(
    input: LogicalReferenceValidationInput,
  ): void {
    const entries = Object.entries(input.definition.references ?? {});
    if (
      entries.length !== 1 ||
      entries[0]?.[0] !== "lakehouse" ||
      typeof entries[0]?.[1] !== "string" ||
      entries[0][1].length === 0
    ) {
      throw new Error(
        `Item '${input.item.logicalId}' (LakehouseTables) must declare exactly one references.lakehouse logical ID.`,
      );
    }
    if ((input.definition.bindings?.length ?? 0) !== 0) {
      throw new Error(
        `Item '${input.item.logicalId}' (LakehouseTables) does not support bindings.`,
      );
    }
    const targetLogicalId = entries[0][1];
    const target = input.itemGraph.find(
      (candidate) => candidate.logicalId === targetLogicalId,
    );
    if (!target) {
      throw new Error(
        `Item '${input.item.logicalId}' reference 'lakehouse' targets unknown logicalId '${targetLogicalId}'.`,
      );
    }
    if (target.type !== "Lakehouse") {
      throw new Error(
        `Item '${input.item.logicalId}' reference 'lakehouse' targets '${targetLogicalId}' (${target.type}), but requires type 'Lakehouse'.`,
      );
    }
    if (!(input.item.dependsOn ?? []).includes(targetLogicalId)) {
      throw new Error(
        `Item '${input.item.logicalId}' reference 'lakehouse' targets '${targetLogicalId}', but dependsOn does not include it.`,
      );
    }
  }
  if (input.item.type !== "SparkJobDefinition") {
    throw new Error(
      `Item '${input.item.logicalId}' (${input.item.type}) does not support logical references or bindings.`,
    );
  }

  const graph = indexItemGraph(input.itemGraph);
  const graphItem = graph.get(input.item.logicalId);
  if (!graphItem || graphItem.type !== input.item.type) {
    throw new Error(
      `Item '${input.item.logicalId}' is missing or has a conflicting type in the manifest item graph.`,
    );
  }

  const dependencies = new Set(graphItem.dependsOn ?? []);
  const resolved = new Map<
    SupportedLogicalReferenceTarget,
    CanonicalResolvedBinding
  >();

  for (const [referenceName, logicalId] of Object.entries(
    input.definition.references ?? {},
  ).sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    const supported = SUPPORTED_TARGETS.find(
      (candidate) => candidate.referenceName === referenceName,
    );
    if (!supported) {
      throw new Error(
        `Item '${input.item.logicalId}' has unsupported logical reference '${referenceName}'.`,
      );
    }
    addResolvedBinding(
      input.item,
      graph,
      dependencies,
      resolved,
      supported.target,
      logicalId,
      supported.targetType,
      `reference '${referenceName}'`,
    );
  }

  for (const binding of input.definition.bindings ?? []) {
    const supported = SUPPORTED_TARGETS.find(
      (candidate) => candidate.target === binding.target,
    );
    if (!supported) {
      throw new Error(
        `Item '${input.item.logicalId}' has unsupported binding target '${binding.target}'.`,
      );
    }
    const logicalId = parseBindingSource(input.item.logicalId, binding);
    addResolvedBinding(
      input.item,
      graph,
      dependencies,
      resolved,
      supported.target,
      logicalId,
      supported.targetType,
      `binding '${binding.target}'`,
    );
  }

  return Object.fromEntries(
    [...resolved.entries()].sort(([left], [right]) =>
      compareCanonicalStrings(left, right),
    ),
  ) as CanonicalResolvedBindingMap;
}

export function materializeSparkJobDefinitionSnapshot(
  snapshot: SparkJobDefinitionSnapshot,
  bindings: CanonicalResolvedBindingMap,
  physicalIds: Readonly<Record<string, string>>,
): SparkJobDefinitionSnapshot {
  if (
    snapshot.format !== undefined &&
    snapshot.format !== "SparkJobDefinitionV2"
  ) {
    throw new Error(
      `Unsupported Spark Job Definition format '${snapshot.format}'.`,
    );
  }

  const configParts = snapshot.parts.filter(
    (part) => part.path === CONFIG_PATH,
  );
  if (configParts.length !== 1) {
    throw new Error(
      `SparkJobDefinitionV2 requires exactly one '${CONFIG_PATH}' part.`,
    );
  }

  const updates = new Map<SparkJobArtifactIdField, string>();
  for (const [target, binding] of Object.entries(bindings).sort(
    ([left], [right]) => compareCanonicalStrings(left, right),
  )) {
    const supported = SUPPORTED_TARGETS.find(
      (candidate) => candidate.target === target,
    );
    if (!supported || !isCanonicalResolvedBinding(binding)) {
      throw new Error(
        `Unsupported or malformed resolved logical binding '${target}'.`,
      );
    }
    if (binding.targetType !== supported.targetType) {
      throw new Error(
        `Resolved logical binding '${target}' must target item type '${supported.targetType}'.`,
      );
    }
    const physicalId = Object.hasOwn(physicalIds, binding.logicalId)
      ? physicalIds[binding.logicalId]
      : undefined;
    if (typeof physicalId !== "string" || physicalId.trim() === "") {
      throw new Error(
        `Physical ID is missing for logicalId '${binding.logicalId}' required by '${target}'.`,
      );
    }
    updates.set(supported.configurationField, physicalId);
  }

  const clonedParts = snapshot.parts
    .map((part) =>
      part.path === CONFIG_PATH
        ? materializeConfigurationPart(part, updates)
        : { ...part },
    )
    .sort((left, right) =>
      compareCanonicalStrings(left.path, right.path),
    );

  return {
    ...snapshot,
    format: snapshot.format ?? "SparkJobDefinitionV2",
    parts: clonedParts,
  };
}

export function hashMaterializedSparkJobDefinition(
  definition: SparkJobDefinitionSnapshot,
): string {
  return hashSparkJobDefinition(
    definition,
    sparkJobIncludesPlatformPart(definition),
  );
}

export function materializeSparkJobDefinitionWithProof(
  snapshot: SparkJobDefinitionSnapshot,
  bindings: CanonicalResolvedBindingMap,
  physicalIds: Readonly<Record<string, string>>,
): SparkJobLogicalReferenceMaterialization {
  const definition = materializeSparkJobDefinitionSnapshot(
    snapshot,
    bindings,
    physicalIds,
  );
  const resolvedBindings = Object.entries(bindings)
    .sort(([left], [right]) =>
      compareCanonicalStrings(left, right),
    )
    .map(([target, binding]) => {
      if (!isCanonicalResolvedBinding(binding)) {
        throw new Error(
          `Unsupported or malformed resolved logical binding '${target}'.`,
        );
      }
      const physicalId = Object.hasOwn(
        physicalIds,
        binding.logicalId,
      )
        ? physicalIds[binding.logicalId]
        : undefined;
      if (
        typeof physicalId !== "string" ||
        physicalId.trim() === ""
      ) {
        throw new Error(
          `Physical ID is missing for logicalId '${binding.logicalId}' required by '${target}'.`,
        );
      }
      return {
        target,
        logicalId: binding.logicalId,
        targetType: binding.targetType,
        physicalId,
      };
    });
  return {
    definition,
    materializedDefinitionHash:
      hashMaterializedSparkJobDefinition(definition),
    resolvedBindingsHash: sha256(stableJson(resolvedBindings)),
  };
}

function indexItemGraph(
  items: readonly DeploymentItem[],
): Map<string, DeploymentItem> {
  const graph = new Map<string, DeploymentItem>();
  for (const item of items) {
    if (graph.has(item.logicalId)) {
      throw new Error(
        `Manifest item graph contains duplicate logicalId '${item.logicalId}'.`,
      );
    }
    graph.set(item.logicalId, item);
  }
  return graph;
}

function addResolvedBinding(
  item: DeploymentItem,
  graph: ReadonlyMap<string, DeploymentItem>,
  dependencies: ReadonlySet<string>,
  resolved: Map<
    SupportedLogicalReferenceTarget,
    CanonicalResolvedBinding
  >,
  target: SupportedLogicalReferenceTarget,
  logicalId: string,
  targetType: "Lakehouse" | "Environment",
  declaration: string,
): void {
  if (resolved.has(target)) {
    throw new Error(
      `Item '${item.logicalId}' declares '${target}' more than once across references and bindings.`,
    );
  }
  const targetItem = graph.get(logicalId);
  if (!targetItem) {
    throw new Error(
      `Item '${item.logicalId}' ${declaration} targets unknown logicalId '${logicalId}'.`,
    );
  }
  if (!dependencies.has(logicalId)) {
    throw new Error(
      `Item '${item.logicalId}' ${declaration} targets '${logicalId}', but dependsOn does not include it.`,
    );
  }
  if (targetItem.type !== targetType) {
    throw new Error(
      `Item '${item.logicalId}' ${declaration} targets '${logicalId}' (${targetItem.type}), but '${target}' requires type '${targetType}'.`,
    );
  }
  resolved.set(target, {
    logicalId,
    valueFrom: `items.${logicalId}.id`,
    targetType,
  });
}

function parseBindingSource(
  itemLogicalId: string,
  binding: ItemBinding,
): string {
  const match =
    /^(?:items|item)\.([A-Za-z][A-Za-z0-9_-]*)\.id$/.exec(
      binding.valueFrom,
    );
  if (!match?.[1]) {
    throw new Error(
      `Item '${itemLogicalId}' binding valueFrom '${binding.valueFrom}' is unsupported; expected 'items.<logicalId>.id'.`,
    );
  }
  return match[1];
}

function isCanonicalResolvedBinding(
  value: unknown,
): value is CanonicalResolvedBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const binding = value as Record<string, unknown>;
  return (
    typeof binding.logicalId === "string" &&
    binding.logicalId.length > 0 &&
    binding.valueFrom === `items.${binding.logicalId}.id` &&
    (binding.targetType === "Lakehouse" ||
      binding.targetType === "Environment")
  );
}

function materializeConfigurationPart(
  part: FabricDefinitionPart,
  updates: ReadonlyMap<SparkJobArtifactIdField, string>,
): FabricDefinitionPart {
  if (part.payloadType !== "InlineBase64") {
    throw new Error(
      `'${CONFIG_PATH}' must use payloadType 'InlineBase64'.`,
    );
  }
  const config = parseStrictConfiguration(part.payload);
  for (const [field, physicalId] of updates) {
    config[field] = physicalId;
  }
  return {
    ...part,
    payload: Buffer.from(stableJson(config), "utf8").toString(
      "base64",
    ),
  };
}

function parseStrictConfiguration(
  payload: string,
): Record<string, unknown> {
  if (!isCanonicalBase64(payload)) {
    throw new Error(
      `'${CONFIG_PATH}' must contain canonical base64 data.`,
    );
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(payload, "base64"),
    );
  } catch {
    throw new Error(
      `'${CONFIG_PATH}' must contain valid UTF-8 JSON.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `'${CONFIG_PATH}' must contain valid JSON.`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      `'${CONFIG_PATH}' must contain a JSON object.`,
    );
  }
  return parsed as Record<string, unknown>;
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    ) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}
