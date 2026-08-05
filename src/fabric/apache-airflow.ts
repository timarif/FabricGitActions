import { createHash } from "node:crypto";

import { sha256, stableJson } from "../hash";
import type {
  DefinitionItemUpdateRecoveryState,
  ItemDefinition,
  PlannedAction,
  PlannedApacheAirflowFileOperation,
  PlannedApacheAirflowFiles,
} from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";
import type { FabricDefinition } from "./definition";
import {
  APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES,
  APACHE_AIRFLOW_DEFINITION_PATH,
  APACHE_AIRFLOW_OWNERSHIP_PATH,
  apacheAirflowIncludesPlatformPart,
  decodeApacheAirflowFile,
  hashApacheAirflowDefinition,
  hashApacheAirflowFiles,
  isUntouchedApacheAirflowShellDefinition,
  type ApacheAirflowSourceFile,
  type LoadedApacheAirflowBundle,
  validateApacheAirflowDefinition,
  validateApacheAirflowFilePath,
} from "./apache-airflow-definition";

export interface ApacheAirflowJob {
  id: string;
  workspaceId?: string;
  type?: "ApacheAirflowJob";
  displayName: string;
  description?: string;
  folderId?: string;
}

export interface ApacheAirflowDefinitionResponse {
  definition: FabricDefinition;
}

export interface ApacheAirflowFileMetadata {
  filePath: string;
  sizeInBytes: number;
}

export interface ApacheAirflowPlanResult {
  action: Extract<
    PlannedAction,
    "create" | "update" | "no-op" | "blocked"
  >;
  reason: string;
  physicalId?: string;
  observedStateHash: string;
  stagedDefinitionHash?: string;
  managedMetadataMatches?: boolean;
  apacheAirflowFiles?: PlannedApacheAirflowFiles;
}

export interface ApacheAirflowOperationReference {
  operationId?: string;
  location?: string;
  physicalId?: string;
  shellDefinitionHash?: string;
}

interface OwnershipEntry {
  filePath: string;
  contentHash: string;
  sizeBytes: number;
}

interface OwnershipLedger {
  schemaVersion: "1";
  managedBy: "fabric-deploy";
  files: OwnershipEntry[];
}

class ApacheAirflowOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApacheAirflowOwnershipError";
  }
}

export class ApacheAirflowAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    workspaceId: string,
    desired: ItemDefinition,
    bundle: LoadedApacheAirflowBundle,
  ): Promise<ApacheAirflowPlanResult> {
    const existing = await this.findByDisplayName(workspaceId, desired);
    if (!existing) {
      return {
        action: "create",
        reason: `Apache Airflow Job '${desired.displayName}' does not exist.`,
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
        reason: `Apache Airflow Job '${desired.displayName}' definition cannot be read. An encrypted sensitivity label or unsupported service state may be blocking getDefinition.`,
        physicalId: current.id,
        observedStateHash: hashObservedApacheAirflow(
          current,
          null,
          null,
        ),
      };
    }

    const includePlatformPart =
      apacheAirflowIncludesPlatformPart(bundle.definition);
    const desiredDefinitionHash = hashApacheAirflowDefinition(
      bundle.definition,
      includePlatformPart,
    );
    const currentDefinitionHash = hashApacheAirflowDefinition(
      currentDefinition,
      includePlatformPart,
    );
    let filePlan: PlannedApacheAirflowFiles;
    try {
      filePlan = await this.planFiles(
        workspaceId,
        current.id,
        bundle.files,
      );
    } catch (error) {
      if (!(error instanceof ApacheAirflowOwnershipError)) {
        throw error;
      }
      return {
        action: "blocked",
        reason: `Apache Airflow Job '${desired.displayName}' file ownership state is invalid: ${errorMessage(error)}`,
        physicalId: current.id,
        observedStateHash: hashObservedApacheAirflow(
          current,
          currentDefinitionHash,
          null,
        ),
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches: metadataMatches(current, desired),
      };
    }

    const observedStateHash = hashObservedApacheAirflow(
      current,
      currentDefinitionHash,
      filePlan.observedStateHash,
    );
    const folderMatches =
      normalizeFolderId(current.folderId) ===
      normalizeFolderId(desired.folderId);
    const managedMetadataMatches = metadataMatches(current, desired);
    const blockedFile = filePlan.operations.find(
      (operation) => operation.action === "blocked",
    );

    if (!folderMatches) {
      return {
        action: "blocked",
        reason: `Apache Airflow Job '${desired.displayName}' is in a different folder; folder moves are not supported.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        apacheAirflowFiles: filePlan,
      };
    }
    if (blockedFile) {
      return {
        action: "blocked",
        reason: blockedFile.reason,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        apacheAirflowFiles: filePlan,
      };
    }
    const fileChanges = filePlan.operations.some(
      (operation) => operation.action !== "no-op",
    );
    if (
      !managedMetadataMatches ||
      currentDefinitionHash !== desiredDefinitionHash ||
      fileChanges
    ) {
      return {
        action: "update",
        reason: !managedMetadataMatches
          ? `Apache Airflow Job '${desired.displayName}' metadata differs.`
          : currentDefinitionHash !== desiredDefinitionHash
            ? `Apache Airflow Job '${desired.displayName}' definition differs.`
            : `Apache Airflow Job '${desired.displayName}' DAG or plugin files differ.`,
        physicalId: current.id,
        observedStateHash,
        stagedDefinitionHash: currentDefinitionHash,
        managedMetadataMatches,
        apacheAirflowFiles: filePlan,
      };
    }
    return {
      action: "no-op",
      reason: `Apache Airflow Job '${desired.displayName}' matches the desired definition and managed files.`,
      physicalId: current.id,
      observedStateHash,
      stagedDefinitionHash: currentDefinitionHash,
      managedMetadataMatches,
      apacheAirflowFiles: filePlan,
    };
  }

  async list(
    workspaceId: string,
    folderId?: string,
  ): Promise<ApacheAirflowJob[]> {
    const url = new URL(
      apacheAirflowCollectionPath(workspaceId),
      "https://placeholder.invalid",
    );
    url.searchParams.set("recursive", "false");
    if (folderId) {
      url.searchParams.set("rootFolderId", folderId);
    }
    return this.client.listAll<ApacheAirflowJob>(
      `${url.pathname}${url.search}`,
    );
  }

  async get(
    workspaceId: string,
    apacheAirflowJobId: string,
  ): Promise<ApacheAirflowJob> {
    const response = await this.client.request<ApacheAirflowJob>(
      "GET",
      apacheAirflowPath(workspaceId, apacheAirflowJobId),
    );
    if (!response.body) {
      throw new Error(
        "Fabric Get Apache Airflow Job response is empty.",
      );
    }
    return response.body;
  }

  async getDefinition(
    workspaceId: string,
    apacheAirflowJobId: string,
  ): Promise<FabricDefinition> {
    const response =
      await this.client.request<ApacheAirflowDefinitionResponse>(
        "POST",
        `${apacheAirflowPath(
          workspaceId,
          apacheAirflowJobId,
        )}/getDefinition`,
        {
          retryable: true,
          acceptedStatuses: [200, 202],
        },
      );
    const result =
      response.status === 202
        ? await this.client.waitForOperation<ApacheAirflowDefinitionResponse>(
            response as FabricResponse<unknown>,
          )
        : response.body;
    if (!result?.definition || !Array.isArray(result.definition.parts)) {
      throw new Error(
        "Fabric Get Apache Airflow Job Definition response is invalid.",
      );
    }
    const definition: FabricDefinition = {
      ...(result.definition.format !== undefined
        ? { format: result.definition.format }
        : {}),
      parts: result.definition.parts.filter(
        (part) =>
          !part.path.startsWith("dags/") &&
          !part.path.startsWith("plugins/"),
      ),
    };
    validateApacheAirflowDefinition(definition);
    return definition;
  }

  async listFiles(
    workspaceId: string,
    apacheAirflowJobId: string,
    rootPath?: string,
  ): Promise<ApacheAirflowFileMetadata[]> {
    const url = new URL(
      `${apacheAirflowPath(
        workspaceId,
        apacheAirflowJobId,
      )}/files`,
      "https://placeholder.invalid",
    );
    url.searchParams.set("beta", "true");
    if (rootPath) {
      validateApacheAirflowFilePath(`${rootPath}/placeholder`);
      url.searchParams.set("rootPath", rootPath);
    }
    return this.client.listAll<ApacheAirflowFileMetadata>(
      `${url.pathname}${url.search}`,
    );
  }

  async getFile(
    workspaceId: string,
    apacheAirflowJobId: string,
    filePath: string,
  ): Promise<Uint8Array | undefined> {
    validateApacheAirflowFilePath(filePath);
    try {
      const response = await this.client.request<Uint8Array>(
        "GET",
        apacheAirflowFilePath(
          workspaceId,
          apacheAirflowJobId,
          filePath,
        ),
        {
          responseType: "bytes",
          accept: "application/octet-stream",
        },
      );
      return response.body ?? new Uint8Array();
    } catch (error) {
      if (error instanceof FabricApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async putFile(
    workspaceId: string,
    apacheAirflowJobId: string,
    filePath: string,
    content: Uint8Array,
  ): Promise<void> {
    validateApacheAirflowFilePath(filePath);
    if (content.byteLength > APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `Apache Airflow file '${filePath}' exceeds the 2 MB Fabric file limit.`,
      );
    }
    await this.client.request(
      "PUT",
      apacheAirflowFilePath(
        workspaceId,
        apacheAirflowJobId,
        filePath,
      ),
      {
        body: content,
        bodyType: "raw",
        contentType: "application/octet-stream",
        acceptedStatuses: [200],
        retryable: false,
      },
    );
  }

  async deleteFile(
    workspaceId: string,
    apacheAirflowJobId: string,
    filePath: string,
  ): Promise<void> {
    validateApacheAirflowFilePath(filePath);
    try {
      await this.client.request(
        "DELETE",
        apacheAirflowFilePath(
          workspaceId,
          apacheAirflowJobId,
          filePath,
        ),
        {
          acceptedStatuses: [200],
          retryable: false,
        },
      );
    } catch (error) {
      if (error instanceof FabricApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async create(
    workspaceId: string,
    desired: ItemDefinition,
    bundle: LoadedApacheAirflowBundle,
    onMutationAccepted?: (physicalId: string) => void,
    onOperationAccepted?: (
      operation: ApacheAirflowOperationReference,
    ) => void,
    onCreateSubmitting?: () => void,
    onCreateRejected?: () => void,
  ): Promise<ApacheAirflowJob> {
    const body: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      body.description = desired.description;
    }
    if (desired.folderId !== undefined) {
      body.folderId = desired.folderId;
    }

    let response: FabricResponse<ApacheAirflowJob>;
    try {
      response = await this.client.request<ApacheAirflowJob>(
        "POST",
        apacheAirflowCollectionPath(workspaceId),
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
        "Fabric Create Apache Airflow Job response is missing the item ID.",
      );
    }
    const shellDefinition = await this.getDefinition(
      workspaceId,
      created.id,
    );
    onOperationAccepted?.({
      physicalId: created.id,
      shellDefinitionHash: hashApacheAirflowDefinition(
        shellDefinition,
        apacheAirflowIncludesPlatformPart(bundle.definition),
      ),
    });
    await this.stageDefinition(
      workspaceId,
      created.id,
      bundle.definition,
      onCreateRejected,
    );
    await this.reconcileFiles(workspaceId, created.id, bundle.files);
    const verified = await this.verify(
      workspaceId,
      created.id,
      desired,
      bundle,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async resumeCreate(
    workspaceId: string,
    desired: ItemDefinition,
    bundle: LoadedApacheAirflowBundle,
    operation: ApacheAirflowOperationReference,
    onMutationAccepted?: (physicalId: string) => void,
  ): Promise<ApacheAirflowJob> {
    let itemId: string;
    let definitionNeedsStaging: boolean;
    const includePlatformPart =
      apacheAirflowIncludesPlatformPart(bundle.definition);
    const desiredDefinitionHash = hashApacheAirflowDefinition(
      bundle.definition,
      includePlatformPart,
    );
    if (
      operation.physicalId &&
      operation.shellDefinitionHash &&
      !operation.operationId &&
      !operation.location
    ) {
      itemId = operation.physicalId;
      const current = await this.get(workspaceId, itemId);
      assertApprovedIdentity(current, desired);
      const currentDefinition = await this.getDefinition(
        workspaceId,
        itemId,
      );
      const currentHash = hashApacheAirflowDefinition(
        currentDefinition,
        includePlatformPart,
      );
      if (currentHash === desiredDefinitionHash) {
        definitionNeedsStaging = false;
      } else if (currentHash === operation.shellDefinitionHash) {
        definitionNeedsStaging = true;
      } else {
        throw new Error(
          `Apache Airflow Job create recovery: definition changed after checkpoint for '${desired.displayName}'.`,
        );
      }
    } else if (operation.operationId || operation.location) {
      const headers = new Headers();
      if (operation.operationId) {
        headers.set("x-ms-operation-id", operation.operationId);
      }
      if (operation.location) {
        headers.set("location", operation.location);
      }
      const created =
        await this.client.waitForOperation<ApacheAirflowJob>({
          status: 202,
          headers,
          body: undefined,
        });
      if (!created?.id) {
        throw new Error(
          "Fabric Create Apache Airflow Job operation result is missing the item ID.",
        );
      }
      assertApprovedIdentity(created, desired);
      itemId = created.id;
      const currentDefinition = await this.getDefinition(
        workspaceId,
        itemId,
      );
      const currentHash = hashApacheAirflowDefinition(
        currentDefinition,
        includePlatformPart,
      );
      if (currentHash === desiredDefinitionHash) {
        definitionNeedsStaging = false;
      } else if (
        isUntouchedApacheAirflowShellDefinition(currentDefinition)
      ) {
        definitionNeedsStaging = true;
      } else {
        throw new Error(
          `Apache Airflow Job create recovery: definition for '${desired.displayName}' is neither the approved definition nor an untouched Fabric shell.`,
        );
      }
    } else {
      throw new Error(
        "Apache Airflow Job create recovery is missing an operation or physical-item proof.",
      );
    }

    if (definitionNeedsStaging) {
      await this.stageDefinition(
        workspaceId,
        itemId,
        bundle.definition,
      );
    }
    await this.reconcileFiles(workspaceId, itemId, bundle.files);
    const verified = await this.verify(
      workspaceId,
      itemId,
      desired,
      bundle,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async update(
    workspaceId: string,
    apacheAirflowJobId: string,
    desired: ItemDefinition,
    bundle: LoadedApacheAirflowBundle,
    onMutationAccepted?: (physicalId: string) => void,
    onUpdateCheckpoint?: (
      state?: DefinitionItemUpdateRecoveryState,
    ) => void,
    onUpdateRejected?: () => void,
  ): Promise<ApacheAirflowJob> {
    const includePlatformPart =
      apacheAirflowIncludesPlatformPart(bundle.definition);
    const baselineHash = hashApacheAirflowDefinition(
      await this.getDefinition(workspaceId, apacheAirflowJobId),
      includePlatformPart,
    );
    onUpdateCheckpoint?.({
      phase: "metadata-submitting",
      stagedDefinitionHash: baselineHash,
    });

    const metadataBody: Record<string, unknown> = {
      displayName: desired.displayName,
    };
    if (desired.description !== undefined) {
      metadataBody.description = desired.description;
    }
    try {
      const response = await this.client.request<ApacheAirflowJob>(
        "PATCH",
        apacheAirflowPath(workspaceId, apacheAirflowJobId),
        {
          body: metadataBody,
          retryable: false,
          acceptedStatuses: [200, 202],
        },
      );
      await this.client.waitForOperationCompletion(
        response as FabricResponse<unknown>,
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
    onUpdateCheckpoint?.({
      phase: "definition-submitting",
      stagedDefinitionHash: baselineHash,
    });
    await this.stageDefinition(
      workspaceId,
      apacheAirflowJobId,
      bundle.definition,
      onUpdateRejected,
    );
    onUpdateCheckpoint?.({
      phase: "definition-staged",
      stagedDefinitionHash: hashApacheAirflowDefinition(
        bundle.definition,
        includePlatformPart,
      ),
    });
    await this.reconcileFiles(
      workspaceId,
      apacheAirflowJobId,
      bundle.files,
    );
    const verified = await this.verify(
      workspaceId,
      apacheAirflowJobId,
      desired,
      bundle,
    );
    onMutationAccepted?.(verified.id);
    return verified;
  }

  async verify(
    workspaceId: string,
    apacheAirflowJobId: string,
    desired: ItemDefinition,
    bundle: LoadedApacheAirflowBundle,
  ): Promise<ApacheAirflowJob> {
    const actual = await this.get(workspaceId, apacheAirflowJobId);
    assertApprovedIdentity(actual, desired);
    if (
      desired.description !== undefined &&
      normalizeDescription(actual.description) !==
        normalizeDescription(desired.description)
    ) {
      throw new Error(
        `Apache Airflow Job '${desired.displayName}' verification failed for description.`,
      );
    }
    const includePlatformPart =
      apacheAirflowIncludesPlatformPart(bundle.definition);
    const actualDefinition = await this.getDefinition(
      workspaceId,
      apacheAirflowJobId,
    );
    if (
      hashApacheAirflowDefinition(
        actualDefinition,
        includePlatformPart,
      ) !==
      hashApacheAirflowDefinition(
        bundle.definition,
        includePlatformPart,
      )
    ) {
      throw new Error(
        `Apache Airflow Job '${desired.displayName}' verification failed for definition content.`,
      );
    }
    const filePlan = await this.planFiles(
      workspaceId,
      apacheAirflowJobId,
      bundle.files,
    );
    const mismatch = filePlan.operations.find(
      (operation) => operation.action !== "no-op",
    );
    if (mismatch) {
      throw new Error(
        `Apache Airflow Job '${desired.displayName}' verification failed for '${mismatch.filePath}': ${mismatch.reason}`,
      );
    }
    return actual;
  }

  private async planFiles(
    workspaceId: string,
    apacheAirflowJobId: string,
    desiredFiles: readonly ApacheAirflowSourceFile[],
  ): Promise<PlannedApacheAirflowFiles> {
    const ledger = await this.getOwnershipLedger(
      workspaceId,
      apacheAirflowJobId,
    );
    const desired = new Map(
      desiredFiles.map((file) => [file.filePath, file]),
    );
    const owned = new Map(
      ledger.files.map((file) => [file.filePath, file]),
    );
    const paths = [...new Set([...desired.keys(), ...owned.keys()])].sort();
    const observed = new Map<
      string,
      { contentHash: string; sizeBytes: number } | undefined
    >();
    const existingPaths = await this.listExistingManagedPaths(
      workspaceId,
      apacheAirflowJobId,
      paths,
    );
    await Promise.all(
      paths.map(async (filePath) => {
        const content = existingPaths.has(filePath)
          ? await this.getFile(
              workspaceId,
              apacheAirflowJobId,
              filePath,
            )
          : undefined;
        observed.set(
          filePath,
          content
            ? {
                contentHash: hashBytes(content),
                sizeBytes: content.byteLength,
              }
            : undefined,
        );
      }),
    );

    const operations = paths.map((filePath) =>
      planFileOperation(
        filePath,
        desired.get(filePath),
        owned.get(filePath),
        observed.get(filePath),
      ),
    );
    return {
      desiredHash: hashApacheAirflowFiles(desiredFiles),
      observedStateHash: sha256(
        stableJson({
          ownership: ledger.files,
          files: paths.map((filePath) => ({
            filePath,
            observed: observed.get(filePath) ?? null,
          })),
        }),
      ),
      ownershipHash: hashOwnershipLedger(ledger),
      operations,
    };
  }

  private async reconcileFiles(
    workspaceId: string,
    apacheAirflowJobId: string,
    desiredFiles: readonly ApacheAirflowSourceFile[],
  ): Promise<void> {
    const plan = await this.planFiles(
      workspaceId,
      apacheAirflowJobId,
      desiredFiles,
    );
    const blocked = plan.operations.find(
      (operation) => operation.action === "blocked",
    );
    if (blocked) {
      throw new Error(blocked.reason);
    }
    const desired = new Map(
      desiredFiles.map((file) => [file.filePath, file]),
    );
    const uploads = plan.operations
      .filter(
        (operation) =>
          operation.action === "create" ||
          operation.action === "update",
      )
      .sort(compareUploadOperations);
    for (const operation of uploads) {
      const file = desired.get(operation.filePath);
      if (!file) {
        throw new Error(
          `Apache Airflow file '${operation.filePath}' is missing from the captured source bundle.`,
        );
      }
      await this.putFile(
        workspaceId,
        apacheAirflowJobId,
        operation.filePath,
        decodeApacheAirflowFile(file),
      );
    }
    const deletions = plan.operations
      .filter(
        (operation) =>
          operation.action === "delete" &&
          operation.observedHash !== undefined,
      )
      .sort(compareDeleteOperations);
    for (const operation of deletions) {
      await this.deleteFile(
        workspaceId,
        apacheAirflowJobId,
        operation.filePath,
      );
    }
    await this.putOwnershipLedger(
      workspaceId,
      apacheAirflowJobId,
      desiredFiles,
    );
  }

  private async getOwnershipLedger(
    workspaceId: string,
    apacheAirflowJobId: string,
  ): Promise<OwnershipLedger> {
    const existingPaths = await this.listExistingManagedPaths(
      workspaceId,
      apacheAirflowJobId,
      [APACHE_AIRFLOW_OWNERSHIP_PATH],
    );
    const content = existingPaths.has(APACHE_AIRFLOW_OWNERSHIP_PATH)
      ? await this.getFile(
          workspaceId,
          apacheAirflowJobId,
          APACHE_AIRFLOW_OWNERSHIP_PATH,
        )
      : undefined;
    if (!content) {
      return emptyOwnershipLedger();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(content).toString("utf8"));
    } catch {
      throw new ApacheAirflowOwnershipError(
        `reserved ownership file '${APACHE_AIRFLOW_OWNERSHIP_PATH}' is not valid JSON.`,
      );
    }
    try {
      return validateOwnershipLedger(parsed);
    } catch (error) {
      throw new ApacheAirflowOwnershipError(errorMessage(error));
    }
  }

  private async listExistingManagedPaths(
    workspaceId: string,
    apacheAirflowJobId: string,
    filePaths: readonly string[],
  ): Promise<Set<string>> {
    const roots = [
      ...new Set(
        filePaths.map((filePath) => {
          validateApacheAirflowFilePath(filePath);
          return filePath.slice(0, filePath.lastIndexOf("/"));
        }),
      ),
    ];
    const listings = await Promise.all(
      roots.map(async (rootPath) => ({
        rootPath,
        files: await this.listFiles(
          workspaceId,
          apacheAirflowJobId,
          rootPath,
        ),
      })),
    );
    return new Set(
      listings.flatMap(({ rootPath, files }) =>
        files.map((file) =>
          file.filePath.startsWith("dags/") ||
          file.filePath.startsWith("plugins/")
            ? file.filePath
            : `${rootPath}/${file.filePath}`,
        ),
      ),
    );
  }

  private async putOwnershipLedger(
    workspaceId: string,
    apacheAirflowJobId: string,
    desiredFiles: readonly ApacheAirflowSourceFile[],
  ): Promise<void> {
    const ledger: OwnershipLedger = {
      schemaVersion: "1",
      managedBy: "fabric-deploy",
      files: desiredFiles
        .map((file) => ({
          filePath: file.filePath,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
        }))
        .sort((left, right) =>
          left.filePath.localeCompare(right.filePath, "en-US"),
        ),
    };
    const content = Buffer.from(
      `${JSON.stringify(ledger, null, 2)}\n`,
      "utf8",
    );
    if (content.byteLength > APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES) {
      throw new Error(
        "Apache Airflow ownership manifest exceeds the 2 MB Fabric file limit.",
      );
    }
    await this.putFile(
      workspaceId,
      apacheAirflowJobId,
      APACHE_AIRFLOW_OWNERSHIP_PATH,
      content,
    );
  }

  private async stageDefinition(
    workspaceId: string,
    apacheAirflowJobId: string,
    definition: FabricDefinition,
    onInitialRequestRejected?: () => void,
  ): Promise<void> {
    const contentPart = definition.parts.find(
      (part) => part.path === APACHE_AIRFLOW_DEFINITION_PATH,
    );
    if (!contentPart) {
      throw new Error(
        `Apache Airflow definition is missing '${APACHE_AIRFLOW_DEFINITION_PATH}'.`,
      );
    }
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        `${apacheAirflowPath(
          workspaceId,
          apacheAirflowJobId,
        )}/updateDefinition?updateMetadata=false`,
        {
          body: {
            definition: {
              parts: [contentPart],
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
    await this.client.waitForOperationCompletion(response);
  }

  private async findByDisplayName(
    workspaceId: string,
    desired: ItemDefinition,
  ): Promise<ApacheAirflowJob | undefined> {
    const matches = (await this.list(workspaceId, desired.folderId)).filter(
      (item) => item.displayName === desired.displayName,
    );
    if (matches.length > 1) {
      throw new Error(
        `Multiple Apache Airflow Jobs named '${desired.displayName}' were found. Use an unambiguous folder scope.`,
      );
    }
    return matches[0];
  }

  private async waitForCreateOperation(
    response: FabricResponse<ApacheAirflowJob>,
    onOperationAccepted:
      | ((operation: ApacheAirflowOperationReference) => void)
      | undefined,
  ): Promise<ApacheAirflowJob> {
    onOperationAccepted?.(readOperationReference(response));
    return this.client.waitForOperation<ApacheAirflowJob>(
      response as FabricResponse<unknown>,
    );
  }
}

function planFileOperation(
  filePath: string,
  desired: ApacheAirflowSourceFile | undefined,
  owned: OwnershipEntry | undefined,
  observed:
    | { contentHash: string; sizeBytes: number }
    | undefined,
): PlannedApacheAirflowFileOperation {
  const proof = {
    ...(desired ? { desiredHash: desired.contentHash } : {}),
    ...(observed ? { observedHash: observed.contentHash } : {}),
    ...(owned ? { ownedHash: owned.contentHash } : {}),
    ...(desired
      ? { sizeBytes: desired.sizeBytes }
      : observed
        ? { sizeBytes: observed.sizeBytes }
        : {}),
  };
  if (desired && !owned) {
    if (!observed) {
      return {
        filePath,
        action: "create",
        ...proof,
        reason: `Create managed Apache Airflow file '${filePath}'.`,
      };
    }
    if (observed.contentHash === desired.contentHash) {
      return {
        filePath,
        action: "adopt",
        ...proof,
        reason: `Adopt identical Apache Airflow file '${filePath}' into the ownership manifest.`,
      };
    }
    return {
      filePath,
      action: "blocked",
      ...proof,
      reason: `Apache Airflow file '${filePath}' already exists but is not owned by Fabric Deploy and has different content.`,
    };
  }
  if (desired && owned) {
    if (!observed) {
      return {
        filePath,
        action: "create",
        ...proof,
        reason: `Recreate missing managed Apache Airflow file '${filePath}'.`,
      };
    }
    if (
      observed.contentHash === desired.contentHash &&
      owned.contentHash === desired.contentHash
    ) {
      return {
        filePath,
        action: "no-op",
        ...proof,
        reason: `Managed Apache Airflow file '${filePath}' matches.`,
      };
    }
    if (
      observed.contentHash === desired.contentHash ||
      observed.contentHash === owned.contentHash
    ) {
      return {
        filePath,
        action: "update",
        ...proof,
        reason: `Update managed Apache Airflow file '${filePath}'.`,
      };
    }
    return {
      filePath,
      action: "blocked",
      ...proof,
      reason: `Managed Apache Airflow file '${filePath}' changed outside Fabric Deploy after the last successful apply.`,
    };
  }
  if (owned) {
    if (!observed || observed.contentHash === owned.contentHash) {
      return {
        filePath,
        action: "delete",
        ...proof,
        reason: observed
          ? `Delete managed Apache Airflow file '${filePath}'.`
          : `Remove stale ownership for already absent Apache Airflow file '${filePath}'.`,
      };
    }
    return {
      filePath,
      action: "blocked",
      ...proof,
      reason: `Managed Apache Airflow file '${filePath}' changed outside Fabric Deploy and cannot be safely deleted.`,
    };
  }
  throw new Error(
    `Apache Airflow file '${filePath}' has no desired, owned, or observed state.`,
  );
}

function validateOwnershipLedger(value: unknown): OwnershipLedger {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error("ownership manifest must be a JSON object.");
  }
  const ledger = value as Partial<OwnershipLedger>;
  if (
    ledger.schemaVersion !== "1" ||
    ledger.managedBy !== "fabric-deploy" ||
    !Array.isArray(ledger.files)
  ) {
    throw new Error("ownership manifest has an unsupported structure.");
  }
  const paths = new Set<string>();
  const files = ledger.files.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      throw new Error("ownership manifest contains an invalid file entry.");
    }
    const file = entry as Partial<OwnershipEntry>;
    if (
      typeof file.filePath !== "string" ||
      file.filePath === APACHE_AIRFLOW_OWNERSHIP_PATH ||
      typeof file.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.contentHash) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES ||
      paths.has(file.filePath)
    ) {
      throw new Error("ownership manifest contains an invalid file entry.");
    }
    validateApacheAirflowFilePath(file.filePath);
    paths.add(file.filePath);
    return {
      filePath: file.filePath,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
    };
  });
  return {
    schemaVersion: "1",
    managedBy: "fabric-deploy",
    files: files.sort((left, right) =>
      left.filePath.localeCompare(right.filePath, "en-US"),
    ),
  };
}

function emptyOwnershipLedger(): OwnershipLedger {
  return {
    schemaVersion: "1",
    managedBy: "fabric-deploy",
    files: [],
  };
}

function hashOwnershipLedger(ledger: OwnershipLedger): string {
  return sha256(stableJson(ledger));
}

function compareUploadOperations(
  left: PlannedApacheAirflowFileOperation,
  right: PlannedApacheAirflowFileOperation,
): number {
  const leftGroup = left.filePath.startsWith("plugins/") ? 0 : 1;
  const rightGroup = right.filePath.startsWith("plugins/") ? 0 : 1;
  return leftGroup - rightGroup || left.filePath.localeCompare(right.filePath);
}

function compareDeleteOperations(
  left: PlannedApacheAirflowFileOperation,
  right: PlannedApacheAirflowFileOperation,
): number {
  const leftGroup = left.filePath.startsWith("dags/") ? 0 : 1;
  const rightGroup = right.filePath.startsWith("dags/") ? 0 : 1;
  return leftGroup - rightGroup || left.filePath.localeCompare(right.filePath);
}

function metadataMatches(
  actual: ApacheAirflowJob,
  desired: ItemDefinition,
): boolean {
  return (
    actual.displayName === desired.displayName &&
    normalizeFolderId(actual.folderId) ===
      normalizeFolderId(desired.folderId) &&
    (desired.description === undefined ||
      normalizeDescription(actual.description) ===
        normalizeDescription(desired.description))
  );
}

function assertApprovedIdentity(
  actual: ApacheAirflowJob,
  desired: ItemDefinition,
): void {
  if (
    actual.displayName !== desired.displayName ||
    normalizeFolderId(actual.folderId) !==
      normalizeFolderId(desired.folderId) ||
    (actual.type !== undefined &&
      actual.type !== "ApacheAirflowJob")
  ) {
    throw new Error(
      `Apache Airflow Job '${desired.displayName}' no longer matches the approved identity.`,
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
): ApacheAirflowOperationReference {
  const operationId =
    response.headers.get("x-ms-operation-id") || undefined;
  const location = response.headers.get("location") || undefined;
  if (!operationId && !location) {
    throw new Error(
      "Fabric Create Apache Airflow Job response is missing Location and x-ms-operation-id.",
    );
  }
  return {
    ...(operationId ? { operationId } : {}),
    ...(location ? { location } : {}),
  };
}

function apacheAirflowCollectionPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/apacheAirflowJobs`;
}

function apacheAirflowPath(
  workspaceId: string,
  apacheAirflowJobId: string,
): string {
  return `${apacheAirflowCollectionPath(
    workspaceId,
  )}/${encodeURIComponent(apacheAirflowJobId)}`;
}

function apacheAirflowFilePath(
  workspaceId: string,
  apacheAirflowJobId: string,
  filePath: string,
): string {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${apacheAirflowPath(
    workspaceId,
    apacheAirflowJobId,
  )}/files/${encodedPath}?beta=true`;
}

function hashObservedApacheAirflow(
  item: ApacheAirflowJob,
  definitionHash: string | null,
  filesHash: string | null,
): string {
  return sha256(
    stableJson({
      id: item.id,
      displayName: item.displayName,
      description: normalizeDescription(item.description),
      folderId: item.folderId ?? null,
      definitionHash,
      filesHash,
    }),
  );
}

function hashBytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeDescription(value: string | undefined): string {
  return value ?? "";
}

function normalizeFolderId(value: string | undefined): string {
  return value ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
