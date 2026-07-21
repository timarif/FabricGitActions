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
  buildDataAgentCurrentHash,
  buildEffectiveDataAgentDefinition,
  dataAgentHasDefinition,
  hashDataAgentDefinition,
  isUntouchedDataAgentShellDefinition,
  validateDataAgentDefinitionResponse,
} from "./data-agent-definition";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DataAgent {
  id: string;
  workspaceId?: string;
  type?: "DataAgent";
  displayName: string;
  description?: string;
  folderId?: string;
  properties?: Record<string, unknown>;
}

export interface DataAgentDefinitionResponse {
  definition: FabricDefinition;
}

export interface DataAgentPlanResult {
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

export interface DataAgentOperationReference {
  operationId?: string;
  location?: string;
  /** Sync 201 proof: physical item ID obtained synchronously */
  physicalId?: string;
  /** Sync 201 proof: hash of the server's shell definition immediately after creation */
  shellDefinitionHash?: string;
}

interface DataAgentMatch {
  dataAgent: DataAgent;
  definition?: FabricDefinition;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class DataAgentAdapter {
  constructor(private readonly client: FabricClient) {}

  // -------------------------------------------------------------------------
  // plan
  // -------------------------------------------------------------------------

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition | undefined,
  ): Promise<DataAgentPlanResult> {
    const match = await this.findExisting(workspaceId, desired);
    if (!match) {
      return {
        action: "create",
        reason: `Data Agent '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const existing = match.dataAgent;
    const current = await this.get(workspaceId, existing.id);

    // Evaluate folder first — if it differs the item is permanently blocked
    // and we don't need to fetch the definition at all.
    const folderMatches =
      normalizeFolderId(current.folderId) ===
      normalizeFolderId(desired.folderId);

    if (!folderMatches) {
      const observedStateHashBlocked = hashObservedDataAgent(
        current,
        sha256(stableJson(null)), // definition not fetched
      );
      return {
        action: "blocked",
        reason: `Data Agent '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash: observedStateHashBlocked,
        managedMetadataMatches: false,
      };
    }

    // Fetch current definition only when needed for hash comparison
    let currentDefinition: FabricDefinition | undefined;
    if (match.definition !== undefined) {
      currentDefinition = match.definition;
    } else if (desiredDefinition !== undefined) {
      // Only fetch if we have a desired definition to compare against
      try {
        currentDefinition = await this.getDefinition(workspaceId, existing.id);
      } catch (err) {
        if (err instanceof FabricApiError && err.status === 404) {
          // Item was deleted between list() and getDefinition() — treat as absent.
          currentDefinition = undefined;
        } else if (
          err instanceof FabricApiError &&
          err.status === 400 &&
          (err.code === "OperationNotSupportedForItem" ||
            err.code === "ItemHasSensitivityLabelBlockingOperation")
        ) {
          // The item is present but its definition cannot be accessed (e.g.,
          // encrypted sensitivity label, item type mismatch). Return blocked
          // so the caller doesn't attempt to overwrite the item.
          const observedStateHashBlocked = hashObservedDataAgent(
            current,
            sha256(stableJson(null)),
          );
          return {
            action: "blocked",
            reason: `Data Agent '${desired.displayName}' definition cannot be accessed: ${err.code}.`,
            physicalId: current.id,
            observedStateHash: observedStateHashBlocked,
            managedMetadataMatches: false,
          };
        } else {
          throw err;
        }
      }
    }

    const desiredDefinitionHash = desiredDefinition
      ? hashDataAgentDefinition(desiredDefinition)
      : sha256(stableJson(null));

    // Compare the current server state against the desired definition.
    // buildDataAgentCurrentHash includes current-only user-authored parts
    // (so removing a datasource is detected as drift) but excludes
    // server-generated defaults (blank stage_config) when the user did not
    // provide them, preventing perpetual update for shell-derived agents.
    const currentDefinitionHashForComparison = currentDefinition
      ? buildDataAgentCurrentHash(currentDefinition, desiredDefinition)
      : sha256(stableJson(null));

    // Full authored hash for the observedStateHash (reflects actual server state).
    const currentDefinitionFullHash = currentDefinition
      ? hashDataAgentDefinition(currentDefinition)
      : sha256(stableJson(null));

    const observedStateHash = hashObservedDataAgent(
      current,
      currentDefinitionFullHash,
    );
    const descriptionMatches =
      desired.description === undefined ||
      normalizeDescription(current.description) ===
        normalizeDescription(desired.description);
    const managedMetadataMatches =
      current.displayName === desired.displayName && descriptionMatches;

    if (
      !descriptionMatches ||
      currentDefinitionHashForComparison !== desiredDefinitionHash
    ) {
      return {
        action: "update",
        reason: !descriptionMatches
          ? `Data Agent '${desired.displayName}' metadata differs.`
          : `Data Agent '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionFullHash,
        managedMetadataMatches,
      };
    }

    return {
      action: "no-op",
      reason: `Data Agent '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionFullHash,
      managedMetadataMatches,
    };
  }

  // -------------------------------------------------------------------------
  // list / get
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    folderId?: string,
    recursive = false,
  ): Promise<DataAgent[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/dataAgents`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", String(recursive));
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<DataAgent>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    dataAgentId: string,
  ): Promise<DataAgent> {
    const response = await this.client.request<DataAgent>(
      "GET",
      dataAgentPath(workspaceId, dataAgentId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Data Agent response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    dataAgentId: string,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<DataAgentDefinitionResponse>(
        "POST",
        `${dataAgentPath(workspaceId, dataAgentId)}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<DataAgentDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error(
        "Fabric Get Data Agent Definition response is invalid.",
      );
    }
    validateDataAgentDefinitionResponse(result.definition);
    return result.definition;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition | undefined,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: DataAgentOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<DataAgent> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }

    let response: FabricResponse<DataAgent>;
    try {
      response = await this.client.request<DataAgent>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/dataAgents`,
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
        "Fabric Create Data Agent response is missing the item ID.",
      );
    }

    // For the synchronous 201 path: fetch the shell definition and record a
    // physicalId+shellDefinitionHash proof via onOperationAccepted BEFORE we
    // stage the user's definition. This allows crash-safe recovery without
    // polling a non-existent LRO.
    // Note: if getDefinition throws here, create() propagates the error, leaving
    // pendingCreates in place (fail-closed — recovery will refuse without proof).
    if (response.status !== 202 && onOperationAccepted) {
      const shellDef = await this.getDefinition(workspaceId, created.id);
      const shellDefinitionHash = hashDataAgentDefinition(shellDef);
      onOperationAccepted({
        physicalId: created.id,
        shellDefinitionHash,
      });
    }

    // Stage the definition after shell create.
    // Shell create always returns 201 (sync) so the item ID is immediately
    // available. Sending definition in the create body would return 202 (LRO),
    // making the create non-atomic and complicating recovery. Staging after
    // create is the safe pattern: the shell is checkpointed in pendingCreates,
    // and reconcilePendingCreates handles recovery if a crash occurs between
    // the shell create and definition staging.
    if (definition !== undefined) {
      const effectiveDef = buildEffectiveDataAgentDefinition(definition);
      await this.stageDefinition(
        workspaceId,
        created.id,
        effectiveDef,
        onCreateRejected,
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

  // -------------------------------------------------------------------------
  // resumeCreate
  // -------------------------------------------------------------------------

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition | undefined,
    operation: DataAgentOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<DataAgent> {
    let itemId: string;

    if (
      operation.physicalId &&
      operation.shellDefinitionHash &&
      !operation.operationId &&
      !operation.location
    ) {
      // ── Sync 201 shell-create proof path ────────────────────────────────
      // The create returned 201 synchronously; we have the exact physicalId.
      // Verify identity and external drift before staging the definition.
      const item = await this.get(workspaceId, operation.physicalId);
      if (
        item.displayName !== desired.displayName ||
        normalizeFolderId(item.folderId) !==
          normalizeFolderId(desired.folderId) ||
        (item.type !== undefined && item.type !== "DataAgent")
      ) {
        throw new Error(
          `Data Agent create recovery: physical item '${operation.physicalId}' no longer ` +
            `matches approved identity (displayName='${item.displayName}', ` +
            `folderId='${item.folderId ?? "none"}'). Failing closed.`,
        );
      }
      const currentShellDef = await this.getDefinition(
        workspaceId,
        operation.physicalId,
      );
      const currentShellHash = hashDataAgentDefinition(currentShellDef);
      if (currentShellHash !== operation.shellDefinitionHash) {
        throw new Error(
          `Data Agent create recovery: shell definition was externally modified after ` +
            `checkpoint (expected hash ${operation.shellDefinitionHash.slice(0, 12)}…, ` +
            `got ${currentShellHash.slice(0, 12)}…). Failing closed to avoid overwriting changes.`,
        );
      }
      itemId = operation.physicalId;
    } else if (operation.operationId || operation.location) {
      // ── Async 202 LRO path ───────────────────────────────────────────────
      const headers = new Headers();
      if (operation.operationId) {
        headers.set("x-ms-operation-id", operation.operationId);
      }
      if (operation.location) {
        headers.set("location", operation.location);
      }
      const created = await this.client.waitForOperation<DataAgent>({
        status: 202,
        headers,
        body: undefined,
      });
      if (!created?.id) {
        throw new Error(
          "Fabric Create Data Agent operation result is missing the item ID.",
        );
      }
      itemId = created.id;
      // ── LRO identity verification ────────────────────────────────────────
      // Guard against a stale/corrupted LRO result pointing to the wrong agent.
      const lroItem = await this.get(workspaceId, itemId);
      if (
        lroItem.displayName !== desired.displayName ||
        normalizeFolderId(lroItem.folderId) !==
          normalizeFolderId(desired.folderId) ||
        (lroItem.type !== undefined && lroItem.type !== "DataAgent")
      ) {
        throw new Error(
          `Data Agent create recovery (LRO): operation result item '${itemId}' ` +
            `does not match approved identity ` +
            `(want displayName='${desired.displayName}', folderId='${normalizeFolderId(desired.folderId)}'; ` +
            `got displayName='${lroItem.displayName}', ` +
            `folderId='${lroItem.folderId ?? "none"}', ` +
            `type='${lroItem.type ?? "none"}'). Failing closed.`,
        );
      }
      // ── LRO shell content proof ──────────────────────────────────────────
      // When staging a definition, verify the live definition is still the
      // untouched server default.  This is the LRO equivalent of the sync
      // path's shellDefinitionHash: any external modification (added datasource,
      // changed aiInstructions, etc.) causes recovery to fail closed.
      // Skip when no definition is being staged (shell-only resume).
      if (definition !== undefined) {
        const currentShellDef = await this.getDefinition(workspaceId, itemId);
        if (!isUntouchedDataAgentShellDefinition(currentShellDef)) {
            throw new Error(
              `Data Agent create recovery (LRO): item '${itemId}' definition ` +
                `has been externally modified after creation and no longer ` +
                `matches the expected untouched shell state. ` +
                `Failing closed to avoid overwriting external changes.`,
            );
        }
      }
    } else {
      throw new Error(
        `Data Agent create recovery: no operation reference or sync proof available ` +
          `for '${desired.displayName}'. Failing closed — manual cleanup and retry required.`,
      );
    }

    // Stage the definition if one was requested (for both sync and LRO paths).
    if (definition !== undefined) {
      const effectiveDef = buildEffectiveDataAgentDefinition(definition);
      const desiredHash = hashDataAgentDefinition(effectiveDef);
      const baseline = sha256(stableJson(null));
      await this.stageDefinition(
        workspaceId,
        itemId,
        effectiveDef,
        onUpdateRejected,
        onUpdateCheckpoint
          ? () =>
              onUpdateCheckpoint({
                phase: "definition-submitting",
                stagedDefinitionHash: baseline,
              })
          : undefined,
      );
      onUpdateCheckpoint?.({
        phase: "definition-staged",
        stagedDefinitionHash: desiredHash,
      });
    }

    const verified = await this.verify(
      workspaceId,
      itemId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(
    workspaceId: string,
    dataAgentId: string,
    desired: ItemDefinition,
    definition: FabricDefinition | undefined,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<DataAgent> {
    // Fetch the current definition hash for checkpoint baseline
    let currentDefinitionHash: string;
    if (definition !== undefined) {
      try {
        const currentDef = await this.getDefinition(workspaceId, dataAgentId);
        currentDefinitionHash = hashDataAgentDefinition(currentDef);
      } catch (err) {
        if (err instanceof FabricApiError && err.status === 404) {
          // Item was deleted between plan() and update() — baseline is null.
          currentDefinitionHash = sha256(stableJson(null));
        } else {
          // Propagate all other errors, including 400 OperationNotSupportedForItem
          // and sensitivity-label blocks. Callers must treat these as unrecoverable.
          throw err;
        }
      }
    } else {
      currentDefinitionHash = sha256(stableJson(null));
    }

    const recoveryBaseline = onUpdateCheckpoint
      ? { stagedDefinitionHash: currentDefinitionHash }
      : undefined;

    // Always PATCH metadata (displayName + optional description)
    const metadataBody: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      metadataBody.description = desired.description;
    }
    try {
      await this.client.request<DataAgent>(
        "PATCH",
        dataAgentPath(workspaceId, dataAgentId),
        {
          body: metadataBody,
          retryable: false,
          acceptedStatuses: [200],
          onDispatch: recoveryBaseline
            ? () =>
                onUpdateCheckpoint?.({
                  phase: "metadata-submitting",
                  ...recoveryBaseline,
                })
            : undefined,
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

    // Update definition if one is provided
    if (definition !== undefined) {
      const effectiveDef = buildEffectiveDataAgentDefinition(definition);
      const desiredDefinitionHash = hashDataAgentDefinition(effectiveDef);

      await this.stageDefinition(
        workspaceId,
        dataAgentId,
        effectiveDef,
        onUpdateRejected,
        recoveryBaseline
          ? () =>
              onUpdateCheckpoint?.({
                phase: "definition-submitting",
                stagedDefinitionHash:
                  recoveryBaseline.stagedDefinitionHash,
              })
          : undefined,
      );

      onUpdateCheckpoint?.({
        phase: "definition-staged",
        stagedDefinitionHash: desiredDefinitionHash,
      });
    }

    const verified = await this.verify(
      workspaceId,
      dataAgentId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  // -------------------------------------------------------------------------
  // verify
  // -------------------------------------------------------------------------

  async verify(
    workspaceId: string,
    dataAgentId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition | undefined,
  ): Promise<DataAgent> {
    const actual = await this.get(workspaceId, dataAgentId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Data Agent verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Data Agent '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Data Agent '${desired.displayName}' verification failed for folder placement.`,
      );
    }

    // Verify definition when one was provided.
    // Use buildDataAgentCurrentHash: check both the user-authored paths AND
    // any current-only user-authored parts. Service-generated defaults
    // (blank stage_config) are excluded so they don't fail verification
    // when the user did not provide them.
    if (desiredDefinition !== undefined) {
      let actualDefinition: FabricDefinition | undefined;
      try {
        actualDefinition = await this.getDefinition(workspaceId, dataAgentId);
      } catch (err) {
        throw new Error(
          `Data Agent '${desired.displayName}' verification failed: could not retrieve definition after update.`,
        );
      }
      const desiredHash = hashDataAgentDefinition(desiredDefinition);
      const actualHash = buildDataAgentCurrentHash(
        actualDefinition,
        desiredDefinition,
      );
      if (actualHash !== desiredHash) {
        throw new Error(
          `Data Agent '${desired.displayName}' verification failed: definition content does not match after update.`,
        );
      }
    }

    return actual;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async stageDefinition(
    workspaceId: string,
    dataAgentId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
    onDispatch?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${dataAgentPath(workspaceId, dataAgentId)}/updateDefinition`,
        {
          body: { definition },
          retryable: false,
          acceptedStatuses: [200, 202],
          onDispatch,
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
  ): Promise<DataAgentMatch | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter((da) => da.displayName === desired.displayName);

    if (matches.length > 1) {
      throw new Error(
        `Multiple Data Agents named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0] ? { dataAgent: matches[0] } : undefined;
  }

  private async waitForCreateOperation(
    response: FabricResponse<DataAgent>,
    onOperationAccepted:
      | ((operation: DataAgentOperationReference) => void)
      | undefined,
  ): Promise<DataAgent> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<DataAgent>(
      response as FabricResponse<unknown>,
    );
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

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
): DataAgentOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Data Agent response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function dataAgentPath(
  workspaceId: string,
  dataAgentId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/dataAgents/${encodeURIComponent(dataAgentId)}`;
}

function hashObservedDataAgent(
  dataAgent: DataAgent,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: dataAgent.id,
      displayName: dataAgent.displayName,
      description: normalizeDescription(dataAgent.description),
      folderId: dataAgent.folderId ?? null,
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
