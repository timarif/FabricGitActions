import { sha256, stableJson } from "../hash";
import type {
  FabricItemType,
  ItemDefinition,
  PlannedAction,
} from "../types";
import { FabricApiError, FabricClient } from "./client";

export type DeletableFabricItemType =
  | "Lakehouse"
  | "Environment"
  | "Notebook"
  | "SparkJobDefinition"
  | "DataPipeline"
  | "SemanticModel"
  | "Eventstream";

export interface FabricWorkspaceItem {
  id: string;
  workspaceId?: string;
  type: string;
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface ItemDeletionPlanResult {
  action: Extract<PlannedAction, "delete" | "no-op">;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
}

export class ItemDeletionAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    itemType: DeletableFabricItemType,
    desired: ItemDefinition,
  ): Promise<ItemDeletionPlanResult> {
    const existing = await this.findByDisplayName(
      workspaceId,
      itemType,
      desired,
    );
    if (!existing) {
      return {
        action: "no-op",
        reason: `${displayType(itemType)} '${desired.displayName}' is already absent.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    if (!current) {
      return {
        action: "no-op",
        reason: `${displayType(itemType)} '${desired.displayName}' is already absent.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    assertDeletionIdentity(current, workspaceId, itemType, desired);
    return {
      action: "delete",
      reason: `${displayType(itemType)} '${desired.displayName}' exists and is approved for soft deletion.`,
      physicalId: current.id,
      observedStateHash: hashObservedDeletionItem(current),
    };
  }

  async get(
    workspaceId: string,
    itemId: string,
  ): Promise<FabricWorkspaceItem | undefined> {
    try {
      const response = await this.client.request<FabricWorkspaceItem>(
        "GET",
        itemPath(workspaceId, itemId),
      );
      if (!response.body) {
        throw new Error("Fabric Get Item response is empty.");
      }
      return response.body;
    } catch (error) {
      if (
        error instanceof FabricApiError &&
        error.status === 404
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async delete(
    workspaceId: string,
    itemId: string,
    onDispatch?: () => void,
  ): Promise<void> {
    try {
      await this.client.request(
        "DELETE",
        itemPath(workspaceId, itemId),
        {
          acceptedStatuses: [200],
          onDispatch,
        },
      );
    } catch (error) {
      if (
        error instanceof FabricApiError &&
        error.status === 404
      ) {
        return;
      }
      throw error;
    }
  }

  async verifyApprovedIdentity(
    workspaceId: string,
    itemId: string,
    itemType: DeletableFabricItemType,
    desired: ItemDefinition,
    approvedObservedStateHash: string,
  ): Promise<"absent" | "unchanged"> {
    const current = await this.get(workspaceId, itemId);
    if (!current) {
      return "absent";
    }
    assertDeletionIdentity(current, workspaceId, itemType, desired);
    const observedStateHash = hashObservedDeletionItem(current);
    if (observedStateHash !== approvedObservedStateHash) {
      throw new Error(
        `${displayType(itemType)} '${desired.displayName}' changed after deletion was approved.`,
      );
    }
    return "unchanged";
  }

  private async findByDisplayName(
    workspaceId: string,
    itemType: DeletableFabricItemType,
    desired: ItemDefinition,
  ): Promise<FabricWorkspaceItem | undefined> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/items`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("type", itemType);
    url.searchParams.set("recursive", "false");
    if (desired.folderId) {
      url.searchParams.set("rootFolderId", desired.folderId);
    }
    const matches = (
      await this.client.listAll<FabricWorkspaceItem>(
        `${url.pathname}${url.search}`,
      )
    ).filter(
      (item) =>
        item.type === itemType &&
        item.displayName === desired.displayName &&
        normalizeFolderId(item.folderId) ===
          normalizeFolderId(desired.folderId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple ${displayType(itemType)} items named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }
}

export function isDeletableFabricItemType(
  itemType: FabricItemType,
): itemType is DeletableFabricItemType {
  return (
    itemType === "Lakehouse" ||
    itemType === "Environment" ||
    itemType === "Notebook" ||
    itemType === "SparkJobDefinition" ||
    itemType === "DataPipeline" ||
    itemType === "SemanticModel" ||
    itemType === "Eventstream"
  );
}

export function hashObservedDeletionItem(
  item: FabricWorkspaceItem,
): string {
  return sha256(
    stableJson({
      id: item.id,
      workspaceId: item.workspaceId ?? null,
      type: item.type,
      displayName: item.displayName,
      description: normalizeDescription(item.description),
      folderId: normalizeFolderId(item.folderId),
    }),
  );
}

function assertDeletionIdentity(
  item: FabricWorkspaceItem,
  workspaceId: string,
  itemType: DeletableFabricItemType,
  desired: ItemDefinition,
): void {
  if (
    item.id.trim() === "" ||
    (item.workspaceId !== undefined &&
      item.workspaceId !== workspaceId) ||
    item.type !== itemType ||
    item.displayName !== desired.displayName ||
    normalizeFolderId(item.folderId) !==
      normalizeFolderId(desired.folderId)
  ) {
    throw new Error(
      `${displayType(itemType)} '${desired.displayName}' no longer has the approved deletion identity.`,
    );
  }
}

function itemPath(workspaceId: string, itemId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/items/${encodeURIComponent(itemId)}`;
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string | null {
  return value ?? null;
}

function displayType(itemType: DeletableFabricItemType): string {
  switch (itemType) {
    case "Lakehouse":
      return "Lakehouse";
    case "Environment":
      return "Environment";
    case "Notebook":
      return "Notebook";
    case "SparkJobDefinition":
      return "Spark Job Definition";
    case "DataPipeline":
      return "Data Pipeline";
    case "SemanticModel":
      return "Semantic Model";
    case "Eventstream":
      return "Eventstream";
  }
}
