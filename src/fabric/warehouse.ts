import { sha256, stableJson } from "../hash";
import type { ItemDefinition, PlannedAction } from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

/**
 * The two collation types supported by Fabric Data Warehouse at creation time.
 * Collation is immutable after creation — see WarehouseAdapter.plan for drift
 * handling.
 *
 * Source: https://learn.microsoft.com/en-us/rest/api/fabric/warehouse/items/create-warehouse
 */
export type CollationType =
  | "Latin1_General_100_BIN2_UTF8"
  | "Latin1_General_100_CI_AS_KS_WS_SC_UTF8";

/**
 * Server default when collationType is omitted from the creation payload.
 * Included in the observed-state hash so that omitting collationType in
 * item.yaml is equivalent to specifying the default explicitly.
 */
export const DEFAULT_COLLATION_TYPE: CollationType =
  "Latin1_General_100_BIN2_UTF8";

export interface FabricWarehouseProperties {
  /**
   * TDS SQL connection string — format:
   * <fragment>.datawarehouse.fabric.microsoft.com (TCP 1433, Entra-only).
   * Excluded from the observed-state hash because it is immutable and
   * system-assigned; a change here signals item recreation.
   *
   * Live validation: the API returns both `connectionInfo` and `connectionString`
   * with the same TDS hostname value. Only `connectionString` is advertised in
   * the official documentation; `connectionInfo` appears to be an undocumented
   * alias. Both are excluded from the hash.
   */
  connectionInfo?: string;
  connectionString?: string;
  /**
   * Creation audit timestamp — excluded from the observed-state hash for the
   * same reason as connectionString.
   */
  createdDate?: string;
  /** System-managed last-modification timestamp. */
  lastUpdatedTime?: string;
  /**
   * Immutable collation chosen at creation. Live validation confirms the API
   * always returns this field, even when the default BIN2 collation was used.
   * The `?? DEFAULT_COLLATION_TYPE` normalisation in hashObservedWarehouse is
   * therefore defensive-only but safe to keep for forward-compatibility.
   */
  collationType?: CollationType;
}

export interface FabricWarehouse {
  id: string;
  displayName: string;
  description?: string;
  folderId?: string;
  properties: FabricWarehouseProperties;
}

export interface WarehousePlanResult {
  action: Extract<PlannedAction, "create" | "update" | "no-op" | "blocked">;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

export interface WarehouseOperationReference {
  operationId?: string;
  location?: string;
}

export interface WarehouseCreateBody {
  displayName: string;
  description?: string;
  folderId?: string;
  creationPayload?: { collationType: CollationType };
}

export interface WarehouseUpdateBody {
  displayName: string;
  description?: string;
}

export class WarehouseAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<WarehousePlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Warehouse '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    const observedHash = hashObservedWarehouse(current);

    // collationType is immutable — only delete + recreate can fix a mismatch.
    const desiredCollation =
      desired.collationType ?? DEFAULT_COLLATION_TYPE;
    const observedCollation =
      current.properties.collationType ?? DEFAULT_COLLATION_TYPE;
    if (desiredCollation !== observedCollation) {
      return {
        action: "blocked",
        reason:
          `Warehouse '${desired.displayName}' has collationType ` +
          `'${observedCollation}', but the desired value is '${desiredCollation}'. ` +
          `Fabric does not support changing collationType after creation; ` +
          `delete and recreate the Warehouse to apply this change.`,
        physicalId: current.id,
        observedStateHash: observedHash,
      };
    }

    const metadataChanged =
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
        normalizeDescription(desired.description);

    return {
      action: metadataChanged ? "update" : "no-op",
      reason: metadataChanged
        ? `Warehouse '${desired.displayName}' description differs from the desired state.`
        : `Warehouse '${desired.displayName}' already matches the desired state.`,
      physicalId: current.id,
      observedStateHash: observedHash,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<FabricWarehouse[]> {
    const url = new URL(
      warehousesPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<FabricWarehouse>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(workspaceId: string, warehouseId: string): Promise<FabricWarehouse> {
    const response = await this.client.request<FabricWarehouse>(
      "GET",
      warehousePath(workspaceId, warehouseId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Warehouse response is empty.");
    }
    return response.body;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: WarehouseOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<FabricWarehouse> {
    let response: FabricResponse<FabricWarehouse>;
    try {
      response = await this.client.request<FabricWarehouse>(
        "POST",
        warehousesPath(workspaceId),
        {
          body: buildCreateBody(desired),
          retryable: false,
          acceptedStatuses: [201, 202],
          onDispatch: onCreateSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveClientError(error)) {
        onCreateRejected?.();
      }
      throw error;
    }

    let created: FabricWarehouse | undefined;
    if (response.status === 202) {
      onOperationAccepted?.(readOperationReference(response));
      created = await this.client.waitForOperation<FabricWarehouse>(response);
    } else {
      created = response.body;
    }
    if (!created?.id) {
      throw new Error(
        "Fabric Create Warehouse response is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(workspaceId, created.id, desired);
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    operation: WarehouseOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<FabricWarehouse> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<FabricWarehouse>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Warehouse operation result is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(workspaceId, created.id, desired);
  }

  async update(
    workspaceId: string,
    warehouseId: string,
    desired: ItemDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateSubmitting?: () => void,
    onUpdateRejected?: () => void,
  ): Promise<FabricWarehouse> {
    try {
      await this.client.request<FabricWarehouse>(
        "PATCH",
        warehousePath(workspaceId, warehouseId),
        {
          body: buildUpdateBody(desired),
          retryable: false,
          acceptedStatuses: [200],
          onDispatch: onUpdateSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveClientError(error)) {
        onUpdateRejected?.();
      }
      throw error;
    }
    onMutationAccepted?.(warehouseId);
    return this.verify(workspaceId, warehouseId, desired);
  }

  async verify(
    workspaceId: string,
    warehouseId: string,
    desired: ItemDefinition,
  ): Promise<FabricWarehouse> {
    const actual = await this.get(workspaceId, warehouseId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Warehouse '${desired.displayName}' read-back verification failed: ` +
          `expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (normalizeFolderId(actual.folderId) !== normalizeFolderId(desired.folderId)) {
      throw new Error(
        `Warehouse '${desired.displayName}' read-back verification failed for folder placement.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Warehouse '${desired.displayName}' read-back verification failed for description.`,
      );
    }
    const desiredCollation = desired.collationType ?? DEFAULT_COLLATION_TYPE;
    const observedCollation =
      actual.properties.collationType ?? DEFAULT_COLLATION_TYPE;
    if (desiredCollation !== observedCollation) {
      throw new Error(
        `Warehouse '${desired.displayName}' read-back verification failed: ` +
          `expected collationType '${desiredCollation}', received '${observedCollation}'.`,
      );
    }
    return actual;
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<FabricWarehouse | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (warehouse) =>
        warehouse.displayName === desired.displayName &&
        normalizeFolderId(warehouse.folderId) ===
          normalizeFolderId(desired.folderId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Warehouses named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }
}

/**
 * Build the POST /warehouses creation body.
 *
 * collationType is only included when explicitly specified; the API uses
 * Latin1_General_100_BIN2_UTF8 as its server default.
 */
export function buildCreateBody(desired: ItemDefinition): WarehouseCreateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
    ...(desired.folderId !== undefined
      ? { folderId: desired.folderId }
      : {}),
    ...(desired.collationType !== undefined
      ? { creationPayload: { collationType: desired.collationType } }
      : {}),
  };
}

/**
 * Build the PATCH /warehouses/{id} metadata update body.
 *
 * Only displayName and description are mutable; collationType is excluded
 * because it is immutable after creation. Live validation confirms the API
 * silently ignores collationType in the PATCH body (returns 200 but leaves
 * the original value unchanged) rather than rejecting it with an error.
 * We still omit it to keep requests clean and semantically correct.
 */
export function buildUpdateBody(desired: ItemDefinition): WarehouseUpdateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
  };
}

/**
 * Compute the observed-state hash for plan drift detection.
 *
 * Intentionally excludes:
 *  - properties.connectionInfo    — alias for connectionString, system-assigned
 *  - properties.connectionString  — system-assigned, immutable, not user-managed
 *  - properties.createdDate       — creation audit timestamp, not user-managed
 *  - properties.lastUpdatedTime   — service-managed; changes on every mutation
 *  - properties.creationMode      — always "New"; not user-managed
 *
 * Live validation confirmed the API always returns collationType in the GET
 * response, even when the default BIN2 value was used at creation. The
 * `?? DEFAULT_COLLATION_TYPE` normalisation is defensive for forward-compat.
 */
export function hashObservedWarehouse(warehouse: FabricWarehouse): string {
  return sha256(
    stableJson({
      id: warehouse.id,
      displayName: warehouse.displayName,
      description: normalizeDescription(warehouse.description),
      folderId: normalizeFolderId(warehouse.folderId),
      collationType:
        warehouse.properties.collationType ?? DEFAULT_COLLATION_TYPE,
    }),
  );
}

function warehousesPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/warehouses`;
}

function warehousePath(workspaceId: string, warehouseId: string): string {
  return `${warehousesPath(workspaceId)}/${encodeURIComponent(warehouseId)}`;
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string | null {
  return value ?? null;
}

function isDefinitiveClientError(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function readOperationReference(
  response: FabricResponse<unknown>,
): WarehouseOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Warehouse response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}
