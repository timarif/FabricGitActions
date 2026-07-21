import { sha256, stableJson } from "../hash";
import type { ItemDefinition, PlannedAction } from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";
import type { KqlDatabaseLogicalReferenceMaterialization } from "./logical-references";

export interface FabricKqlDatabaseProperties {
  parentEventhouseItemId: string;
  databaseType: "ReadWrite" | "Shortcut";
  queryServiceUri?: string;
  ingestionServiceUri?: string;
}

export interface FabricKqlDatabase {
  id: string;
  displayName: string;
  description?: string;
  folderId?: string;
  properties: FabricKqlDatabaseProperties;
}

export interface KqlDatabaseCreateBody {
  displayName: string;
  description?: string;
  folderId?: string;
  creationPayload: {
    databaseType: "ReadWrite";
    parentEventhouseItemId: string;
  };
}

export interface KqlDatabaseUpdateBody {
  displayName: string;
  description?: string;
}

export interface KqlDatabasePlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

export interface KqlDatabaseOperationReference {
  operationId?: string;
  location?: string;
}

export class KqlDatabaseAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    materialized: KqlDatabaseLogicalReferenceMaterialization,
  ): Promise<KqlDatabasePlanResult> {
    const existing = await this.findByDisplayName(
      workspaceId,
      desired,
    );
    if (!existing) {
      return {
        action: "create",
        reason: `KQL Database '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    const observedStateHash = hashObservedKqlDatabase(current);
    if (
      current.properties.parentEventhouseItemId !==
      materialized.creationPayload.parentEventhouseItemId
    ) {
      return {
        action: "blocked",
        reason:
          `KQL Database '${desired.displayName}' belongs to Eventhouse ` +
          `'${current.properties.parentEventhouseItemId}', but the desired parent is ` +
          `'${materialized.creationPayload.parentEventhouseItemId}'. Fabric does not support re-parenting a KQL Database.`,
        physicalId: current.id,
        observedStateHash,
      };
    }
    if (
      current.properties.databaseType !==
      materialized.creationPayload.databaseType
    ) {
      return {
        action: "blocked",
        reason:
          `KQL Database '${desired.displayName}' has databaseType ` +
          `'${current.properties.databaseType}', but the desired type is ` +
          `'${materialized.creationPayload.databaseType}'. Fabric does not support changing databaseType after creation.`,
        physicalId: current.id,
        observedStateHash,
      };
    }

    const metadataChanged =
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
        normalizeDescription(desired.description);
    return {
      action: metadataChanged ? "update" : "no-op",
      reason: metadataChanged
        ? `KQL Database '${desired.displayName}' metadata differs from the desired state.`
        : `KQL Database '${desired.displayName}' already matches the desired state.`,
      physicalId: current.id,
      observedStateHash,
    };
  }

  async planUnresolvedParent(
    workspaceId: string,
    desired: ItemDefinition,
    unresolvedLogicalIds: readonly string[],
  ): Promise<KqlDatabasePlanResult> {
    const existing = await this.findByDisplayName(
      workspaceId,
      desired,
    );
    if (!existing) {
      return {
        action: "create",
        reason: `KQL Database '${desired.displayName}' does not exist; its Eventhouse parent will be materialized after dependency creation.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    const current = await this.get(workspaceId, existing.id);
    return {
      action: "blocked",
      reason: `KQL Database '${desired.displayName}' exists, but Eventhouse ID (${unresolvedLogicalIds.join(
        ", ",
      )}) is unavailable for reviewed parent verification. Apply the dependency and generate a new plan.`,
      physicalId: current.id,
      observedStateHash: hashObservedKqlDatabase(current),
    };
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    materialized: KqlDatabaseLogicalReferenceMaterialization,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: KqlDatabaseOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<FabricKqlDatabase> {
    let response: FabricResponse<FabricKqlDatabase>;
    try {
      response = await this.client.request<FabricKqlDatabase>(
        "POST",
        kqlDatabasesPath(workspaceId),
        {
          body: buildCreateBody(desired, materialized),
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

    let created: FabricKqlDatabase | undefined;
    if (response.status === 202) {
      onOperationAccepted?.(readOperationReference(response));
      created =
        await this.client.waitForOperation<FabricKqlDatabase>(response);
    } else {
      created = response.body;
    }
    if (!created?.id) {
      throw new Error(
        "Fabric Create KQL Database response is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(
      workspaceId,
      created.id,
      desired,
      materialized,
    );
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    materialized: KqlDatabaseLogicalReferenceMaterialization,
    operation: KqlDatabaseOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<FabricKqlDatabase> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<FabricKqlDatabase>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create KQL Database operation result is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(
      workspaceId,
      created.id,
      desired,
      materialized,
    );
  }

  async update(
    workspaceId: string,
    kqlDatabaseId: string,
    desired: ItemDefinition,
    materialized: KqlDatabaseLogicalReferenceMaterialization,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateSubmitting?: () => void,
    onUpdateRejected?: () => void,
  ): Promise<FabricKqlDatabase> {
    try {
      await this.client.request<FabricKqlDatabase>(
        "PATCH",
        kqlDatabasePath(workspaceId, kqlDatabaseId),
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
    onMutationAccepted?.(kqlDatabaseId);
    return this.verify(
      workspaceId,
      kqlDatabaseId,
      desired,
      materialized,
    );
  }

  async verify(
    workspaceId: string,
    kqlDatabaseId: string,
    desired: ItemDefinition,
    materialized: KqlDatabaseLogicalReferenceMaterialization,
  ): Promise<FabricKqlDatabase> {
    const current = await this.get(workspaceId, kqlDatabaseId);
    if (
      current.displayName !== desired.displayName ||
      normalizeFolderId(current.folderId) !==
        normalizeFolderId(desired.folderId) ||
      current.properties.parentEventhouseItemId !==
        materialized.creationPayload.parentEventhouseItemId ||
      current.properties.databaseType !==
        materialized.creationPayload.databaseType
    ) {
      throw new Error(
        `KQL Database '${desired.displayName}' read-back verification failed.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `KQL Database '${desired.displayName}' read-back verification failed for description.`,
      );
    }
    return current;
  }

  async get(
    workspaceId: string,
    kqlDatabaseId: string,
  ): Promise<FabricKqlDatabase> {
    const response = await this.client.request<FabricKqlDatabase>(
      "GET",
      kqlDatabasePath(workspaceId, kqlDatabaseId),
    );
    if (!response.body) {
      throw new Error("Fabric Get KQL Database response is empty.");
    }
    return response.body;
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<FabricKqlDatabase | undefined> {
    const url = new URL(
      kqlDatabasesPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (desired.folderId) {
      url.searchParams.set("rootFolderId", desired.folderId);
    }
    const matches = (
      await this.client.listAll<FabricKqlDatabase>(
        `${url.pathname}${url.search}`,
      )
    ).filter(
      (database) =>
        database.displayName === desired.displayName &&
        normalizeFolderId(database.folderId) ===
          normalizeFolderId(desired.folderId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple KQL Databases named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }
}

export function buildCreateBody(
  desired: ItemDefinition,
  materialized: KqlDatabaseLogicalReferenceMaterialization,
): KqlDatabaseCreateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
    ...(desired.folderId !== undefined
      ? { folderId: desired.folderId }
      : {}),
    creationPayload: materialized.creationPayload,
  };
}

export function buildUpdateBody(
  desired: ItemDefinition,
): KqlDatabaseUpdateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
  };
}

export function hashObservedKqlDatabase(
  database: FabricKqlDatabase,
): string {
  return sha256(
    stableJson({
      id: database.id,
      displayName: database.displayName,
      description: normalizeDescription(database.description),
      folderId: normalizeFolderId(database.folderId),
      parentEventhouseItemId:
        database.properties.parentEventhouseItemId,
      databaseType: database.properties.databaseType,
    }),
  );
}

function kqlDatabasesPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/kqlDatabases`;
}

function kqlDatabasePath(
  workspaceId: string,
  kqlDatabaseId: string,
): string {
  return `${kqlDatabasesPath(workspaceId)}/${encodeURIComponent(
    kqlDatabaseId,
  )}`;
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
): KqlDatabaseOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create KQL Database response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}
