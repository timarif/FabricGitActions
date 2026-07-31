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
import { hashOntologyDefinition } from "./ontology-definition";

export interface Ontology {
  id: string;
  workspaceId?: string;
  type?: "Ontology";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface OntologyDefinitionResponse {
  definition: FabricDefinition;
}

export interface OntologyPlanResult {
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

export interface OntologyOperationReference {
  operationId?: string;
  location?: string;
}

export class OntologyAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<OntologyPlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Ontology '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    let currentDefinition: FabricDefinition;
    try {
      currentDefinition = await this.getDefinition(
        workspaceId,
        existing.id,
      );
    } catch (error) {
      if (!isDefinitionUnavailable(error)) {
        throw error;
      }
      return {
        action: "blocked",
        reason: `Ontology '${desired.displayName}' definition cannot be read. An encrypted sensitivity label or unsupported service state may be blocking getDefinition.`,
        physicalId: current.id,
        observedStateHash: hashObservedOntology(current, null),
      };
    }
    const desiredDefinitionHash =
      hashOntologyDefinition(desiredDefinition);
    const currentDefinitionHash =
      hashOntologyDefinition(currentDefinition);
    const observedStateHash = hashObservedOntology(
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
        reason: `Ontology '${desired.displayName}' is in a different folder; folder moves are not supported.`,
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
          ? `Ontology '${desired.displayName}' metadata differs.`
          : `Ontology '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    return {
      action: "no-op",
      reason: `Ontology '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<Ontology[]> {
    const url = new URL(
      ontologyCollectionPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<Ontology>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    ontologyId: string,
  ): Promise<Ontology> {
    const response = await this.client.request<Ontology>(
      "GET",
      ontologyPath(workspaceId, ontologyId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Ontology response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    ontologyId: string,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<OntologyDefinitionResponse>(
        "POST",
        `${ontologyPath(workspaceId, ontologyId)}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<OntologyDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error(
        "Fabric Get Ontology Definition response is invalid.",
      );
    }
    return {
      ...result.definition,
    };
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: OntologyOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<Ontology> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
      definition: {
        parts: definition.parts,
      },
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    let response: FabricResponse<Ontology>;
    try {
      response = await this.client.request<Ontology>(
        "POST",
        ontologyCollectionPath(workspaceId),
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
        ? await this.waitForCreateOperation(response, onOperationAccepted)
        : response.body;
    if (!created?.id) {
      throw new Error(
        "Fabric Create Ontology response is missing the item ID.",
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
    operation: OntologyOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<Ontology> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<Ontology>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Ontology operation result is missing the item ID.",
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
    ontologyId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<Ontology> {
    const recoveryBaseline = onUpdateCheckpoint
      ? {
          stagedDefinitionHash: hashOntologyDefinition(
            await this.getDefinition(workspaceId, ontologyId),
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

    const metadataBody: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      metadataBody.description = desired.description;
    }
    try {
      await this.client.request<Ontology>(
        "PATCH",
        ontologyPath(workspaceId, ontologyId),
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

    await this.stageDefinition(
      workspaceId,
      ontologyId,
      definition,
      onUpdateRejected,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashOntologyDefinition(definition),
    });
    const verified = await this.verify(
      workspaceId,
      ontologyId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    ontologyId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<Ontology> {
    const actual = await this.get(workspaceId, ontologyId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Ontology verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Ontology '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Ontology '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      ontologyId,
    );
    if (
      hashOntologyDefinition(actualDefinition) !==
      hashOntologyDefinition(desiredDefinition)
    ) {
      throw new Error(
        `Ontology '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    ontologyId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${ontologyPath(
          workspaceId,
          ontologyId,
        )}/updateDefinition?updateMetadata=true`,
        {
          body: {
            definition: {
              parts: definition.parts,
            },
          },
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
  ): Promise<Ontology | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (ontology) => ontology.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Ontologies named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<Ontology>,
    onOperationAccepted:
      | ((operation: OntologyOperationReference) => void)
      | undefined,
  ): Promise<Ontology> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<Ontology>(
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

function isDefinitionUnavailable(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    (error.code === "OperationNotSupportedForItem" ||
      error.code === "ItemHasSensitivityLabelBlockingOperation")
  );
}

function readOperationReference(
  response: FabricResponse<unknown>,
): OntologyOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Ontology response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function ontologyCollectionPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/ontologies`;
}

function ontologyPath(
  workspaceId: string,
  ontologyId: string,
): string {
  return `${ontologyCollectionPath(workspaceId)}/${encodeURIComponent(
    ontologyId,
  )}`;
}

function hashObservedOntology(
  ontology: Ontology,
  definitionHash: string | null,
): string {
  return sha256(
    stableJson({
      id: ontology.id,
      displayName: ontology.displayName,
      description: normalizeDescription(ontology.description),
      folderId: ontology.folderId ?? null,
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
