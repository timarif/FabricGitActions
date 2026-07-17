import { sha256, stableJson } from "../hash";
import type {
  DefinitionItemUpdateRecoveryState,
  ItemDefinition,
  PlannedAction,
} from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";
import type { FabricDefinition } from "./definition";
import {
  hashNotebookDefinition,
  notebookDefinitionFormat,
  notebookIncludesPlatformPart,
} from "./notebook-definition";

export interface Notebook {
  id: string;
  workspaceId?: string;
  type?: "Notebook";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface NotebookDefinitionResponse {
  definition: FabricDefinition;
}

export interface NotebookPlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  stagedDefinitionHash?: string;
  managedMetadataMatches?: boolean;
}

export interface NotebookOperationReference {
  operationId?: string;
  location?: string;
}

export class NotebookAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<NotebookPlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Notebook '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    const currentDefinition = await this.getDefinition(
      workspaceId,
      existing.id,
      desiredDefinition,
    );
    const includePlatform =
      notebookIncludesPlatformPart(desiredDefinition);
    const desiredDefinitionHash = hashNotebookDefinition(
      desiredDefinition,
      includePlatform,
    );
    const currentDefinitionHash = hashNotebookDefinition(
      currentDefinition,
      includePlatform,
    );
    const observedStateHash = hashObservedNotebook(
      current,
      currentDefinitionHash,
    );
    const folderMatches =
      normalizeFolderId(current.folderId) ===
      normalizeFolderId(desired.folderId);
    const descriptionMatches =
      desired.description === undefined ||
      normalizeDescription(current.description) ===
        normalizeDescription(desired.description);
    const managedMetadataMatches =
      current.displayName === desired.displayName &&
      folderMatches &&
      descriptionMatches;

    if (!folderMatches) {
      return {
        action: "blocked",
        reason: `Notebook '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    if (
      !descriptionMatches ||
      currentDefinitionHash !== desiredDefinitionHash
    ) {
      return {
        action: "update",
        reason: !descriptionMatches
          ? `Notebook '${desired.displayName}' metadata differs.`
          : `Notebook '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    return {
      action: "no-op",
      reason: `Notebook '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<Notebook[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/notebooks`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<Notebook>(`${url.pathname}${url.search}`);
  }

  async get(
    workspaceId: string,
    notebookId: string,
  ): Promise<Notebook> {
    const response = await this.client.request<Notebook>(
      "GET",
      notebookPath(workspaceId, notebookId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Notebook response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    notebookId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<FabricDefinition> {
    const format = notebookDefinitionFormat(desiredDefinition);
    const response =
      await this.client.request<NotebookDefinitionResponse>(
        "POST",
        `${notebookPath(
          workspaceId,
          notebookId,
        )}/getDefinition?format=${encodeURIComponent(format)}`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<NotebookDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error(
        "Fabric Get Notebook Definition response is invalid.",
      );
    }
    return {
      ...result.definition,
      format: result.definition.format ?? format,
    };
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (operation: NotebookOperationReference) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<Notebook> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
      definition,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }
    onCreateSubmitting?.();
    let response: FabricResponse<Notebook>;
    try {
      response = await this.client.request<Notebook>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/notebooks`,
        {
          body,
          retryable: false,
          acceptedStatuses: [201, 202],
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        onCreateRejected?.();
      }
      throw error;
    }
    const created =
      response.status === 202
        ? await this.waitForCreateOperation(response, onOperationAccepted)
        : response.body;
    if (!created?.id) {
      throw new Error(
        "Fabric Create Notebook response is missing the item ID.",
      );
    }
    const verified = await this.verify(
      workspaceId,
      created.id,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    operation: NotebookOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<Notebook> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<Notebook>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Notebook operation result is missing the item ID.",
      );
    }
    const verified = await this.verify(
      workspaceId,
      created.id,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async update(
    workspaceId: string,
    notebookId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<Notebook> {
    const managesPlatform =
      notebookIncludesPlatformPart(definition);
    const recoveryBaseline = onUpdateCheckpoint
      ? {
          stagedDefinitionHash: hashNotebookDefinition(
            await this.getDefinition(
              workspaceId,
              notebookId,
              definition,
            ),
            managesPlatform,
          ),
        }
      : undefined;
    if (recoveryBaseline) {
      onUpdateCheckpoint?.({
        phase: "metadata-submitting",
        ...recoveryBaseline,
      });
    } else {
      onUpdateCheckpoint?.();
    }

    if (!managesPlatform) {
      const metadataBody: Record<string, unknown> = {
        displayName: desired.displayName,
      };
      if (desired.description !== undefined) {
        metadataBody.description = desired.description;
      }
      try {
        await this.client.request<Notebook>(
          "PATCH",
          notebookPath(workspaceId, notebookId),
          {
            body: metadataBody,
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
      if (recoveryBaseline) {
        onUpdateCheckpoint?.({
          phase: "metadata-updated",
          ...recoveryBaseline,
        });
      }
    }

    await this.stageDefinition(
      workspaceId,
      notebookId,
      definition,
      managesPlatform ? onUpdateRejected : undefined,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashNotebookDefinition(
        definition,
        managesPlatform,
      ),
    });
    const verified = await this.verify(
      workspaceId,
      notebookId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    notebookId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<Notebook> {
    const actual = await this.get(workspaceId, notebookId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Notebook verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Notebook '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Notebook '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      notebookId,
      desiredDefinition,
    );
    const includePlatform =
      notebookIncludesPlatformPart(desiredDefinition);
    if (
      hashNotebookDefinition(actualDefinition, includePlatform) !==
      hashNotebookDefinition(desiredDefinition, includePlatform)
    ) {
      throw new Error(
        `Notebook '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    notebookId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${notebookPath(
          workspaceId,
          notebookId,
        )}/updateDefinition?updateMetadata=${
          notebookIncludesPlatformPart(definition) ? "true" : "false"
        }`,
        {
          body: { definition },
          retryable: false,
          acceptedStatuses: [200, 202],
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        onInitialRequestRejected?.();
      }
      throw error;
    }
    await this.client.waitForOperationCompletion(
      response as FabricResponse<unknown>,
    );
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<Notebook | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (notebook) => notebook.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Notebooks named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<Notebook>,
    onOperationAccepted:
      | ((operation: NotebookOperationReference) => void)
      | undefined,
  ): Promise<Notebook> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<Notebook>(
      response as FabricResponse<unknown>,
    );
  }
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

function readOperationReference(
  response: FabricResponse<unknown>,
): NotebookOperationReference {
  const operationId = response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Notebook response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function notebookPath(workspaceId: string, notebookId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/notebooks/${encodeURIComponent(notebookId)}`;
}

function hashObservedNotebook(
  notebook: Notebook,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: notebook.id,
      displayName: notebook.displayName,
      description: normalizeDescription(notebook.description),
      folderId: notebook.folderId ?? null,
      definitionHash,
    }),
  );
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string {
  return value ?? "";
}
