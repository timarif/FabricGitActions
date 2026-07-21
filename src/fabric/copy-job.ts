/**
 * CopyJobAdapter — discovery, planning, create, update, and read-back
 * verification for Fabric Copy Job items.
 *
 * API base path: /v1/workspaces/{workspaceId}/copyJobs
 *
 * Key constraints confirmed via live API probe (2026-07-20):
 * - CREATE returns 201 (synchronous) or 202 (LRO)
 * - GET, PATCH, DELETE are synchronous (200)
 * - getDefinition is synchronous (200) or LRO (202)
 * - updateDefinition is synchronous (200) or LRO (202)
 * - folderId is supported at creation but NOT in UpdateCopyJobRequest
 * - jobMode is immutable after creation — changing it destroys CDC tracking
 *   state. This adapter blocks jobMode drift; never calls resetCopyJob.
 * - Server strips all fields except properties.jobMode from copyjob-content.json
 *
 * Sources:
 *   microsoft/fabric-rest-api-specs:copyJob/swagger.json
 *   microsoft/fabric-rest-api-specs:copyJob/definitions.json
 */

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
  copyJobIncludesPlatformPart,
  hashCopyJobDefinition,
  hashServerCopyJobDefinition,
  readCopyJobMode,
} from "./copy-job-definition";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CopyJob {
  id: string;
  workspaceId?: string;
  type?: "CopyJob";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface CopyJobDefinitionResponse {
  definition: FabricDefinition;
}

export interface CopyJobPlanResult {
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

export interface CopyJobOperationReference {
  operationId?: string;
  location?: string;
}

// ---------------------------------------------------------------------------
// Internal discovery result type
// ---------------------------------------------------------------------------

type DiscoveryResult =
  | { kind: "notFound" }
  | { kind: "conflict"; otherFolders: string[] }
  | { kind: "found"; item: CopyJob };

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class CopyJobAdapter {
  constructor(private readonly client: FabricClient) {}

  // -------------------------------------------------------------------------
  // Planning
  // -------------------------------------------------------------------------

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<CopyJobPlanResult> {
    const discovery = await this.discoverByDisplayName(
      workspaceId,
      desired,
    );

    if (discovery.kind === "notFound") {
      return {
        action: "create",
        reason: `Copy Job '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    if (discovery.kind === "conflict") {
      return {
        action: "blocked",
        reason:
          `Copy Job '${desired.displayName}' was not found in the target folder ` +
          `'${desired.folderId ?? "(workspace root)"}' ` +
          `but a Copy Job with the same display name exists in: ${discovery.otherFolders.join(", ")}. ` +
          "Creating a new Copy Job would produce an ambiguous identity. " +
          "Relocate the existing Copy Job to the desired folder or rename one of them.",
        observedStateHash: sha256(stableJson(null)),
      };
    }

    // discovery.kind === "found" — discoverByDisplayName already called this.get()
    const current = discovery.item;

    const currentDefinition = await this.getDefinition(
      workspaceId,
      current.id,
    );
    const includePlatform =
      copyJobIncludesPlatformPart(desiredDefinition);
    const desiredDefinitionHash = hashCopyJobDefinition(
      desiredDefinition,
      includePlatform,
    );
    const currentDefinitionHash = hashServerCopyJobDefinition(
      currentDefinition,
      includePlatform,
    );
    const observedStateHash = hashObservedCopyJob(
      current,
      currentDefinitionHash,
    );

    // Defensive: folder was already verified in discoverByDisplayName via the
    // generic Items API.  This guard catches any inconsistency between the
    // generic API and the dedicated GET response.
    const folderMatches =
      normalizeFolderId(current.folderId) ===
      normalizeFolderId(desired.folderId);
    if (!folderMatches) {
      return {
        action: "blocked",
        reason:
          `Copy Job '${desired.displayName}' is in folder '${current.folderId ?? "(workspace root)"}' but the manifest targets '${desired.folderId ?? "(workspace root)"}'. ` +
          "The Fabric API does not support moving Copy Jobs between folders (UpdateCopyJobRequest has no folderId field); " +
          "recreate the Copy Job in the correct folder to resolve this.",
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches: false,
      };
    }

    // --- Immutable field: jobMode ---
    // Switching jobMode destroys CDC tracking state and is data-destructive.
    // Never call resetCopyJob automatically; require explicit recreation.
    const desiredMode = readCopyJobMode(desiredDefinition);
    const currentMode = readCopyJobMode(currentDefinition);
    if (desiredMode !== currentMode) {
      return {
        action: "blocked",
        reason:
          `Copy Job '${desired.displayName}' has jobMode '${currentMode}' but the manifest requests '${desiredMode}'. ` +
          "jobMode is immutable after creation: changing it destroys CDC sync tracking state. " +
          "Recreate the Copy Job with the desired jobMode to resolve this drift.",
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches: false,
      };
    }

    const descriptionMatches =
      desired.description === undefined ||
      normalizeDescription(current.description) ===
        normalizeDescription(desired.description);
    const managedMetadataMatches =
      current.displayName === desired.displayName &&
      descriptionMatches;

    // Definition drift check: only reachable when includePlatform=true and
    // .platform content differs (copyjob-content.json is stable because
    // jobMode equality was already verified above).
    // updateDefinition is NEVER called for existing Copy Jobs — it would
    // overwrite portal-managed activities, connections, and policies with the
    // minimal public schema.  Callers must recreate the item to change
    // .platform content.
    if (currentDefinitionHash !== desiredDefinitionHash) {
      return {
        action: "blocked",
        reason:
          `Copy Job '${desired.displayName}' .platform definition differs from the current service state. ` +
          "Fabric Copy Jobs do not support updateDefinition for existing items: calling it would overwrite " +
          "portal-managed activities, connections, and policies with the minimal public schema. " +
          "To apply .platform changes, recreate the Copy Job.",
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }

    if (!managedMetadataMatches) {
      return {
        action: "update",
        reason: `Copy Job '${desired.displayName}' metadata differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
      };
    }

    return {
      action: "no-op",
      reason: `Copy Job '${desired.displayName}' matches the desired definition.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
    };
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<CopyJob[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/copyJobs`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<CopyJob>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    copyJobId: string,
  ): Promise<CopyJob> {
    const response = await this.client.request<CopyJob>(
      "GET",
      copyJobPath(workspaceId, copyJobId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Copy Job response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    copyJobId: string,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<CopyJobDefinitionResponse>(
        "POST",
        `${copyJobPath(workspaceId, copyJobId)}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<CopyJobDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (
      !result?.definition ||
      !Array.isArray(result.definition.parts)
    ) {
      throw new Error(
        "Fabric Get Copy Job Definition response is invalid.",
      );
    }
    // Validate the returned definition shape: confirm jobMode is present and
    // valid.  Use hashServerCopyJobDefinition so that portal-managed fields
    // (activities, properties.source/destination/policy) in the service
    // response do not cause a spurious validation error.
    hashServerCopyJobDefinition(
      result.definition,
      copyJobIncludesPlatformPart(result.definition),
    );
    return result.definition;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: CopyJobOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<CopyJob> {
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
    let response: FabricResponse<CopyJob>;
    try {
      response = await this.client.request<CopyJob>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/copyJobs`,
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
        "Fabric Create Copy Job response is missing the item ID.",
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
    operation: CopyJobOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<CopyJob> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<CopyJob>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Copy Job operation result is missing the item ID.",
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
    copyJobId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<CopyJob> {
    // Copy Jobs are ALWAYS PATCH-only for existing items — regardless of
    // whether the desired definition includes .platform.
    //
    // Calling updateDefinition on an existing Copy Job would replace the
    // entire portal-managed definition (activities, connections, policies)
    // with only `properties.jobMode`, destroying user configuration.
    //
    // .platform definition drift is blocked at plan() time; update() is only
    // reached for metadata drift (displayName / description).  The bare
    // checkpoint below records pre-PATCH intent without a phase field so that
    // hasCopyJobRecoveryProof can detect an interrupted PATCH via the
    // managedMetadataMatches + stagedDefinitionHash stable-hash proof
    // (branch 2) on the next attempt.
    onUpdateCheckpoint?.();
    const metadataBody: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      metadataBody.description = desired.description;
    }
    try {
      await this.client.request<CopyJob>(
        "PATCH",
        copyJobPath(workspaceId, copyJobId),
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
    const verified = await this.verify(
      workspaceId,
      copyJobId,
      desired,
      definition,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    copyJobId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<CopyJob> {
    const actual = await this.get(workspaceId, copyJobId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Copy Job verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Copy Job '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Copy Job '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      copyJobId,
    );
    const includePlatform =
      copyJobIncludesPlatformPart(desiredDefinition);
    if (
      hashServerCopyJobDefinition(actualDefinition, includePlatform) !==
      hashCopyJobDefinition(desiredDefinition, includePlatform)
    ) {
      throw new Error(
        `Copy Job '${desired.displayName}' verification failed for definition content.`,
      );
    }
    return actual;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Discovers a Copy Job by display name and desired folder using the generic
   * `/items?type=CopyJob` endpoint, which includes `folderId` in each
   * response item.  The dedicated `/copyJobs` endpoint omits `folderId`, so
   * it cannot be used for workspace-wide identity checks.
   *
   * Returns:
   *  - `{ kind: "notFound" }` — no Copy Job with this name exists in the workspace.
   *  - `{ kind: "found"; item }` — exactly one Copy Job with this name exists
   *    in the target folder.
   *  - `{ kind: "conflict"; otherFolders }` — a Copy Job with this name exists
   *    but in a different folder; creating would produce an ambiguous identity.
   */
  private async discoverByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<DiscoveryResult> {
    const allItems = await this.client.listAll<{
      id: string;
      displayName: string;
      folderId?: string;
    }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/items?type=CopyJob`,
    );

    const targetFolder = normalizeFolderId(desired.folderId);
    const sameNameItems = allItems.filter(
      (i) => i.displayName === desired.displayName,
    );
    const inTargetFolder = sameNameItems.filter(
      (i) => normalizeFolderId(i.folderId) === targetFolder,
    );

    if (inTargetFolder.length > 1) {
      throw new Error(
        `Multiple Copy Jobs named '${desired.displayName}' were found in the target folder. ` +
          "Each Copy Job must have a unique display name within its folder.",
      );
    }

    if (inTargetFolder.length === 1) {
      const found = inTargetFolder[0];
      if (!found) {
        throw new Error("Unexpected: inTargetFolder[0] is undefined after length check.");
      }
      const job = await this.get(workspaceId, found.id);
      return { kind: "found", item: job };
    }

    const elsewhere = sameNameItems.filter(
      (i) => normalizeFolderId(i.folderId) !== targetFolder,
    );
    if (elsewhere.length > 0) {
      return {
        kind: "conflict",
        otherFolders: [
          ...new Set(
            elsewhere.map((i) => i.folderId ?? "(workspace root)"),
          ),
        ],
      };
    }

    return { kind: "notFound" };
  }

  private async waitForCreateOperation(
    response: FabricResponse<CopyJob>,
    onOperationAccepted:
      | ((operation: CopyJobOperationReference) => void)
      | undefined,
  ): Promise<CopyJob> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<CopyJob>(
      response as FabricResponse<unknown>,
    );
  }
}

// ---------------------------------------------------------------------------
// Module helpers
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
): CopyJobOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Copy Job response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function copyJobPath(
  workspaceId: string,
  copyJobId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/copyJobs/${encodeURIComponent(copyJobId)}`;
}

function hashObservedCopyJob(
  job: CopyJob,
  definitionHash: string,
): string {
  return sha256(
    stableJson({
      id: job.id,
      displayName: job.displayName,
      description: normalizeDescription(job.description),
      folderId: job.folderId ?? null,
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
