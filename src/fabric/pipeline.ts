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
  hashPipelineDefinition,
  pipelineIncludesPlatformPart,
} from "./pipeline-definition";

export interface DataPipeline {
  id: string;
  workspaceId?: string;
  type?: "DataPipeline";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface PipelineDefinitionResponse {
  definition: FabricDefinition;
}

export interface PipelinePlanResult {
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

export interface PipelineOperationReference {
  operationId?: string;
  location?: string;
}

export class PipelineAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<PipelinePlanResult> {
    const existing = await this.findByDisplayName(
      workspaceId,
      desired,
    );
    if (!existing) {
      return {
        action: "create",
        reason: `Data Pipeline '${desired.displayName}' does not exist.`,
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
      pipelineIncludesPlatformPart(desiredDefinition);
    const desiredDefinitionHash = hashPipelineDefinition(
      desiredDefinition,
      includePlatform,
    );
    const currentDefinitionHash = hashPipelineDefinition(
      currentDefinition,
      includePlatform,
    );
    const observedStateHash = hashObservedPipeline(
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
        // The Fabric UpdateDataPipelineRequest schema has no folderId field
        // (confirmed: microsoft/fabric-rest-api-specs:dataPipeline/definitions.json).
        // Folder placement cannot be changed after creation via PATCH; the item
        // must be recreated in the target folder.
        reason: `Data Pipeline '${desired.displayName}' is in folder '${current.folderId ?? "(workspace root)"}' but the manifest targets '${desired.folderId ?? "(workspace root)"}'. The Fabric API does not support moving pipelines between folders (UpdateDataPipelineRequest has no folderId field); recreate the pipeline in the correct folder to resolve this.`,
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
          ? `Data Pipeline '${desired.displayName}' metadata differs.`
          : `Data Pipeline '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    return {
      action: "no-op",
      reason: `Data Pipeline '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<DataPipeline[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId,
      )}/dataPipelines`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<DataPipeline>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    pipelineId: string,
  ): Promise<DataPipeline> {
    const response = await this.client.request<DataPipeline>(
      "GET",
      pipelinePath(workspaceId, pipelineId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Data Pipeline response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    pipelineId: string,
    _desiredDefinition: FabricDefinition,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<PipelineDefinitionResponse>(
        "POST",
        `${pipelinePath(
          workspaceId,
          pipelineId,
        )}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<PipelineDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (
      !result?.definition ||
      !Array.isArray(result.definition.parts)
    ) {
      throw new Error(
        "Fabric Get Data Pipeline Definition response is invalid.",
      );
    }
    hashPipelineDefinition(
      result.definition,
      pipelineIncludesPlatformPart(result.definition),
    );
    return result.definition;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: PipelineOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<DataPipeline> {
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
    let response: FabricResponse<DataPipeline>;
    try {
      response = await this.client.request<DataPipeline>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(
          workspaceId,
        )}/dataPipelines`,
        {
          body,
          retryable: false,
          acceptedStatuses: [201, 202],
          onDispatch: onCreateSubmitting,
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
        ? await this.waitForCreateOperation(
            response,
            onOperationAccepted,
          )
        : response.body;
    if (!created?.id) {
      throw new Error(
        "Fabric Create Data Pipeline response is missing the item ID.",
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
    operation: PipelineOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<DataPipeline> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<DataPipeline>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Data Pipeline operation result is missing the item ID.",
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
    pipelineId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<DataPipeline> {
    const managesPlatform =
      pipelineIncludesPlatformPart(definition);
    const recoveryBaseline = onUpdateCheckpoint
      ? {
          stagedDefinitionHash: hashPipelineDefinition(
            await this.getDefinition(
              workspaceId,
              pipelineId,
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
        await this.client.request<DataPipeline>(
          "PATCH",
          pipelinePath(workspaceId, pipelineId),
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
      pipelineId,
      definition,
      managesPlatform ? onUpdateRejected : undefined,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashPipelineDefinition(
        definition,
        managesPlatform,
      ),
    });
    const verified = await this.verify(
      workspaceId,
      pipelineId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    pipelineId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<DataPipeline> {
    const actual = await this.get(workspaceId, pipelineId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Data Pipeline verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Data Pipeline '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Data Pipeline '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      pipelineId,
      desiredDefinition,
    );
    const includePlatform =
      pipelineIncludesPlatformPart(desiredDefinition);
    if (
      hashPipelineDefinition(actualDefinition, includePlatform) !==
      hashPipelineDefinition(desiredDefinition, includePlatform)
    ) {
      throw new Error(
        `Data Pipeline '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  /**
   * Resolves a physical Data Pipeline by display name and folder scope for use
   * by run-pipeline mode. Throws descriptively if the item is absent or
   * ambiguous, preventing execution against an undeployed or mismatched item.
   */
  async resolveForRun(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<DataPipeline> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      throw new Error(
        `Data Pipeline '${desired.displayName}' was not found in workspace '${workspaceId}'${
          desired.folderId ? ` (folder '${desired.folderId}')` : ""
        }. The item may not have been deployed yet.`,
      );
    }
    return this.get(workspaceId, existing.id);
  }

  private async stageDefinition(
    workspaceId: string,
    pipelineId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${pipelinePath(
          workspaceId,
          pipelineId,
        )}/updateDefinition?updateMetadata=${
          pipelineIncludesPlatformPart(definition)
            ? "true"
            : "false"
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
  ): Promise<DataPipeline | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter(
      (pipeline) =>
        pipeline.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Data Pipelines named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<DataPipeline>,
    onOperationAccepted:
      | ((operation: PipelineOperationReference) => void)
      | undefined,
  ): Promise<DataPipeline> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<DataPipeline>(
      response as FabricResponse<unknown>,
    );
  }
}

export { PipelineAdapter as DataPipelineAdapter };
export type DataPipelinePlanResult = PipelinePlanResult;
export type DataPipelineOperationReference =
  PipelineOperationReference;

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
): PipelineOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location =
    response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Data Pipeline response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function pipelinePath(
  workspaceId: string,
  pipelineId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/dataPipelines/${encodeURIComponent(pipelineId)}`;
}

function hashObservedPipeline(
  pipeline: DataPipeline,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: pipeline.id,
      displayName: pipeline.displayName,
      description: normalizeDescription(pipeline.description),
      folderId: pipeline.folderId ?? null,
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
