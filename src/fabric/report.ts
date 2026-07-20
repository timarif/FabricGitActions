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
  assertReportBinding,
  auxiliaryReportParts,
  buildEffectiveReportDefinition,
  hashAuxiliaryReportParts,
  hashReportDefinition,
  reportBindingConnectionString,
  reportDefinitionFormat,
  reportIncludesDiagramLayoutPart,
  reportIncludesPlatformPart,
  reportPlatformLogicalId,
} from "./report-definition";

export interface Report {
  id: string;
  workspaceId?: string;
  type?: "Report";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface ReportDefinitionResponse {
  definition: FabricDefinition;
}

export interface ReportPlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  stagedDefinitionHash?: string;
  managedMetadataMatches?: boolean;
  currentAuxiliaryHash?: string;
}

export interface ReportOperationReference {
  operationId?: string;
  location?: string;
}

interface ReportMatch {
  report: Report;
  definition?: FabricDefinition;
}

export class ReportAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<ReportPlanResult> {
    let match: ReportMatch | undefined;
    try {
      match = await this.findExisting(
        workspaceId,
        desired,
        desiredDefinition,
      );
    } catch (error) {
      if (!isDefinitionUnavailable(error)) {
        throw error;
      }
      const existing = await this.findByDisplayName(
        workspaceId,
        desired,
      );
      return {
        action: "blocked",
        reason: `Report '${desired.displayName}' definition cannot be read. An encrypted sensitivity label or unsupported service state may be blocking getDefinition.`,
        ...(existing ? { physicalId: existing.id } : {}),
        observedStateHash: hashObservedReport(
          existing ?? {
            id: "",
            displayName: desired.displayName,
            folderId: desired.folderId,
          },
          null,
        ),
      };
    }
    if (!match) {
      return {
        action: "create",
        reason: `Report '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, match.report.id);
    let currentDefinition: FabricDefinition;
    try {
      currentDefinition =
        match.definition ??
        (await this.getDefinition(
          workspaceId,
          current.id,
          desiredDefinition,
        ));
    } catch (error) {
      if (!isDefinitionUnavailable(error)) {
        throw error;
      }
      return {
        action: "blocked",
        reason: `Report '${desired.displayName}' definition cannot be read. An encrypted sensitivity label or unsupported service state may be blocking getDefinition.`,
        physicalId: current.id,
        observedStateHash: hashObservedReport(current, null),
      };
    }

    const includePlatform =
      reportIncludesPlatformPart(desiredDefinition);
    const includeDiagramLayout =
      reportIncludesDiagramLayoutPart(desiredDefinition);
    const effectiveDesiredDefinition =
      buildEffectiveReportDefinition(
        desiredDefinition,
        currentDefinition,
      );
    const desiredDefinitionHash = hashReportDefinition(
      effectiveDesiredDefinition,
      includePlatform,
      includeDiagramLayout,
    );
    const currentDefinitionHash = hashReportDefinition(
      currentDefinition,
      includePlatform,
      includeDiagramLayout,
    );
    const currentAuxiliaryHash = hashAuxiliaryReportParts(
      auxiliaryReportParts(currentDefinition),
    );
    const observedStateHash = hashObservedReport(
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
        reason: `Report '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }

    const currentLogicalId =
      reportPlatformLogicalId(currentDefinition);
    const desiredLogicalId =
      reportPlatformLogicalId(desiredDefinition);
    if (
      currentLogicalId !== undefined &&
      desiredLogicalId !== undefined &&
      currentLogicalId !== desiredLogicalId
    ) {
      return {
        action: "blocked",
        reason:
          `Report '${desired.displayName}' .platform logicalId mismatch: ` +
          `current is '${currentLogicalId}', desired is '${desiredLogicalId}'.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }

    if (
      current.displayName !== desired.displayName ||
      !descriptionMatches ||
      currentDefinitionHash !== desiredDefinitionHash
    ) {
      return {
        action: "update",
        reason:
          current.displayName !== desired.displayName ||
          !descriptionMatches
          ? `Report '${desired.displayName}' metadata differs.`
          : `Report '${desired.displayName}' definition or Semantic Model binding differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        currentAuxiliaryHash,
      };
    }
    return {
      action: "no-op",
      reason: `Report '${desired.displayName}' matches the desired definition and Semantic Model binding.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
      currentAuxiliaryHash,
    };
  }

  async planUnresolvedReferences(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    unresolvedLogicalIds: readonly string[],
  ): Promise<ReportPlanResult> {
    let existing: ReportMatch | undefined;
    try {
      existing = await this.findExisting(
        workspaceId,
        desired,
        desiredDefinition,
      );
    } catch (error) {
      if (!isDefinitionUnavailable(error)) {
        throw error;
      }
      const nameMatch = await this.findByDisplayName(
        workspaceId,
        desired,
      );
      return {
        action: "blocked",
        reason: `Report '${desired.displayName}' may already exist, but its definition cannot be read while Semantic Model IDs (${unresolvedLogicalIds.join(
          ", ",
        )}) are unavailable. Apply the dependency and generate a new plan.`,
        ...(nameMatch ? { physicalId: nameMatch.id } : {}),
        observedStateHash: hashObservedReport(
          nameMatch ?? {
            id: "",
            displayName: desired.displayName,
            folderId: desired.folderId,
          },
          null,
        ),
      };
    }
    if (!existing) {
      return {
        action: "create",
        reason: `Report '${desired.displayName}' does not exist; its Semantic Model binding will be materialized after the dependency is created.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }
    return {
      action: "blocked",
      reason: `Report '${desired.displayName}' exists, but Semantic Model ID (${unresolvedLogicalIds.join(
        ", ",
      )}) is unavailable for reviewed definition comparison. Apply the dependency and generate a new plan.`,
      physicalId: existing.report.id,
      observedStateHash: hashObservedReport(
        existing.report,
        null,
      ),
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
    recursive = false,
  ): Promise<Report[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/reports`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", String(recursive));
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<Report>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(workspaceId: string, reportId: string): Promise<Report> {
    const response = await this.client.request<Report>(
      "GET",
      reportPath(workspaceId, reportId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Report response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    reportId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<FabricDefinition> {
    const format = reportDefinitionFormat(desiredDefinition);
    const response =
      await this.client.request<ReportDefinitionResponse>(
        "POST",
        `${reportPath(
          workspaceId,
          reportId,
        )}/getDefinition?format=${encodeURIComponent(format)}`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<ReportDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (
      !result?.definition ||
      !Array.isArray(result.definition.parts)
    ) {
      throw new Error(
        "Fabric Get Report Definition response is invalid.",
      );
    }
    const definition = {
      ...result.definition,
      format: result.definition.format ?? format,
    };
    hashReportDefinition(
      definition,
      reportIncludesPlatformPart(definition),
      reportIncludesDiagramLayoutPart(definition),
    );
    return definition;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: ReportOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<Report> {
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
    let response: FabricResponse<Report>;
    try {
      response = await this.client.request<Report>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/reports`,
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
        "Fabric Create Report response is missing the item ID.",
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
    operation: ReportOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<Report> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<Report>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Report operation result is missing the item ID.",
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
    reportId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<Report> {
    const managesPlatform =
      reportIncludesPlatformPart(definition);
    const includeDiagramLayout =
      reportIncludesDiagramLayoutPart(definition);
    const currentDefinition = await this.getDefinition(
      workspaceId,
      reportId,
      definition,
    );
    const effectiveDefinition = buildEffectiveReportDefinition(
      definition,
      currentDefinition,
    );
    const effectiveAuxiliaryHash = hashAuxiliaryReportParts(
      auxiliaryReportParts(effectiveDefinition),
    );
    const desiredDefinitionHash = hashReportDefinition(
      effectiveDefinition,
      managesPlatform,
      includeDiagramLayout,
    );
    const baselineHash = hashReportDefinition(
      currentDefinition,
      managesPlatform,
      includeDiagramLayout,
    );
    onUpdateCheckpoint?.({
      phase: "metadata-submitting",
      stagedDefinitionHash: baselineHash,
    });

    if (!managesPlatform) {
      const metadataBody: Record<string, unknown> = {
        displayName: desired.displayName,
      };
      if (desired.description !== undefined) {
        metadataBody.description = desired.description;
      }
      try {
        await this.client.request<Report>(
          "PATCH",
          reportPath(workspaceId, reportId),
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
      onUpdateCheckpoint?.({
        phase: "metadata-updated",
        stagedDefinitionHash: baselineHash,
      });
    }

    onUpdateCheckpoint?.({
      phase: "definition-submitting",
      stagedDefinitionHash: baselineHash,
      preservedAuxiliaryHash: effectiveAuxiliaryHash,
    });
    await this.stageDefinition(
      workspaceId,
      reportId,
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
      reportId,
      desired,
      definition,
      effectiveAuxiliaryHash,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    reportId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    expectedAuxiliaryHash?: string,
  ): Promise<Report> {
    const actual = await this.get(workspaceId, reportId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Report verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Report '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Report '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    const actualDefinition = await this.getDefinition(
      workspaceId,
      reportId,
      desiredDefinition,
    );
    const includePlatform =
      reportIncludesPlatformPart(desiredDefinition);
    const includeDiagramLayout =
      reportIncludesDiagramLayoutPart(desiredDefinition);
    const effectiveDesiredDefinition =
      buildEffectiveReportDefinition(
        desiredDefinition,
        actualDefinition,
      );
    if (
      hashReportDefinition(
        actualDefinition,
        includePlatform,
        includeDiagramLayout,
      ) !==
      hashReportDefinition(
        effectiveDesiredDefinition,
        includePlatform,
        includeDiagramLayout,
      )
    ) {
      throw new Error(
        `Report '${desired.displayName}' verification failed for definition content.`,
      );
    }
    assertReportBinding(
      actualDefinition,
      expectedSemanticModelId(desiredDefinition),
    );
    if (
      expectedAuxiliaryHash !== undefined &&
      hashAuxiliaryReportParts(
        auxiliaryReportParts(actualDefinition),
      ) !== expectedAuxiliaryHash
    ) {
      throw new Error(
        `Report '${desired.displayName}' verification failed because auxiliary definition parts were not preserved.`,
      );
    }
    return actual;
  }

  private async stageDefinition(
    workspaceId: string,
    reportId: string,
    definition: FabricDefinition,
    updateMetadata: boolean,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${reportPath(
          workspaceId,
          reportId,
        )}/updateDefinition?updateMetadata=${String(updateMetadata)}`,
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
  ): Promise<ReportMatch | undefined> {
    const nameMatch = await this.findByDisplayName(
      workspaceId,
      desired,
    );
    const desiredLogicalId =
      reportPlatformLogicalId(desiredDefinition);
    if (!desiredLogicalId) {
      return nameMatch ? { report: nameMatch } : undefined;
    }

    let nameMatchDefinition: FabricDefinition | undefined;
    if (nameMatch) {
      nameMatchDefinition = await this.getDefinition(
        workspaceId,
        nameMatch.id,
        desiredDefinition,
      );
      if (
        reportPlatformLogicalId(nameMatchDefinition) ===
        desiredLogicalId
      ) {
        return {
          report: nameMatch,
          definition: nameMatchDefinition,
        };
      }
    }

    const identityMatches: ReportMatch[] = [];
    for (const report of await this.list(
      workspaceId,
      undefined,
      true,
    )) {
      if (report.id === nameMatch?.id) {
        continue;
      }
      const definition = await this.getDefinition(
        workspaceId,
        report.id,
        desiredDefinition,
      );
      if (
        reportPlatformLogicalId(definition) === desiredLogicalId
      ) {
        identityMatches.push({ report, definition });
      }
    }
    if (identityMatches.length > 1) {
      throw new Error(
        `Multiple Reports with .platform logicalId '${desiredLogicalId}' were found.`,
      );
    }
    const identityMatch = identityMatches[0];
    if (identityMatch && nameMatch) {
      throw new Error(
        `Report .platform logicalId '${desiredLogicalId}' resolves to '${identityMatch.report.displayName}', but the desired folder already contains a different Report named '${desired.displayName}'.`,
      );
    }
    return (
      identityMatch ??
      (nameMatch
        ? {
            report: nameMatch,
            definition: nameMatchDefinition,
          }
        : undefined)
    );
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<Report | undefined> {
    const matches = (
      await this.list(workspaceId, desired.folderId)
    ).filter(
      (report) => report.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Reports named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<Report>,
    onOperationAccepted:
      | ((operation: ReportOperationReference) => void)
      | undefined,
  ): Promise<Report> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<Report>(
      response as FabricResponse<unknown>,
    );
  }
}

function expectedSemanticModelId(
  definition: FabricDefinition,
): string {
  const connectionString =
    reportBindingConnectionString(definition);
  const match = /^semanticmodelid=(.+)$/.exec(connectionString);
  if (!match?.[1] || match[1].trim() === "") {
    throw new Error(
      "Materialized Report definition must use exactly 'semanticmodelid=<physicalId>'.",
    );
  }
  return match[1];
}

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
): ReportOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location =
    response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Report response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function reportPath(
  workspaceId: string,
  reportId: string,
): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/reports/${encodeURIComponent(reportId)}`;
}

function hashObservedReport(
  report: Report,
  definitionHash: string | null,
): string {
  return sha256(
    stableJson({
      id: report.id,
      displayName: report.displayName,
      description: normalizeDescription(report.description),
      folderId: report.folderId ?? null,
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
