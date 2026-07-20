import { sha256, stableJson } from "../hash";
import type { ItemDefinition, PlannedAction } from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

export interface FabricEventhouseProperties {
  minimumConsumptionUnits: number;
  queryServiceUri?: string;
  ingestionServiceUri?: string;
  databasesItemIds?: string[];
}

export interface FabricEventhouse {
  id: string;
  displayName: string;
  description?: string;
  folderId?: string;
  properties: FabricEventhouseProperties;
}

export interface EventhouseCreateBody {
  displayName: string;
  description?: string;
  folderId?: string;
  creationPayload: {
    minimumConsumptionUnits: number;
  };
}

export interface EventhouseUpdateBody {
  displayName: string;
  description?: string;
}

export interface EventhousePlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

export interface EventhouseOperationReference {
  operationId?: string;
  location?: string;
}

export class EventhouseAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<EventhousePlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Eventhouse '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    const desiredMinimumConsumptionUnits =
      desired.minimumConsumptionUnits ?? 0;
    if (
      current.properties.minimumConsumptionUnits !==
      desiredMinimumConsumptionUnits
    ) {
      return {
        action: "blocked",
        reason:
          `Eventhouse '${desired.displayName}' has minimumConsumptionUnits ` +
          `${current.properties.minimumConsumptionUnits}, but the desired value is ` +
          `${desiredMinimumConsumptionUnits}. Fabric does not support updating this property after creation.`,
        physicalId: current.id,
        observedStateHash: hashObservedEventhouse(current),
      };
    }

    const metadataChanged =
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
      normalizeDescription(desired.description);
    return {
      action: metadataChanged ? "update" : "no-op",
      reason: metadataChanged
        ? `Eventhouse '${desired.displayName}' metadata differs from the desired state.`
        : `Eventhouse '${desired.displayName}' already matches the desired state.`,
      physicalId: current.id,
      observedStateHash: hashObservedEventhouse(current),
    };
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: EventhouseOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<FabricEventhouse> {
    let response: FabricResponse<FabricEventhouse>;
    try {
      response = await this.client.request<FabricEventhouse>(
        "POST",
        eventhousesPath(workspaceId),
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

    let created: FabricEventhouse | undefined;
    if (response.status === 202) {
      onOperationAccepted?.(readOperationReference(response));
      created =
        await this.client.waitForOperation<FabricEventhouse>(response);
    } else {
      created = response.body;
    }
    if (!created?.id) {
      throw new Error(
        "Fabric Create Eventhouse response is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(workspaceId, created.id, desired);
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    operation: EventhouseOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<FabricEventhouse> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<FabricEventhouse>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Eventhouse operation result is missing the item ID.",
      );
    }
    onMutationAccepted?.(created.id);
    return this.verify(workspaceId, created.id, desired);
  }

  async update(
    workspaceId: string,
    eventhouseId: string,
    desired: ItemDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateSubmitting?: () => void,
    onUpdateRejected?: () => void,
  ): Promise<FabricEventhouse> {
    try {
      await this.client.request<FabricEventhouse>(
        "PATCH",
        eventhousePath(workspaceId, eventhouseId),
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
    onMutationAccepted?.(eventhouseId);
    return this.verify(workspaceId, eventhouseId, desired);
  }

  async verify(
    workspaceId: string,
    eventhouseId: string,
    desired: ItemDefinition,
  ): Promise<FabricEventhouse> {
    const current = await this.get(workspaceId, eventhouseId);
    if (
      current.displayName !== desired.displayName ||
      normalizeFolderId(current.folderId) !==
        normalizeFolderId(desired.folderId) ||
      current.properties.minimumConsumptionUnits !==
        (desired.minimumConsumptionUnits ?? 0)
    ) {
      throw new Error(
        `Eventhouse '${desired.displayName}' read-back verification failed.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Eventhouse '${desired.displayName}' read-back verification failed for description.`,
      );
    }
    return current;
  }

  async get(
    workspaceId: string,
    eventhouseId: string,
  ): Promise<FabricEventhouse> {
    const response = await this.client.request<FabricEventhouse>(
      "GET",
      eventhousePath(workspaceId, eventhouseId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Eventhouse response is empty.");
    }
    return response.body;
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<FabricEventhouse | undefined> {
    const url = new URL(
      eventhousesPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (desired.folderId) {
      url.searchParams.set("rootFolderId", desired.folderId);
    }
    const matches = (
      await this.client.listAll<FabricEventhouse>(
        `${url.pathname}${url.search}`,
      )
    ).filter(
      (eventhouse) =>
        eventhouse.displayName === desired.displayName &&
        normalizeFolderId(eventhouse.folderId) ===
          normalizeFolderId(desired.folderId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Eventhouses named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }
}

export function buildCreateBody(
  desired: ItemDefinition,
): EventhouseCreateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
    ...(desired.folderId !== undefined
      ? { folderId: desired.folderId }
      : {}),
    creationPayload: {
      minimumConsumptionUnits:
        desired.minimumConsumptionUnits ?? 0,
    },
  };
}

export function buildUpdateBody(
  desired: ItemDefinition,
): EventhouseUpdateBody {
  return {
    displayName: desired.displayName,
    ...(desired.description !== undefined
      ? { description: desired.description }
      : {}),
  };
}

export function hashObservedEventhouse(
  eventhouse: FabricEventhouse,
): string {
  return sha256(
    stableJson({
      id: eventhouse.id,
      displayName: eventhouse.displayName,
      description: normalizeDescription(eventhouse.description),
      folderId: normalizeFolderId(eventhouse.folderId),
      minimumConsumptionUnits:
        eventhouse.properties.minimumConsumptionUnits,
    }),
  );
}

function eventhousesPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/eventhouses`;
}

function eventhousePath(
  workspaceId: string,
  eventhouseId: string,
): string {
  return `${eventhousesPath(workspaceId)}/${encodeURIComponent(
    eventhouseId,
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
): EventhouseOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Eventhouse response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}
