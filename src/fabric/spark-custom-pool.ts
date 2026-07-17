import {
  compareCanonicalStrings,
  sha256,
  stableJson,
} from "../hash";
import type { ItemDefinition, PlannedAction } from "../types";
import {
  assertValidSparkCustomPoolDefinition,
  assertValidSparkCustomPoolItemDefinition,
  type SparkCustomPoolAutoScale,
  type SparkCustomPoolDefinition,
  type SparkCustomPoolDynamicExecutorAllocation,
} from "./spark-custom-pool-definition";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

export const STARTER_POOL_ID = "00000000-0000-0000-0000-000000000000";
export const STARTER_POOL_NAME = "Starter Pool";

export interface SparkCustomPool {
  id: string;
  name: string;
  type: string;
  nodeFamily: string;
  nodeSize: string;
  autoScale: SparkCustomPoolAutoScale;
  dynamicExecutorAllocation: SparkCustomPoolDynamicExecutorAllocation;
}

export interface SparkCustomPoolPlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

/**
 * Compatibility shape for the shared apply callback contract. Workspace pool
 * mutations are synchronous, so the adapter never invokes this callback.
 */
export interface SparkCustomPoolOperationReference {
  operationId?: string;
  location?: string;
}

export class SparkCustomPoolAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: SparkCustomPoolDefinition,
  ): Promise<SparkCustomPoolPlanResult> {
    assertValidSparkCustomPoolItemDefinition(desired);
    assertValidSparkCustomPoolDefinition(desiredDefinition);
    const pools = await this.list(workspaceId);
    const exactMatches = pools.filter(
      (pool) => pool.name === desired.displayName,
    );
    const caseInsensitiveMatches = pools.filter(
      (pool) =>
        pool.name.toLowerCase() === desired.displayName.toLowerCase(),
    );

    if (isStarterPoolName(desired.displayName)) {
      return blockedResult(
        `Spark custom pool name '${desired.displayName}' is reserved for the Starter Pool.`,
        exactMatches,
      );
    }

    if (exactMatches.some(isStarterPool)) {
      return blockedResult(
        `Spark custom pool '${desired.displayName}' resolves to the reserved Starter Pool.`,
        exactMatches,
      );
    }

    if (exactMatches.some((pool) => pool.type !== "Workspace")) {
      return blockedResult(
        `Spark custom pool '${desired.displayName}' collides with a non-workspace pool and cannot be managed by the workspace adapter.`,
        exactMatches,
      );
    }

    if (exactMatches.length > 1) {
      return blockedResult(
        `Multiple workspace Spark custom pools named '${desired.displayName}' were found.`,
        exactMatches,
      );
    }

    if (caseInsensitiveMatches.length !== exactMatches.length) {
      return blockedResult(
        `Spark custom pool '${desired.displayName}' has a case-insensitive name collision.`,
        caseInsensitiveMatches,
      );
    }

    const existing = exactMatches[0];
    if (!existing) {
      if (caseInsensitiveMatches.length > 0) {
        return blockedResult(
          `Spark custom pool '${desired.displayName}' has a case-insensitive name collision.`,
          caseInsensitiveMatches,
        );
      }
      return {
        action: "create",
        reason: `Spark custom pool '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const observedStateHash = hashObservedSparkCustomPool(existing);
    if (!poolMatchesDesired(existing, desired, desiredDefinition)) {
      return {
        action: "update",
        reason: `Spark custom pool '${desired.displayName}' configuration differs.`,
        physicalId: existing.id,
        observedStateHash,
      };
    }

    return {
      action: "no-op",
      reason: `Spark custom pool '${desired.displayName}' matches the desired configuration.`,
      physicalId: existing.id,
      observedStateHash,
    };
  }

  async list(workspaceId: string): Promise<SparkCustomPool[]> {
    return this.client.listAll<SparkCustomPool>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/spark/pools`,
    );
  }

  async get(
    workspaceId: string,
    poolId: string,
  ): Promise<SparkCustomPool> {
    const response = await this.client.request<SparkCustomPool>(
      "GET",
      poolPath(workspaceId, poolId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Spark custom pool response is empty.");
    }
    return response.body;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: SparkCustomPoolDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    _onOperationAccepted?: (
      operation: SparkCustomPoolOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<SparkCustomPool> {
    assertValidSparkCustomPoolItemDefinition(desired);
    assertValidSparkCustomPoolDefinition(desiredDefinition);
    if (isStarterPoolName(desired.displayName)) {
      throw new Error(
        `Spark custom pool name '${desired.displayName}' is reserved for the Starter Pool.`,
      );
    }

    let response: FabricResponse<SparkCustomPool>;
    try {
      response = await this.client.request<SparkCustomPool>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/spark/pools`,
        {
          body: requestBody(desired, desiredDefinition),
          retryable: false,
          acceptedStatuses: [201],
          onDispatch: onCreateSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        onCreateRejected?.();
      }
      throw error;
    }

    const created = response.body;
    if (!created?.id) {
      throw new Error(
        "Fabric Create Spark custom pool response is missing the pool ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(
      workspaceId,
      created.id,
      desired,
      desiredDefinition,
    );
  }

  async update(
    workspaceId: string,
    poolId: string,
    desired: ItemDefinition,
    desiredDefinition: SparkCustomPoolDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateSubmitting?: () => void,
    onUpdateRejected?: () => void,
  ): Promise<SparkCustomPool> {
    assertValidSparkCustomPoolItemDefinition(desired);
    assertValidSparkCustomPoolDefinition(desiredDefinition);
    if (poolId === STARTER_POOL_ID || isStarterPoolName(desired.displayName)) {
      throw new Error("The Starter Pool cannot be updated by this adapter.");
    }

    onUpdateSubmitting?.();
    try {
      await this.client.request<SparkCustomPool>(
        "PATCH",
        poolPath(workspaceId, poolId),
        {
          body: requestBody(desired, desiredDefinition),
          retryable: false,
          acceptedStatuses: [200],
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        onUpdateRejected?.();
      }
      throw error;
    }
    onMutationAccepted?.(poolId);
    return this.verify(
      workspaceId,
      poolId,
      desired,
      desiredDefinition,
    );
  }

  async verify(
    workspaceId: string,
    poolId: string,
    desired: ItemDefinition,
    desiredDefinition: SparkCustomPoolDefinition,
  ): Promise<SparkCustomPool> {
    assertValidSparkCustomPoolItemDefinition(desired);
    assertValidSparkCustomPoolDefinition(desiredDefinition);
    const actual = await this.get(workspaceId, poolId);
    if (actual.id !== poolId) {
      throw new Error(
        `Spark custom pool verification failed: expected ID '${poolId}', received '${actual.id}'.`,
      );
    }
    if (isStarterPool(actual)) {
      throw new Error(
        "Spark custom pool verification failed: the physical ID resolves to the Starter Pool.",
      );
    }
    if (actual.type !== "Workspace") {
      throw new Error(
        `Spark custom pool verification failed: expected type 'Workspace', received '${actual.type}'.`,
      );
    }
    if (!poolMatchesDesired(actual, desired, desiredDefinition)) {
      throw new Error(
        `Spark custom pool '${desired.displayName}' verification failed for its managed configuration.`,
      );
    }
    return actual;
  }
}

export function hashObservedSparkCustomPool(
  pool: SparkCustomPool,
): string {
  return sha256(stableJson(canonicalObservedPool(pool)));
}

function blockedResult(
  reason: string,
  pools: SparkCustomPool[],
): SparkCustomPoolPlanResult {
  const ordered = [...pools]
    .map(canonicalObservedPool)
    .sort((left, right) =>
      compareCanonicalStrings(stableJson(left), stableJson(right)),
    );
  return {
    action: "blocked",
    reason,
    ...(pools.length === 1 && pools[0]?.id
      ? { physicalId: pools[0].id }
      : {}),
    observedStateHash: sha256(stableJson(ordered)),
  };
}

function canonicalObservedPool(pool: SparkCustomPool) {
  return {
    id: pool.id,
    name: pool.name,
    type: pool.type,
    nodeFamily: pool.nodeFamily,
    nodeSize: pool.nodeSize,
    autoScale: {
      enabled: pool.autoScale.enabled,
      minNodeCount: pool.autoScale.minNodeCount,
      maxNodeCount: pool.autoScale.maxNodeCount,
    },
    dynamicExecutorAllocation: {
      enabled: pool.dynamicExecutorAllocation.enabled,
      minExecutors: pool.dynamicExecutorAllocation.minExecutors,
      maxExecutors: pool.dynamicExecutorAllocation.maxExecutors,
    },
  };
}

function poolMatchesDesired(
  pool: SparkCustomPool,
  desired: ItemDefinition,
  desiredDefinition: SparkCustomPoolDefinition,
): boolean {
  return (
    pool.name === desired.displayName &&
    pool.type === "Workspace" &&
    pool.nodeFamily === desiredDefinition.nodeFamily &&
    pool.nodeSize === desiredDefinition.nodeSize &&
    stableJson(pool.autoScale) === stableJson(desiredDefinition.autoScale) &&
    stableJson(pool.dynamicExecutorAllocation) ===
      stableJson(desiredDefinition.dynamicExecutorAllocation)
  );
}

function requestBody(
  desired: ItemDefinition,
  desiredDefinition: SparkCustomPoolDefinition,
) {
  return {
    name: desired.displayName,
    nodeFamily: desiredDefinition.nodeFamily,
    nodeSize: desiredDefinition.nodeSize,
    autoScale: desiredDefinition.autoScale,
    dynamicExecutorAllocation:
      desiredDefinition.dynamicExecutorAllocation,
  };
}

function isStarterPool(pool: SparkCustomPool): boolean {
  return (
    pool.id === STARTER_POOL_ID ||
    isStarterPoolName(pool.name)
  );
}

function isStarterPoolName(name: string): boolean {
  return name.toLowerCase() === STARTER_POOL_NAME.toLowerCase();
}

function poolPath(workspaceId: string, poolId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/spark/pools/${encodeURIComponent(poolId)}`;
}

function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}
