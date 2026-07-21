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
import type { FabricDefinition, FabricDefinitionPart } from "./definition";
import {
  THROUGHPUT_ORDER,
  eventstreamIncludesPlatformPart,
  eventstreamIncludesPropertiesPart,
  getEventstreamThroughputLevel,
  hashEventstreamDefinition,
} from "./eventstream-definition";

export interface FabricEventstream {
  id: string;
  workspaceId?: string;
  type?: "Eventstream";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface EventstreamDefinitionResponse {
  definition: FabricDefinition;
}

export interface EventstreamPlanResult {
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

export interface EventstreamOperationReference {
  operationId?: string;
  location?: string;
}

export class EventstreamAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<EventstreamPlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Eventstream '${desired.displayName}' does not exist.`,
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
        reason: `Eventstream '${desired.displayName}' definition cannot be read. An encrypted sensitivity label or unsupported service state may be blocking getDefinition.`,
        physicalId: current.id,
        observedStateHash: hashObservedEventstream(current, null),
      };
    }
    const includeProperties = eventstreamIncludesPropertiesPart(
      desiredDefinition,
    );
    const includePlatform =
      eventstreamIncludesPlatformPart(desiredDefinition);
    const desiredDefinitionHash = hashEventstreamDefinition(
      desiredDefinition,
      includePlatform,
      includeProperties,
    );
    const currentDefinitionHash = hashEventstreamDefinition(
      currentDefinition,
      includePlatform,
      includeProperties,
    );
    const observedStateHash = hashObservedEventstream(
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
        reason: `Eventstream '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }

    // Block service-impossible throughput downgrades before dispatching any
    // updateDefinition request. eventThroughputLevel is upgrade-only on the
    // server (Low → Medium → High); downgrading returns 400.
    // Only checked when the user's desired definition manages
    // eventstreamProperties.json (includeProperties=true).
    if (includeProperties) {
      const desiredThroughput = getEventstreamThroughputLevel(desiredDefinition);
      const observedThroughput = getEventstreamThroughputLevel(
        currentDefinition,
      );
      if (
        THROUGHPUT_ORDER[desiredThroughput] <
        THROUGHPUT_ORDER[observedThroughput]
      ) {
        return {
          action: "blocked",
          reason:
            `Eventstream '${desired.displayName}' eventThroughputLevel cannot be ` +
            `downgraded from ${observedThroughput} to ${desiredThroughput}. ` +
            `eventThroughputLevel is upgrade-only (Low → Medium → High); ` +
            `update eventstreamProperties.json to set eventThroughputLevel to ` +
            `"${observedThroughput}" or higher, or remove the change.`,
          physicalId: current.id,
          observedStateHash,
          stagedDefinitionHash: currentDefinitionHash,
          managedMetadataMatches,
        };
      }
    }

    if (
      !descriptionMatches ||
      currentDefinitionHash !== desiredDefinitionHash
    ) {
      return {
        action: "update",
        reason: !descriptionMatches
          ? `Eventstream '${desired.displayName}' metadata differs.`
          : `Eventstream '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }
    return {
      action: "no-op",
      reason: `Eventstream '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<FabricEventstream[]> {
    const url = new URL(
      eventstreamCollectionPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<FabricEventstream>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    eventstreamId: string,
  ): Promise<FabricEventstream> {
    const response = await this.client.request<FabricEventstream>(
      "GET",
      eventstreamPath(workspaceId, eventstreamId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Eventstream response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    eventstreamId: string,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<EventstreamDefinitionResponse>(
        "POST",
        `${eventstreamPath(workspaceId, eventstreamId)}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<EventstreamDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error(
        "Fabric Get Eventstream Definition response is invalid.",
      );
    }
    // The server omits the format field; callers use "eventstream" when
    // submitting to updateDefinition.
    return result.definition;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: EventstreamOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<FabricEventstream> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
      definition: {
        format: "eventstream",
        parts: definition.parts,
      },
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }

    let response: FabricResponse<FabricEventstream>;
    try {
      response = await this.client.request<FabricEventstream>(
        "POST",
        eventstreamCollectionPath(workspaceId),
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
        "Fabric Create Eventstream response is missing the item ID.",
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
    operation: EventstreamOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<FabricEventstream> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created =
      await this.client.waitForOperation<FabricEventstream>({
        status: 202,
        headers,
        body: undefined,
      });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Eventstream operation result is missing the item ID.",
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
    eventstreamId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<FabricEventstream> {
    const managesPlatform = eventstreamIncludesPlatformPart(definition);
    const includeProperties = eventstreamIncludesPropertiesPart(definition);

    // Fetch the observed definition once — used for both the checkpoint
    // baseline and to preserve unmanaged parts (see stageDefinition).
    let observedDefinition: FabricDefinition | undefined;
    if (onUpdateCheckpoint) {
      observedDefinition = await this.getDefinition(
        workspaceId,
        eventstreamId,
      );
    }
    const recoveryBaseline = observedDefinition
      ? {
          stagedDefinitionHash: hashEventstreamDefinition(
            observedDefinition,
            managesPlatform,
            includeProperties,
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

    // Phase 1: PATCH metadata when the .platform part does not manage it
    if (!managesPlatform) {
      const metadataBody: Record<string, unknown> = {
        displayName: desired.displayName,
      };
      if (desired.description !== undefined) {
        metadataBody.description = desired.description;
      }
      try {
        await this.client.request<FabricEventstream>(
          "PATCH",
          eventstreamPath(workspaceId, eventstreamId),
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

    // Phase 2: updateDefinition — preserve unmanaged parts from observed
    await this.stageDefinition(
      workspaceId,
      eventstreamId,
      definition,
      observedDefinition,
      managesPlatform ? onUpdateRejected : undefined,
    );

    // Checkpoint with the effective submitted hash (desired + preserved
    // unmanaged parts) so recovery proof matches what was actually staged.
    const effectiveParts = buildEffectiveParts(definition, observedDefinition);
    const effectiveDefinition: FabricDefinition = { parts: effectiveParts };
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashEventstreamDefinition(
        effectiveDefinition,
        managesPlatform,
        includeProperties,
      ),
    });
    const verified = await this.verify(
      workspaceId,
      eventstreamId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    eventstreamId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<FabricEventstream> {
    const actual = await this.get(workspaceId, eventstreamId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Eventstream verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Eventstream '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Eventstream '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      eventstreamId,
    );
    const includePlatform =
      eventstreamIncludesPlatformPart(desiredDefinition);
    const includeProperties =
      eventstreamIncludesPropertiesPart(desiredDefinition);
    const desiredHash = hashEventstreamDefinition(
      desiredDefinition,
      includePlatform,
      includeProperties,
    );
    const actualHash = hashEventstreamDefinition(
      actualDefinition,
      includePlatform,
      includeProperties,
    );
    if (desiredHash !== actualHash) {
      throw new Error(
        `Eventstream '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    eventstreamId: string,
    desiredDefinition: FabricDefinition,
    observedDefinition: FabricDefinition | undefined,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    const managesPlatform = eventstreamIncludesPlatformPart(
      desiredDefinition,
    );

    // updateDefinition performs a full replacement — merge in any unmanaged
    // parts (eventstreamProperties.json, .platform) preserved from the
    // observed definition so submitting the desired definition does not
    // reset server-managed state (e.g. retention/throughput) to defaults.
    const effectiveParts = buildEffectiveParts(
      desiredDefinition,
      observedDefinition,
    );

    const updateMetadata = managesPlatform ? "true" : "false";
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${eventstreamPath(workspaceId, eventstreamId)}/updateDefinition?updateMetadata=${updateMetadata}`,
        {
          body: {
            definition: {
              format: "eventstream",
              parts: effectiveParts,
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
  ): Promise<FabricEventstream | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter(
      (es) =>
        es.displayName === desired.displayName &&
        normalizeFolderId(es.folderId) ===
          normalizeFolderId(desired.folderId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Eventstreams named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<FabricEventstream>,
    onOperationAccepted:
      | ((operation: EventstreamOperationReference) => void)
      | undefined,
  ): Promise<FabricEventstream> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<FabricEventstream>(
      response as FabricResponse<unknown>,
    );
  }
}

/**
 * Builds the effective definition parts for updateDefinition submission.
 *
 * When the user's desired definition does not manage a part that the server
 * always returns (eventstreamProperties.json, .platform), we preserve the
 * observed part to keep the effective submission stable and consistent with
 * the server's current state.
 *
 * Live probe evidence (workspace a67215a2, 2026-07-21):
 *   - Server PRESERVES eventstreamProperties.json (and .platform) when those
 *     parts are omitted from an updateDefinition body — it does NOT reset them
 *     to defaults. The preservation here is therefore conservative but
 *     harmless: it guarantees the checkpoint hash matches the effective
 *     submitted state even if server behaviour changes in a future API version.
 *
 * Important server constraint (observed):
 *   - eventThroughputLevel is upgrade-only. Attempts to lower the level
 *     (e.g. Medium → Low) return 400 EventStreamBadWebRequest:
 *     "The throughput level can only be upgraded into a higher level.
 *      Once applied, it cannot be downgraded."
 *     The adapter will propagate this error to the caller with the server's
 *     message; no client-side pre-validation is attempted.
 */
function buildEffectiveParts(
  desiredDefinition: FabricDefinition,
  observedDefinition: FabricDefinition | undefined,
): FabricDefinitionPart[] {
  const desiredPaths = new Set(desiredDefinition.parts.map((p) => p.path));
  const preservedParts: FabricDefinitionPart[] = observedDefinition
    ? observedDefinition.parts.filter(
        (p) =>
          !desiredPaths.has(p.path) &&
          (p.path === "eventstreamProperties.json" || p.path === ".platform"),
      )
    : [];
  return [...desiredDefinition.parts, ...preservedParts];
}

// ---------------------------------------------------------------------------
// Public helpers (used by apply.ts recovery proof functions)
// ---------------------------------------------------------------------------

export function hashObservedEventstream(
  eventstream: FabricEventstream,
  definitionHash: string | null,
): string {
  return sha256(
    stableJson({
      id: eventstream.id,
      displayName: eventstream.displayName,
      description: normalizeDescription(eventstream.description),
      folderId: normalizeFolderId(eventstream.folderId),
      definitionHash,
    }),
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDefinitionUnavailable(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    error.code === "OperationNotSupportedForItem"
  );
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
): EventstreamOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location =
    response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Eventstream response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function eventstreamCollectionPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/eventstreams`;
}

function eventstreamPath(
  workspaceId: string,
  eventstreamId: string,
): string {
  return `${eventstreamCollectionPath(workspaceId)}/${encodeURIComponent(eventstreamId)}`;
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string {
  return value ?? "";
}
