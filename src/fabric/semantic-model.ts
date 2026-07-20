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
  auxiliarySemanticModelParts,
  buildEffectiveSemanticModelDefinition,
  hashAuxiliarySemanticModelParts,
  hashSemanticModelDefinition,
  semanticModelDefinitionFormat,
  semanticModelIncludesCopilotParts,
  semanticModelIncludesDiagramLayoutPart,
  semanticModelIncludesPlatformPart,
  semanticModelPlatformLogicalId,
} from "./semantic-model-definition";

export interface SemanticModel {
  id: string;
  workspaceId?: string;
  type?: "SemanticModel";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface SemanticModelDefinitionResponse {
  definition: FabricDefinition;
}

export interface SemanticModelPlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  stagedDefinitionHash?: string;
  managedMetadataMatches?: boolean;
  /**
   * SHA-256 of the auxiliary parts (`.platform`, `diagramLayout.json`,
   * `Copilot/**`) currently on the service. Used during recovery to verify
   * that the preserved auxiliary parts were not lost during an interrupted
   * full-replacement update.
   */
  currentAuxiliaryHash?: string;
}

export interface SemanticModelOperationReference {
  operationId?: string;
  location?: string;
}

interface SemanticModelMatch {
  semanticModel: SemanticModel;
  definition?: FabricDefinition;
}

export class SemanticModelAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<SemanticModelPlanResult> {
    const match = await this.findExisting(
      workspaceId,
      desired,
      desiredDefinition,
    );
    if (!match) {
      return {
        action: "create",
        reason: `Semantic Model '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const existing = match.semanticModel;
    const current = await this.get(workspaceId, existing.id);
    const currentDefinition =
      match.definition ??
      (await this.getDefinition(
        workspaceId,
        existing.id,
        desiredDefinition,
      ));
    const includePlatform =
      semanticModelIncludesPlatformPart(desiredDefinition);
    const includeDiagramLayout =
      semanticModelIncludesDiagramLayoutPart(desiredDefinition);
    const includeCopilot =
      semanticModelIncludesCopilotParts(desiredDefinition);
    const effectiveDesiredDefinition =
      buildEffectiveSemanticModelDefinition(
        desiredDefinition,
        currentDefinition,
      );
    const desiredDefinitionHash = hashSemanticModelDefinition(
      effectiveDesiredDefinition,
      includePlatform,
      includeDiagramLayout,
      includeCopilot,
    );
    const currentDefinitionHash = hashSemanticModelDefinition(
      currentDefinition,
      includePlatform,
      includeDiagramLayout,
      includeCopilot,
    );
    const currentAuxiliaryHash = hashAuxiliarySemanticModelParts(
      auxiliarySemanticModelParts(currentDefinition),
    );
    const observedStateHash = hashObservedSemanticModel(
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
        reason: `Semantic Model '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }

    // Block if both current and desired definitions carry a .platform logicalId
    // and they differ — overwriting an existing identity silently is unsafe.
    const currentLogicalId =
      semanticModelPlatformLogicalId(currentDefinition);
    const desiredLogicalId =
      semanticModelPlatformLogicalId(desiredDefinition);
    if (
      currentLogicalId !== undefined &&
      desiredLogicalId !== undefined &&
      currentLogicalId !== desiredLogicalId
    ) {
      return {
        action: "blocked",
        reason:
          `Semantic Model '${desired.displayName}' .platform logicalId mismatch: ` +
          `current is '${currentLogicalId}', desired is '${desiredLogicalId}'. ` +
          `Update the current Fabric item's .platform logicalId to match before deploying.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }

    if (
      !descriptionMatches ||
      currentDefinitionHash !== desiredDefinitionHash
    ) {
      return {
        action: "update",
        reason: !descriptionMatches
          ? `Semantic Model '${desired.displayName}' metadata differs.`
          : `Semantic Model '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }
    return {
      action: "no-op",
      reason: `Semantic Model '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
      currentAuxiliaryHash,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
    recursive = false,
  ): Promise<SemanticModel[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(
        workspaceId,
      )}/semanticModels`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", String(recursive));
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<SemanticModel>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    semanticModelId: string,
  ): Promise<SemanticModel> {
    const response = await this.client.request<SemanticModel>(
      "GET",
      semanticModelPath(workspaceId, semanticModelId),
    );
    if (!response.body) {
      throw new Error(
        "Fabric Get Semantic Model response is empty.",
      );
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    semanticModelId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<FabricDefinition> {
    const format =
      semanticModelDefinitionFormat(desiredDefinition);
    const response =
      await this.client.request<SemanticModelDefinitionResponse>(
        "POST",
        `${semanticModelPath(
          workspaceId,
          semanticModelId,
        )}/getDefinition?format=${format}`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<SemanticModelDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (
      !result?.definition ||
      !Array.isArray(result.definition.parts)
    ) {
      throw new Error(
        "Fabric Get Semantic Model Definition response is invalid.",
      );
    }
    const definition = {
      ...result.definition,
      format: result.definition.format ?? format,
    };
    hashSemanticModelDefinition(
      definition,
      semanticModelIncludesPlatformPart(definition),
      semanticModelIncludesDiagramLayoutPart(definition),
    );
    return definition;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: SemanticModelOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<SemanticModel> {
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
    let response: FabricResponse<SemanticModel>;
    try {
      response = await this.client.request<SemanticModel>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(
          workspaceId,
        )}/semanticModels`,
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
        "Fabric Create Semantic Model response is missing the item ID.",
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
    operation: SemanticModelOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<SemanticModel> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<SemanticModel>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Semantic Model operation result is missing the item ID.",
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
    semanticModelId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<SemanticModel> {
    const managesPlatform =
      semanticModelIncludesPlatformPart(definition);
    const includeDiagramLayout =
      semanticModelIncludesDiagramLayoutPart(definition);
    const managedCopilot =
      semanticModelIncludesCopilotParts(definition);

    // Always fetch the current definition to identify auxiliary parts that
    // must be preserved in the full-replacement request body. This prevents
    // updateDefinition from silently erasing service-side .platform,
    // diagramLayout.json, and Copilot/** parts that the desired omits.
    const currentDefinition = await this.getDefinition(
      workspaceId,
      semanticModelId,
      definition,
    );
    const effectiveDefinition = buildEffectiveSemanticModelDefinition(
      definition,
      currentDefinition,
    );
    const effectiveAuxiliaryHash =
      hashAuxiliarySemanticModelParts(
        auxiliarySemanticModelParts(effectiveDefinition),
      );
    const desiredDefinitionHash =
      hashSemanticModelDefinition(
        effectiveDefinition,
        managesPlatform,
        includeDiagramLayout,
        managedCopilot,
      );

    const recoveryBaseline = onUpdateCheckpoint
      ? {
          stagedDefinitionHash: hashSemanticModelDefinition(
            currentDefinition,
            managesPlatform,
            includeDiagramLayout,
            managedCopilot,
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
        await this.client.request<SemanticModel>(
          "PATCH",
          semanticModelPath(
            workspaceId,
            semanticModelId,
          ),
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

    onUpdateCheckpoint?.({
      phase: "definition-submitting",
      stagedDefinitionHash:
        recoveryBaseline?.stagedDefinitionHash ??
        hashSemanticModelDefinition(
          currentDefinition,
          managesPlatform,
          includeDiagramLayout,
          managedCopilot,
        ),
      preservedAuxiliaryHash: effectiveAuxiliaryHash,
    });
    await this.stageDefinition(
      workspaceId,
      semanticModelId,
      effectiveDefinition,
      managesPlatform,
      managesPlatform ? onUpdateRejected : undefined,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: desiredDefinitionHash,
      preservedAuxiliaryHash: effectiveAuxiliaryHash,
    });
    const verified = await this.verify(
      workspaceId,
      semanticModelId,
      desired,
      definition,
      effectiveAuxiliaryHash,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    semanticModelId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    expectedAuxiliaryHash?: string,
  ): Promise<SemanticModel> {
    const actual = await this.get(
      workspaceId,
      semanticModelId,
    );
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Semantic Model verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Semantic Model '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Semantic Model '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      semanticModelId,
      desiredDefinition,
    );
    const includePlatform =
      semanticModelIncludesPlatformPart(desiredDefinition);
    const includeDiagramLayout =
      semanticModelIncludesDiagramLayoutPart(desiredDefinition);
    const includeCopilot =
      semanticModelIncludesCopilotParts(desiredDefinition);
    const effectiveDesiredDefinition =
      buildEffectiveSemanticModelDefinition(
        desiredDefinition,
        actualDefinition,
      );
    if (
      hashSemanticModelDefinition(
        actualDefinition,
        includePlatform,
        includeDiagramLayout,
        includeCopilot,
      ) !==
      hashSemanticModelDefinition(
        effectiveDesiredDefinition,
        includePlatform,
        includeDiagramLayout,
        includeCopilot,
      )
    ) {
      throw new Error(
        `Semantic Model '${desired.displayName}' verification failed for definition content.`,
      );
    }
    if (
      expectedAuxiliaryHash !== undefined &&
      hashAuxiliarySemanticModelParts(
        auxiliarySemanticModelParts(actualDefinition),
      ) !== expectedAuxiliaryHash
    ) {
      throw new Error(
        `Semantic Model '${desired.displayName}' verification failed because auxiliary definition parts were not preserved.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    semanticModelId: string,
    definition: FabricDefinition,
    updateMetadata: boolean,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${semanticModelPath(
          workspaceId,
          semanticModelId,
        )}/updateDefinition?updateMetadata=${String(
          updateMetadata,
        )}`,
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

  private async findExisting(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<SemanticModelMatch | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter(
      (semanticModel) =>
        semanticModel.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Semantic Models named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    const nameMatch = matches[0];
    const desiredLogicalId =
      semanticModelPlatformLogicalId(desiredDefinition);
    if (!desiredLogicalId) {
      return nameMatch
        ? { semanticModel: nameMatch }
        : undefined;
    }

    let nameMatchDefinition: FabricDefinition | undefined;
    if (nameMatch) {
      nameMatchDefinition = await this.getDefinition(
        workspaceId,
        nameMatch.id,
        desiredDefinition,
      );
      if (
        semanticModelPlatformLogicalId(
          nameMatchDefinition,
        ) === desiredLogicalId
      ) {
        return {
          semanticModel: nameMatch,
          definition: nameMatchDefinition,
        };
      }
    }

    const identityMatches: SemanticModelMatch[] = [];
    for (const semanticModel of await this.list(
      workspaceId,
      undefined,
      true,
    )) {
      if (semanticModel.id === nameMatch?.id) {
        continue;
      }
      const definition = await this.getDefinition(
        workspaceId,
        semanticModel.id,
        desiredDefinition,
      );
      if (
        semanticModelPlatformLogicalId(definition) ===
        desiredLogicalId
      ) {
        identityMatches.push({ semanticModel, definition });
      }
    }
    if (identityMatches.length > 1) {
      throw new Error(
        `Multiple Semantic Models with .platform logicalId '${desiredLogicalId}' were found.`,
      );
    }
    const identityMatch = identityMatches[0];
    if (identityMatch && nameMatch) {
      throw new Error(
        `Semantic Model .platform logicalId '${desiredLogicalId}' resolves to '${identityMatch.semanticModel.displayName}', but the desired folder already contains a different Semantic Model named '${desired.displayName}'.`,
      );
    }
    if (identityMatch) {
      return identityMatch;
    }
    return nameMatch
      ? {
          semanticModel: nameMatch,
          definition: nameMatchDefinition,
        }
      : undefined;
  }

  private async waitForCreateOperation(
    response: FabricResponse<SemanticModel>,
    onOperationAccepted:
      | ((operation: SemanticModelOperationReference) => void)
      | undefined,
  ): Promise<SemanticModel> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<SemanticModel>(
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
): SemanticModelOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location =
    response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Semantic Model response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function semanticModelPath(
  workspaceId: string,
  semanticModelId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/semanticModels/${encodeURIComponent(semanticModelId)}`;
}

function hashObservedSemanticModel(
  semanticModel: SemanticModel,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: semanticModel.id,
      displayName: semanticModel.displayName,
      description: normalizeDescription(
        semanticModel.description,
      ),
      folderId: semanticModel.folderId ?? null,
      definitionHash,
    }),
  );
}

function normalizeDescription(
  value: string | undefined,
): string {
  return value ?? "";
}

function normalizeFolderId(
  value: string | undefined,
): string {
  return value ?? "";
}
