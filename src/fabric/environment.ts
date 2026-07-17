import type {
  ApplyCheckpointUpdateIntent,
  ItemDefinition,
  PlannedAction,
} from "../types";
import { sha256, stableJson } from "../hash";
import { parse as parseYaml } from "yaml";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";
import {
  canonicalYaml,
  FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
  getEmbeddedFabricDeploymentMarker,
  getFabricDeploymentMarker,
  hashFabricDefinition,
  includesPlatformPart,
  includesSparkComputePart,
  type FabricDefinition,
  withFabricDeploymentMarker,
} from "./definition";

export interface Environment {
  id: string;
  workspaceId?: string;
  type?: "Environment";
  displayName: string;
  description?: string;
  folderId?: string;
  properties?: EnvironmentProperties;
}

export interface EnvironmentProperties {
  publishDetails?: {
    state?: string;
    targetVersion?: string;
  };
}

export interface EnvironmentDefinitionResponse {
  definition: FabricDefinition;
}

export interface EnvironmentPlanResult {
  action: Extract<PlannedAction, "create" | "update" | "no-op" | "blocked">;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  stagedDeploymentMarker?: string;
  stagedDefinitionHash?: string;
  managedMetadataMatches?: boolean;
  publishState?: string;
  targetVersion?: string;
}

export interface EnvironmentOperationReference {
  operationId?: string;
  location?: string;
}

export interface EnvironmentUpdateRecoveryState {
  phase: NonNullable<ApplyCheckpointUpdateIntent["phase"]>;
  stagedDefinitionHash: string;
  stagedDeploymentMarker?: string;
  publishState?: string;
  targetVersion?: string;
}

export interface EnvironmentAdapterOptions {
  publishTimeoutMs?: number;
  publishPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

interface PublishedSparkCompute {
  sparkProperties?: unknown;
  [key: string]: unknown;
}

interface PublishedDefinitionState {
  matches: boolean;
  observedHash: string;
}

export class EnvironmentAdapter {
  private readonly publishTimeoutMs: number;
  private readonly publishPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: FabricClient,
    options: EnvironmentAdapterOptions = {},
  ) {
    this.publishTimeoutMs = options.publishTimeoutMs ?? 30 * 60 * 1000;
    this.publishPollIntervalMs = options.publishPollIntervalMs ?? 5000;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.now = options.now ?? Date.now;
  }

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
  ): Promise<EnvironmentPlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Environment '${desired.displayName}' does not exist.`,
        observedStateHash: sha256(stableJson(null)),
      };
    }

    const current = await this.get(workspaceId, existing.id);
    const currentDefinition = await this.getDefinition(
      workspaceId,
      existing.id,
    );
    const stagedDeploymentMarker =
      getEmbeddedFabricDeploymentMarker(currentDefinition);
    const includePlatform = includesPlatformPart(desiredDefinition);
    const includeSparkCompute =
      includesSparkComputePart(desiredDefinition);
    const desiredDefinitionHash = hashFabricDefinition(
      desiredDefinition,
      includePlatform,
    );
    const currentDefinitionHash = hashFabricDefinition(
      currentDefinition,
      includePlatform,
      includeSparkCompute,
    );
    let observedStateHash = hashObservedEnvironment(
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
    const publishState = current.properties?.publishDetails?.state;
    const targetVersion =
      current.properties?.publishDetails?.targetVersion;
    const recoveryState = {
      ...(publishState ? { publishState } : {}),
      ...(targetVersion ? { targetVersion } : {}),
    };

    if (!folderMatches) {
      return {
        action: "blocked",
        reason: `Environment '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        ...(stagedDeploymentMarker
          ? { stagedDeploymentMarker }
          : {}),
      };
    }

    if (isPublishInProgress(publishState)) {
      return {
        action: "blocked",
        reason: `Environment '${desired.displayName}' has a publish operation in state '${publishState}'.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        ...(stagedDeploymentMarker
          ? { stagedDeploymentMarker }
          : {}),
      };
    }

    const descriptionChanged = !descriptionMatches;
    if (descriptionChanged || currentDefinitionHash !== desiredDefinitionHash) {
      return {
        action: "update",
        reason: descriptionChanged
          ? `Environment '${desired.displayName}' metadata differs.`
          : `Environment '${desired.displayName}' definition differs.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        ...(stagedDeploymentMarker
          ? { stagedDeploymentMarker }
          : {}),
      };
    }

    if (stagedDeploymentMarker !== undefined) {
      return {
        action: "update",
        reason: `Environment '${desired.displayName}' has an incomplete deployment-marker cleanup.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        stagedDeploymentMarker,
      };
    }

    if (publishState !== "Success") {
      return {
        action: "update",
        reason: `Environment '${desired.displayName}' requires a successful publish.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        ...(stagedDeploymentMarker
          ? { stagedDeploymentMarker }
          : {}),
      };
    }

    const publishedState = await this.getPublishedDefinitionState(
      workspaceId,
      current.id,
      desiredDefinition,
    );
    observedStateHash = hashObservedEnvironment(
      current,
      currentDefinitionHash,
      publishedState.observedHash,
    );
    if (!publishedState.matches) {
      return {
        action: "update",
        reason: `Environment '${desired.displayName}' has staged definition changes that are not published.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        ...recoveryState,
        ...(stagedDeploymentMarker
          ? { stagedDeploymentMarker }
          : {}),
      };
    }

    return {
      action: "no-op",
      reason: `Environment '${desired.displayName}' matches the desired definition and is published.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
      ...recoveryState,
      ...(stagedDeploymentMarker
        ? { stagedDeploymentMarker }
        : {}),
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<Environment[]> {
    const url = new URL(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/environments`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<Environment>(`${url.pathname}${url.search}`);
  }

  async get(
    workspaceId: string,
    environmentId: string,
  ): Promise<Environment> {
    const response = await this.client.request<Environment>(
      "GET",
      environmentPath(workspaceId, environmentId),
    );
    if (!response.body) {
      throw new Error("Fabric Get Environment response is empty.");
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    environmentId: string,
  ): Promise<FabricDefinition> {
    const response = await this.client.request<EnvironmentDefinitionResponse>(
      "POST",
      `${environmentPath(workspaceId, environmentId)}/getDefinition`,
      {
        retryable: true,
        acceptedStatuses: [200, 202],
      },
    );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<EnvironmentDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error("Fabric Get Environment Definition response is invalid.");
    }
    return result.definition;
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (
      physicalId: string,
      targetVersion?: string,
    ) => void,
    onOperationAccepted?: (operation: EnvironmentOperationReference) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<Environment> {
    const deploymentDefinition = withFabricDeploymentMarker(definition);
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
      definition: deploymentDefinition,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }
    onCreateSubmitting?.();
    let response: FabricResponse<Environment>;
    try {
      response = await this.client.request<Environment>(
        "POST",
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/environments`,
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
      throw new Error("Fabric Create Environment response is missing the item ID.");
    }
    const published = await this.publish(workspaceId, created.id);
    await this.verifyPublishedDeployment(
      workspaceId,
      created.id,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    await this.cleanupDeploymentMarker(
      workspaceId,
      created.id,
      definition,
    );
    const verified = await this.verify(
      workspaceId,
      created.id,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    onMutationAccepted?.(
      verified.id,
      verified.properties?.publishDetails?.targetVersion,
    );
    return verified;
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    operation: EnvironmentOperationReference,
    onMutationAccepted?: (
      physicalId: string,
      targetVersion?: string,
    ) => void,
  ): Promise<Environment> {
    const headers = new Headers();
    if (operation.operationId) {
      headers.set("x-ms-operation-id", operation.operationId);
    }
    if (operation.location) {
      headers.set("location", operation.location);
    }
    const created = await this.client.waitForOperation<Environment>({
      status: 202,
      headers,
      body: undefined,
    });
    if (!created?.id) {
      throw new Error(
        "Fabric Create Environment operation result is missing the item ID.",
      );
    }
    const live = await this.plan(workspaceId, desired, definition);
    if (live.physicalId && live.physicalId !== created.id) {
      throw new Error(
        `Fabric Create Environment operation returned '${created.id}', but discovery found '${live.physicalId}'.`,
      );
    }
    if (live.action === "no-op") {
      const verified = await this.verify(
        workspaceId,
        created.id,
        desired,
        definition,
        live.targetVersion,
      );
      onMutationAccepted?.(
        verified.id,
        verified.properties?.publishDetails?.targetVersion,
      );
      return verified;
    }
    if (live.action === "blocked") {
      throw new Error(
        `Environment create recovery is blocked: ${live.reason}`,
      );
    }
    const expectedMarker = getFabricDeploymentMarker(definition);
    const expectedDefinitionHash = hashFabricDefinition(
      definition,
      includesPlatformPart(definition),
    );
    if (
      live.managedMetadataMatches !== true ||
      live.stagedDefinitionHash !== expectedDefinitionHash
    ) {
      throw new Error(
        "Environment create recovery found unapproved metadata or staging drift.",
      );
    }
    if (
      expectedMarker !== undefined &&
      live.stagedDeploymentMarker === undefined
    ) {
      throw new Error(
        "Environment create recovery found marker-cleaned staging whose published state is not yet verifiable. Retry after Fabric state converges.",
      );
    }
    if (live.stagedDeploymentMarker !== expectedMarker) {
      throw new Error(
        "Environment create recovery found an unexpected deployment marker.",
      );
    }
    if (expectedMarker && live.publishState === "Success") {
      const publishedState = await this.getPublishedDefinitionState(
        workspaceId,
        created.id,
        definition,
      );
      if (publishedState.matches) {
        await this.cleanupDeploymentMarker(
          workspaceId,
          created.id,
          definition,
        );
        const verified = await this.verify(
          workspaceId,
          created.id,
          desired,
          definition,
          live.targetVersion,
        );
        onMutationAccepted?.(
          verified.id,
          verified.properties?.publishDetails?.targetVersion,
        );
        return verified;
      }
    }
    const published = await this.publish(workspaceId, created.id);
    await this.verifyPublishedDeployment(
      workspaceId,
      created.id,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    await this.cleanupDeploymentMarker(
      workspaceId,
      created.id,
      definition,
    );
    const verified = await this.verify(
      workspaceId,
      created.id,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    onMutationAccepted?.(
      verified.id,
      verified.properties?.publishDetails?.targetVersion,
    );
    return verified;
  }

  async update(
    workspaceId: string,
    environmentId: string,
    desired: ItemDefinition,
    definition: FabricDefinition,
    onMutationAccepted?: (
      physicalId: string,
      targetVersion?: string,
    ) => void,
    onUpdateCheckpoint?: (
      state?: EnvironmentUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<Environment> {
    const metadataBody: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      metadataBody.description = desired.description;
    }
    const recoveryBaseline = onUpdateCheckpoint
      ? await this.getUpdateRecoveryState(
          workspaceId,
          environmentId,
          definition,
        )
      : undefined;
    if (recoveryBaseline) {
      onUpdateCheckpoint?.({
        phase: "metadata-submitting",
        ...recoveryBaseline,
      });
    } else {
      onUpdateCheckpoint?.();
    }
    try {
      await this.client.request<Environment>(
        "PATCH",
        environmentPath(workspaceId, environmentId),
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

    const deploymentMarker = getFabricDeploymentMarker(definition);
    const deploymentDefinition = withFabricDeploymentMarker(definition);
    await this.stageDefinition(
      workspaceId,
      environmentId,
      deploymentDefinition,
    );
    const desiredDefinitionHash = hashFabricDefinition(
      definition,
      includesPlatformPart(definition),
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: desiredDefinitionHash,
      ...(deploymentMarker
        ? { stagedDeploymentMarker: deploymentMarker }
        : {}),
      ...(recoveryBaseline?.publishState
        ? { publishState: recoveryBaseline.publishState }
        : {}),
      ...(recoveryBaseline?.targetVersion
        ? { targetVersion: recoveryBaseline.targetVersion }
        : {}),
    });
    const published = await this.publish(workspaceId, environmentId);
    await this.verifyPublishedDeployment(
      workspaceId,
      environmentId,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    onUpdateCheckpoint?.({
      phase: "published",
      stagedDefinitionHash: desiredDefinitionHash,
      ...(deploymentMarker
        ? { stagedDeploymentMarker: deploymentMarker }
        : {}),
      publishState:
        published.properties?.publishDetails?.state ?? "Success",
      ...(published.properties?.publishDetails?.targetVersion
        ? {
            targetVersion:
              published.properties.publishDetails.targetVersion,
          }
        : {}),
    });
    await this.cleanupDeploymentMarker(
      workspaceId,
      environmentId,
      definition,
    );
    onUpdateCheckpoint?.({
      phase: "marker-cleaned",
      stagedDefinitionHash: desiredDefinitionHash,
      publishState:
        published.properties?.publishDetails?.state ?? "Success",
      ...(published.properties?.publishDetails?.targetVersion
        ? {
            targetVersion:
              published.properties.publishDetails.targetVersion,
          }
        : {}),
    });
    const verified = await this.verify(
      workspaceId,
      environmentId,
      desired,
      definition,
      published.properties?.publishDetails?.targetVersion,
    );
    onMutationAccepted?.(
      verified.id,
      verified.properties?.publishDetails?.targetVersion,
    );
    return verified;
  }

  async publish(
    workspaceId: string,
    environmentId: string,
  ): Promise<Environment> {
    const beforePublish = await this.get(workspaceId, environmentId);
    const previousTargetVersion =
      beforePublish.properties?.publishDetails?.targetVersion;
    const response = await this.client.request<EnvironmentProperties>(
      "POST",
      `${environmentPath(
        workspaceId,
        environmentId,
      )}/staging/publish?beta=false`,
      {
        retryable: false,
        acceptedStatuses: [200, 202],
      },
    );
    await this.client.waitForOperationCompletion(
      response as FabricResponse<unknown>,
    );
    return this.waitForPublish(
      workspaceId,
      environmentId,
      previousTargetVersion,
      response.body?.publishDetails?.targetVersion,
    );
  }

  async verify(
    workspaceId: string,
    environmentId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    expectedTargetVersion?: string,
  ): Promise<Environment> {
    return this.verifyDeploymentState(
      workspaceId,
      environmentId,
      desired,
      desiredDefinition,
      expectedTargetVersion,
      undefined,
    );
  }

  private async verifyPublishedDeployment(
    workspaceId: string,
    environmentId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    expectedTargetVersion?: string,
  ): Promise<Environment> {
    return this.verifyDeploymentState(
      workspaceId,
      environmentId,
      desired,
      desiredDefinition,
      expectedTargetVersion,
      getFabricDeploymentMarker(desiredDefinition),
    );
  }

  private async verifyDeploymentState(
    workspaceId: string,
    environmentId: string,
    desired: ItemDefinition,
    desiredDefinition: FabricDefinition,
    expectedTargetVersion: string | undefined,
    expectedStagedMarker: string | undefined,
  ): Promise<Environment> {
    const actual = await this.get(workspaceId, environmentId);
    if (actual.displayName !== desired.displayName) {
      throw new Error(
        `Environment verification failed: expected displayName '${desired.displayName}', received '${actual.displayName}'.`,
      );
    }
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Environment '${desired.displayName}' verification failed for description.`,
      );
    }
    if (
      normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId)
    ) {
      throw new Error(
        `Environment '${desired.displayName}' verification failed for folder placement.`,
      );
    }
    if (actual.properties?.publishDetails?.state !== "Success") {
      throw new Error(
        `Environment '${desired.displayName}' is not successfully published.`,
      );
    }
    if (
      expectedTargetVersion !== undefined &&
      actual.properties.publishDetails.targetVersion !==
        expectedTargetVersion
    ) {
      throw new Error(
        `Environment '${desired.displayName}' verification did not observe the expected published version.`,
      );
    }

    const actualDefinition = await this.getDefinition(
      workspaceId,
      environmentId,
    );
    const actualStagedMarker =
      getEmbeddedFabricDeploymentMarker(actualDefinition);
    if (actualStagedMarker !== expectedStagedMarker) {
      throw new Error(
        expectedStagedMarker === undefined
          ? `Environment '${desired.displayName}' verification found an incomplete deployment-marker cleanup.`
          : `Environment '${desired.displayName}' verification did not find the approved deployment marker in staging.`,
      );
    }
    const includePlatform = includesPlatformPart(desiredDefinition);
    const includeSparkCompute =
      includesSparkComputePart(desiredDefinition);
    if (
      hashFabricDefinition(
        actualDefinition,
        includePlatform,
        includeSparkCompute,
      ) !==
      hashFabricDefinition(desiredDefinition, includePlatform)
    ) {
      throw new Error(
        `Environment '${desired.displayName}' verification failed for definition content.`,
      );
    }
    const publishedState = await this.getPublishedDefinitionState(
      workspaceId,
      environmentId,
      desiredDefinition,
    );
    if (!publishedState.matches) {
      throw new Error(
        `Environment '${desired.displayName}' verification failed because the desired definition is not published.`,
      );
    }
    return actual;
  }

  private async waitForPublish(
    workspaceId: string,
    environmentId: string,
    previousTargetVersion: string | undefined,
    expectedTargetVersion: string | undefined,
  ): Promise<Environment> {
    const deadline = this.now() + this.publishTimeoutMs;
    while (this.now() < deadline) {
      const environment = await this.get(workspaceId, environmentId);
      const publishDetails = environment.properties?.publishDetails;
      const state = publishDetails?.state;
      const targetVersion = publishDetails?.targetVersion;
      if (
        state === "Success" &&
        targetVersion &&
        (!previousTargetVersion ||
          targetVersion !== previousTargetVersion) &&
        (!expectedTargetVersion ||
          targetVersion === expectedTargetVersion)
      ) {
        return environment;
      }
      if (state === "Failed" || state === "Cancelled") {
        throw new Error(
          `Environment publish ended in state '${state}'.`,
        );
      }
      await this.sleep(
        Math.min(this.publishPollIntervalMs, deadline - this.now()),
      );
    }
    throw new Error(
      `Environment publish timed out after ${this.publishTimeoutMs} ms.`,
    );
  }

  private async getPublishedDefinitionState(
    workspaceId: string,
    environmentId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<PublishedDefinitionState> {
    const expectedMarker = getFabricDeploymentMarker(desiredDefinition);
    if (expectedMarker) {
      const response = await this.client.request<PublishedSparkCompute>(
        "GET",
        `${environmentPath(
          workspaceId,
          environmentId,
        )}/sparkcompute?beta=false`,
      );
      if (!response.body) {
        throw new Error(
          "Fabric Get Published Spark Compute response is empty.",
        );
      }
      const publishedMarker = readPublishedDeploymentMarker(response.body);
      return {
        matches: publishedMarker === expectedMarker,
        observedHash: sha256(stableJson(response.body)),
      };
    }

    const desiredPart = desiredDefinition.parts.find(
      (part) =>
        part.path === "Libraries/PublicLibraries/environment.yml",
    );
    if (!desiredPart) {
      throw new Error(
        "Environment definition is missing its external libraries part.",
      );
    }
    const desiredYaml = Buffer.from(
      desiredPart.payload,
      "base64",
    ).toString("utf8");
    const response = await this.client.request<unknown>(
      "GET",
      `${environmentPath(
        workspaceId,
        environmentId,
      )}/libraries/exportExternalLibraries`,
      { acceptedStatuses: [200, 404] },
    );
    if (response.status === 404) {
      const bodyErrorCode =
        response.body !== null &&
        typeof response.body === "object" &&
        typeof (response.body as Record<string, unknown>).errorCode ===
          "string"
          ? (response.body as Record<string, string>).errorCode
          : undefined;
      const errorCode =
        response.headers.get("x-ms-public-api-error-code") ??
        bodyErrorCode;
      if (
        errorCode !== "EnvironmentPublicLibrariesNotFound" &&
        errorCode !== "EnvironmentLibrariesNotFound"
      ) {
        throw new Error(
          `Fabric Export Published External Libraries returned unexpected 404 error '${errorCode ?? "unknown"}'.`,
        );
      }
      return {
        matches: hasNoExternalLibraries(desiredYaml),
        observedHash: sha256(stableJson(null)),
      };
    }
    if (typeof response.body !== "string") {
      throw new Error(
        "Fabric Export Published External Libraries response is invalid.",
      );
    }
    return {
      matches:
        canonicalYaml(response.body) === canonicalYaml(desiredYaml),
      observedHash: sha256(canonicalYaml(response.body)),
    };
  }

  private async cleanupDeploymentMarker(
    workspaceId: string,
    environmentId: string,
    definition: FabricDefinition,
  ): Promise<void> {
    const expectedMarker = getFabricDeploymentMarker(definition);
    if (!expectedMarker) {
      return;
    }
    const currentDefinition = await this.getDefinition(
      workspaceId,
      environmentId,
    );
    if (
      getEmbeddedFabricDeploymentMarker(currentDefinition) !==
      expectedMarker
    ) {
      throw new Error(
        "Environment staging changed before deployment-marker cleanup.",
      );
    }
    const includePlatform = includesPlatformPart(definition);
    if (
      hashFabricDefinition(
        currentDefinition,
        includePlatform,
        includesSparkComputePart(definition),
      ) !== hashFabricDefinition(definition, includePlatform)
    ) {
      throw new Error(
        "Environment definition changed before deployment-marker cleanup.",
      );
    }
    await this.client.request<PublishedSparkCompute>(
      "PATCH",
      `${environmentPath(
        workspaceId,
        environmentId,
      )}/staging/sparkcompute?beta=false`,
      {
        body: {
          sparkProperties: [
            {
              key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
              value: null,
            },
          ],
        },
        retryable: false,
        acceptedStatuses: [200],
      },
    );
  }

  private async getUpdateRecoveryState(
    workspaceId: string,
    environmentId: string,
    desiredDefinition: FabricDefinition,
  ): Promise<Omit<EnvironmentUpdateRecoveryState, "phase">> {
    const [environment, definition] = await Promise.all([
      this.get(workspaceId, environmentId),
      this.getDefinition(workspaceId, environmentId),
    ]);
    const publishState = environment.properties?.publishDetails?.state;
    const targetVersion =
      environment.properties?.publishDetails?.targetVersion;
    const stagedDeploymentMarker =
      getEmbeddedFabricDeploymentMarker(definition);
    return {
      stagedDefinitionHash: hashFabricDefinition(
        definition,
        includesPlatformPart(desiredDefinition),
        includesSparkComputePart(desiredDefinition),
      ),
      ...(stagedDeploymentMarker
        ? { stagedDeploymentMarker }
        : {}),
      ...(publishState ? { publishState } : {}),
      ...(targetVersion ? { targetVersion } : {}),
    };
  }

  private async stageDefinition(
    workspaceId: string,
    environmentId: string,
    definition: FabricDefinition,
  ): Promise<void> {
    const response = await this.client.request<unknown>(
      "POST",
      `${environmentPath(
        workspaceId,
        environmentId,
      )}/updateDefinition?updateMetadata=${
        includesPlatformPart(definition) ? "true" : "false"
      }`,
      {
        body: { definition },
        retryable: false,
        acceptedStatuses: [200, 202],
      },
    );
    await this.client.waitForOperationCompletion(
      response as FabricResponse<unknown>,
    );
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<Environment | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (environment) => environment.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Environments named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<Environment>,
    onOperationAccepted:
      | ((operation: EnvironmentOperationReference) => void)
      | undefined,
  ): Promise<Environment> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<Environment>(
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
): EnvironmentOperationReference {
  const operationId = response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Environment response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function environmentPath(workspaceId: string, environmentId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/environments/${encodeURIComponent(environmentId)}`;
}

function hashObservedEnvironment(
  environment: Environment,
  definitionHash: string,
  publishedStateHash: string | null = null,
): string {
  return sha256(
    stableJson({
      id: environment.id,
      displayName: environment.displayName,
      description: normalizeDescription(environment.description),
      folderId: environment.folderId ?? null,
      definitionHash,
      publishedStateHash,
      publishState: environment.properties?.publishDetails?.state ?? null,
      targetVersion:
        environment.properties?.publishDetails?.targetVersion ?? null,
    }),
  );
}

function readPublishedDeploymentMarker(
  sparkCompute: PublishedSparkCompute,
): string | undefined {
  if (!Array.isArray(sparkCompute.sparkProperties)) {
    return undefined;
  }
  for (const value of sparkCompute.sparkProperties) {
    if (value === null || typeof value !== "object") {
      continue;
    }
    const property = value as Record<string, unknown>;
    if (
      property.key === FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY &&
      typeof property.value === "string"
    ) {
      return property.value;
    }
  }
  return undefined;
}

function hasNoExternalLibraries(value: string): boolean {
  const parsed = parseYaml(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const dependencies = (parsed as Record<string, unknown>).dependencies;
  if (!Array.isArray(dependencies)) {
    return false;
  }
  return dependencies.every((dependency) => {
    if (dependency === null || typeof dependency !== "object") {
      return false;
    }
    if (Array.isArray(dependency)) {
      return dependency.length === 0;
    }
    const entries = Object.entries(dependency as Record<string, unknown>);
    return entries.every(
      ([key, packages]) =>
        key === "pip" && Array.isArray(packages) && packages.length === 0,
    );
  });
}

function isPublishInProgress(state: string | undefined): boolean {
  return state === "Running" || state === "Waiting" || state === "Cancelling";
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string {
  return value ?? "";
}
