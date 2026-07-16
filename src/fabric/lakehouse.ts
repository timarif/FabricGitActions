import type { ItemDefinition, PlannedAction } from "../types";
import { sha256, stableJson } from "../hash";
import {
  FabricClient,
  type FabricResponse,
} from "./client";

export interface Lakehouse {
  id: string;
  workspaceId?: string;
  type?: "Lakehouse";
  displayName: string;
  description?: string;
  folderId?: string;
  properties?: Record<string, unknown>;
}

export interface LakehousePlanResult {
  action: Extract<PlannedAction, "create" | "update" | "no-op" | "blocked">;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

export class LakehouseAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<LakehousePlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Lakehouse '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current =
      desired.enableSchemas === true
        ? await this.get(workspaceId, existing.id)
        : existing;
    const observedStateHash = hashObservedLakehouse(current);
    if (
      desired.enableSchemas === true &&
      !readDefaultSchema(current.properties)
    ) {
      return {
        action: "blocked",
        reason: `Lakehouse '${desired.displayName}' exists without verifiable schema support; schema mode is creation-only.`,
        physicalId: current.id,
        observedStateHash,
      };
    }

    if (
      desired.description !== undefined &&
      normalizeDescription(current.description) !==
      normalizeDescription(desired.description)
    ) {
      return {
        action: "update",
        reason: `Lakehouse '${desired.displayName}' description differs.`,
        physicalId: current.id,
        observedStateHash,
      };
    }

    return {
      action: "no-op",
      reason: `Lakehouse '${desired.displayName}' matches the desired metadata.`,
      physicalId: current.id,
      observedStateHash,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<Lakehouse[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lakehouses`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<Lakehouse>(`${url.pathname}${url.search}`);
  }

  async get(workspaceId: string, lakehouseId: string): Promise<Lakehouse> {
    const response = await this.client.request<Lakehouse>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(
        workspaceId,
      )}/lakehouses/${encodeURIComponent(lakehouseId)}`,
    );
    if (!response.body) {
      throw new Error("Fabric Get Lakehouse response is empty.");
    }
    return response.body;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<Lakehouse> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }
    if (desired.enableSchemas === true) {
      body.creationPayload = { enableSchemas: true };
    }

    const response = await this.client.request<Lakehouse>(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/lakehouses`,
      {
        body,
        retryable: false,
        acceptedStatuses: [201, 202],
      },
    );
    const created =
      response.status === 202
        ? await this.client.waitForOperation<Lakehouse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!created?.id) {
      throw new Error("Fabric Create Lakehouse response is missing the item ID.");
    }
    return this.verify(workspaceId, created.id, desired);
  }

  async update(
    workspaceId: string,
    lakehouseId: string,
    desired: ItemDefinition,
  ): Promise<Lakehouse> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }

    await this.client.request<Lakehouse>(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(
        workspaceId,
      )}/lakehouses/${encodeURIComponent(lakehouseId)}`,
      {
        body,
        retryable: false,
        acceptedStatuses: [200],
      },
    );
    return this.verify(workspaceId, lakehouseId, desired);
  }

  async verify(
    workspaceId: string,
    lakehouseId: string,
    desired: ItemDefinition,
  ): Promise<Lakehouse> {
    const actual = await this.get(workspaceId, lakehouseId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Lakehouse verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
      normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Lakehouse '${desired.displayName}' verification failed for description.`,
      );
    }
    if (normalizeFolderId(actual.folderId) !== normalizeFolderId(desired.folderId)) {
      throw new Error(
        `Lakehouse '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    if (
      desired.enableSchemas === true &&
      !readDefaultSchema(actual.properties)
    ) {
      throw new Error(
        `Lakehouse '${desired.displayName}' verification failed for schema support.`,
      );
    }
    return actual;
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<Lakehouse | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (lakehouse) => lakehouse.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Lakehouses named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string {
  return value ?? "";
}

function readDefaultSchema(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  return typeof properties?.defaultSchema === "string"
    ? properties.defaultSchema
    : undefined;
}

function hashObservedLakehouse(lakehouse: Lakehouse): string {
  return sha256(
    stableJson({
      id: lakehouse.id,
      displayName: lakehouse.displayName,
      description: normalizeDescription(lakehouse.description),
      folderId: lakehouse.folderId ?? null,
      defaultSchema: readDefaultSchema(lakehouse.properties) ?? null,
    }),
  );
}
