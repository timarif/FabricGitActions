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
  hashSparkJobDefinition,
  sparkJobDefinitionFormat,
  sparkJobIncludesPlatformPart,
} from "./spark-job-definition";

export interface SparkJobDefinitionItem {
  id: string;
  workspaceId?: string;
  type?: "SparkJobDefinition";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface SparkJobDefinitionResponse {
  definition: FabricDefinition;
}

export interface SparkJobPlanResult {
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

export interface SparkJobOperationReference {
  operationId?: string;
  location?: string;
}

export class SparkJobAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<SparkJobPlanResult> {
    const existing = await this.findByDisplayName(
      workspaceId,
      desired,
    );
    if (!existing) {
      return {
        action: "create",
        reason: `Spark Job Definition '${desired.displayName}' does not exist.`,
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
      sparkJobIncludesPlatformPart(desiredDefinition);
    const desiredDefinitionHash = hashSparkJobDefinition(
      desiredDefinition,
      includePlatform,
    );
    const currentDefinitionHash = hashSparkJobDefinition(
      currentDefinition,
      includePlatform,
      { allowExternalExecutable: true },
    );
    const observedStateHash = hashObservedSparkJob(
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
        reason: `Spark Job Definition '${desired.displayName}' is in a different folder; folder moves are not supported.`,
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
          ? `Spark Job Definition '${desired.displayName}' metadata differs.`
          : `Spark Job Definition '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    return {
      action: "no-op",
      reason: `Spark Job Definition '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<SparkJobDefinitionItem[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId,
      )}/sparkJobDefinitions`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<SparkJobDefinitionItem>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    sparkJobId: string,
  ): Promise<SparkJobDefinitionItem> {
    const response =
      await this.client.request<SparkJobDefinitionItem>(
        "GET",
        sparkJobPath(workspaceId, sparkJobId),
      );
    if (!response.body) {
      throw new Error(
        "Fabric Get Spark Job Definition response is empty.",
      );
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    sparkJobId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<FabricDefinition> {
    const format = sparkJobDefinitionFormat(desiredDefinition);
    const response =
      await this.client.request<SparkJobDefinitionResponse>(
        "POST",
        `${sparkJobPath(
          workspaceId,
          sparkJobId,
        )}/getDefinition?format=${encodeURIComponent(format)}`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<SparkJobDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (
      !result?.definition ||
      !Array.isArray(result.definition.parts)
    ) {
      throw new Error(
        "Fabric Get Spark Job Definition response is invalid.",
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
    onOperationAccepted?: (
      operation: SparkJobOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<SparkJobDefinitionItem> {
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
    let response: FabricResponse<SparkJobDefinitionItem>;
    try {
      response =
        await this.client.request<SparkJobDefinitionItem>(
          "POST",
          `/v1/workspaces/${encodeURIComponent(
            workspaceId,
          )}/sparkJobDefinitions`,
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
        "Fabric Create Spark Job Definition response is missing the item ID.",
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
    operation: SparkJobOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<SparkJobDefinitionItem> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<SparkJobDefinitionItem>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Spark Job Definition operation result is missing the item ID.",
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
    sparkJobId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<SparkJobDefinitionItem> {
    const managesPlatform =
      sparkJobIncludesPlatformPart(definition);
    const recoveryBaseline = onUpdateCheckpoint
      ? {
          stagedDefinitionHash: hashSparkJobDefinition(
            await this.getDefinition(
              workspaceId,
              sparkJobId,
              definition,
            ),
            managesPlatform,
            { allowExternalExecutable: true },
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
        await this.client.request<SparkJobDefinitionItem>(
          "PATCH",
          sparkJobPath(workspaceId, sparkJobId),
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
      sparkJobId,
      definition,
      managesPlatform ? onUpdateRejected : undefined,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashSparkJobDefinition(
        definition,
        managesPlatform,
      ),
    });
    const verified = await this.verify(
      workspaceId,
      sparkJobId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    sparkJobId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<SparkJobDefinitionItem> {
    const actual = await this.get(workspaceId, sparkJobId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Spark Job Definition verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Spark Job Definition '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Spark Job Definition '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      sparkJobId,
      desiredDefinition,
    );
    const includePlatform =
      sparkJobIncludesPlatformPart(desiredDefinition);
    if (
      hashSparkJobDefinition(actualDefinition, includePlatform, {
        allowExternalExecutable: true,
      }) !==
      hashSparkJobDefinition(desiredDefinition, includePlatform)
    ) {
      throw new Error(
        `Spark Job Definition '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    sparkJobId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${sparkJobPath(
          workspaceId,
          sparkJobId,
        )}/updateDefinition?updateMetadata=${
          sparkJobIncludesPlatformPart(definition)
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
  ): Promise<SparkJobDefinitionItem | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter(
      (sparkJob) =>
        sparkJob.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Spark Job Definitions named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<SparkJobDefinitionItem>,
    onOperationAccepted:
      | ((operation: SparkJobOperationReference) => void)
      | undefined,
  ): Promise<SparkJobDefinitionItem> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<SparkJobDefinitionItem>(
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
): SparkJobOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Spark Job Definition response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function sparkJobPath(
  workspaceId: string,
  sparkJobId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/sparkJobDefinitions/${encodeURIComponent(sparkJobId)}`;
}

function hashObservedSparkJob(
  sparkJob: SparkJobDefinitionItem,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: sparkJob.id,
      displayName: sparkJob.displayName,
      description: normalizeDescription(sparkJob.description),
      folderId: sparkJob.folderId ?? null,
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
