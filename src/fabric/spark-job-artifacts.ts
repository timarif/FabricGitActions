import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  PlannedOneLakeArtifact,
  PlannedSparkJobArtifacts,
} from "../types";
import type {
  CanonicalResolvedBindingMap,
  SparkJobArtifactMaterialization,
} from "./logical-references";
import {
  buildOneLakeAbfssUri,
  buildOneLakeArtifactPath,
  MAX_ONELAKE_SINGLE_UPLOAD_BYTES,
  normalizeOneLakeRootEndpoint,
  type OneLakeArtifactDescriptor,
  type OneLakeArtifactStager,
} from "./onelake-artifacts";
import type { SparkJobArtifactSource } from "./spark-job-definition";

export const DEFAULT_LAKEHOUSE_BINDING_TARGET =
  "/properties/defaultLakehouseArtifactId";

export interface SparkJobArtifactPlanningContext {
  deploymentId: string;
  environment: string;
  workspaceId: string;
  logicalId: string;
  targetLakehouseLogicalId: string;
  targetLakehousePhysicalId?: string;
  sources: readonly SparkJobArtifactSource[];
  oneLakeDfsEndpoint: string;
  oneLakeBlobEndpoint: string;
  stager?: Pick<OneLakeArtifactStager, "inspect">;
}

export function requireSparkJobArtifactTarget(
  logicalId: string,
  bindings: CanonicalResolvedBindingMap,
  sources: readonly SparkJobArtifactSource[],
): string | undefined {
  if (sources.length === 0) {
    return undefined;
  }
  const binding = bindings[DEFAULT_LAKEHOUSE_BINDING_TARGET];
  if (!binding || binding.targetType !== "Lakehouse") {
    throw new Error(
      `Spark Job Definition '${logicalId}' stages JAR libraries and must declare a logical defaultLakehouse reference or binding.`,
    );
  }
  return binding.logicalId;
}

export function assertSparkJobArtifactEndpoints(
  staging: PlannedSparkJobArtifacts,
  oneLakeDfsEndpoint: string,
  oneLakeBlobEndpoint: string,
): void {
  const normalizedDfsEndpoint = normalizeOneLakeRootEndpoint(
    oneLakeDfsEndpoint,
    "DFS",
  );
  const normalizedBlobEndpoint = normalizeOneLakeRootEndpoint(
    oneLakeBlobEndpoint,
    "Blob",
  );
  if (
    staging.oneLakeDfsEndpoint !== normalizedDfsEndpoint ||
    staging.oneLakeBlobEndpoint !== normalizedBlobEndpoint
  ) {
    throw new Error(
      "OneLake endpoint configuration changed after plan approval.",
    );
  }
}

export async function planSparkJobArtifacts(
  context: SparkJobArtifactPlanningContext,
): Promise<PlannedSparkJobArtifacts | undefined> {
  if (context.sources.length === 0) {
    return undefined;
  }
  const oneLakeDfsEndpoint = normalizeOneLakeRootEndpoint(
    context.oneLakeDfsEndpoint,
    "DFS",
  );
  const oneLakeBlobEndpoint = normalizeOneLakeRootEndpoint(
    context.oneLakeBlobEndpoint,
    "Blob",
  );
  const desired = context.sources
    .map((source) =>
      buildDesiredArtifact(
        context.deploymentId,
        context.environment,
        context.logicalId,
        context.targetLakehouseLogicalId,
        source,
      ),
    )
    .sort((left, right) =>
      compareCanonicalStrings(left.fileName, right.fileName),
    );
  const stagingHash = sha256(
    stableJson({
      targetLakehouseLogicalId: context.targetLakehouseLogicalId,
      oneLakeDfsEndpoint,
      oneLakeBlobEndpoint,
      artifacts: desired.map(desiredArtifactProof),
    }),
  );

  if (!context.targetLakehousePhysicalId) {
    return {
      targetLakehouseLogicalId: context.targetLakehouseLogicalId,
      targetBinding: "symbolic",
      oneLakeDfsEndpoint,
      oneLakeBlobEndpoint,
      stagingHash,
      artifacts: desired.map((artifact) =>
        artifact.sizeBytes > MAX_ONELAKE_SINGLE_UPLOAD_BYTES
          ? {
              ...artifact,
              action: "blocked",
              observedHash: "uninspected",
              reason: `Artifact '${artifact.fileName}' exceeds the 512 MiB OneLake single-upload limit.`,
            }
          : {
              ...artifact,
              action: "create",
              observedHash: "absent",
              reason: `Artifact '${artifact.fileName}' will be staged after the target Lakehouse is created.`,
            },
      ),
    };
  }

  const artifacts: PlannedOneLakeArtifact[] = [];
  for (const artifact of desired) {
    const source = context.sources.find(
      (candidate) => candidate.fileName === artifact.fileName,
    );
    if (!source) {
      throw new Error(
        `Spark Job artifact source '${artifact.fileName}' is missing during planning.`,
      );
    }
    if (artifact.sizeBytes > MAX_ONELAKE_SINGLE_UPLOAD_BYTES) {
      artifacts.push({
        ...artifact,
        action: "blocked",
        observedHash: "uninspected",
        reason: `Artifact '${artifact.fileName}' exceeds the 512 MiB OneLake single-upload limit.`,
      });
      continue;
    }
    const abfssUri = buildOneLakeAbfssUri(
      oneLakeDfsEndpoint,
      context.workspaceId,
      context.targetLakehousePhysicalId,
      artifact.oneLakePath,
    );
    if (!context.stager) {
      artifacts.push({
        ...artifact,
        abfssUri,
        action: "blocked",
        observedHash: "unknown",
        reason: "OneLake artifact staging client was not initialized.",
      });
      continue;
    }
    const inspection = await context.stager.inspect(
      artifactDescriptor(
        context.workspaceId,
        context.targetLakehousePhysicalId,
        artifact,
        source,
      ),
    );
    artifacts.push({
      ...artifact,
      abfssUri,
      action: !inspection.exists
        ? "create"
        : inspection.matches
          ? "no-op"
          : "blocked",
      observedHash: inspection.observedHash,
      reason: !inspection.exists
        ? `Artifact '${artifact.fileName}' is absent from OneLake.`
        : inspection.matches
          ? `Artifact '${artifact.fileName}' already matches the approved content.`
          : `Artifact '${artifact.fileName}' exists at the immutable path with different content.`,
    });
  }

  return {
    targetLakehouseLogicalId: context.targetLakehouseLogicalId,
    targetLakehousePhysicalId: context.targetLakehousePhysicalId,
    targetBinding: "physical",
    oneLakeDfsEndpoint,
    oneLakeBlobEndpoint,
    stagingHash,
    artifacts,
  };
}

export function materializeSparkJobArtifactUris(
  staging: PlannedSparkJobArtifacts,
  sources: readonly SparkJobArtifactSource[],
  oneLakeDfsEndpoint: string,
  workspaceId: string,
  targetLakehouseId: string,
  deploymentId: string,
  environment: string,
  logicalId: string,
): SparkJobArtifactMaterialization[] {
  const normalizedDfsEndpoint = normalizeOneLakeRootEndpoint(
    oneLakeDfsEndpoint,
    "DFS",
  );
  if (normalizedDfsEndpoint !== staging.oneLakeDfsEndpoint) {
    throw new Error(
      "Spark Job artifact OneLake DFS endpoint changed after plan approval.",
    );
  }
  if (sources.length !== staging.artifacts.length) {
    throw new Error(
      "Spark Job artifact source count changed after plan approval.",
    );
  }
  const sourceByName = new Map(
    sources.map((source) => [source.fileName, source]),
  );
  const desiredProofs = staging.artifacts
    .map((artifact) => {
      const source = sourceByName.get(artifact.fileName);
      if (!source) {
        throw new Error(
          `Spark Job artifact source '${artifact.fileName}' is missing after plan approval.`,
        );
      }
      const desired = buildDesiredArtifact(
        deploymentId,
        environment,
        logicalId,
        staging.targetLakehouseLogicalId,
        source,
      );
      if (
        desired.operationId !== artifact.operationId ||
        desired.operationHash !== artifact.operationHash ||
        desired.relativeSourcePath !== artifact.relativeSourcePath ||
        desired.contentHash !== artifact.contentHash ||
        desired.sizeBytes !== artifact.sizeBytes
      ) {
        throw new Error(
          `Spark Job artifact proof changed after approval for '${artifact.fileName}'.`,
        );
      }
      return desiredArtifactProof(artifact);
    })
    .sort((left, right) =>
      compareCanonicalStrings(left.fileName, right.fileName),
    );
  const stagingHash = sha256(
    stableJson({
      targetLakehouseLogicalId: staging.targetLakehouseLogicalId,
      oneLakeDfsEndpoint: staging.oneLakeDfsEndpoint,
      oneLakeBlobEndpoint: staging.oneLakeBlobEndpoint,
      artifacts: desiredProofs,
    }),
  );
  if (stagingHash !== staging.stagingHash) {
    throw new Error("Spark Job artifact staging hash changed after approval.");
  }
  return staging.artifacts
    .map((artifact) => ({
      kind: artifact.kind,
      fileName: artifact.fileName,
      contentHash: artifact.contentHash,
      abfssUri: buildOneLakeAbfssUri(
        normalizedDfsEndpoint,
        workspaceId,
        targetLakehouseId,
        artifact.oneLakePath,
      ),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.fileName, right.fileName),
    );
}

export function artifactDescriptor(
  workspaceId: string,
  lakehouseId: string,
  artifact: Pick<
    PlannedOneLakeArtifact,
    "oneLakePath" | "fileName" | "contentHash" | "sizeBytes"
  >,
  source: SparkJobArtifactSource,
): OneLakeArtifactDescriptor {
  return {
    workspaceId,
    lakehouseId,
    oneLakePath: artifact.oneLakePath,
    fileName: artifact.fileName,
    sourcePath: source.sourcePath,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    contentType: "application/java-archive",
  };
}

function buildDesiredArtifact(
  deploymentId: string,
  environment: string,
  logicalId: string,
  targetLakehouseLogicalId: string,
  source: SparkJobArtifactSource,
): Omit<
  PlannedOneLakeArtifact,
  "action" | "abfssUri" | "observedHash" | "reason"
> {
  const oneLakePath = buildOneLakeArtifactPath(
    deploymentId,
    environment,
    logicalId,
    source.contentHash,
    source.fileName,
  );
  const proof = {
    schemaVersion: "1",
    targetLakehouseLogicalId,
    kind: source.kind,
    fileName: source.fileName,
    relativeSourcePath: source.relativePath,
    contentHash: source.contentHash,
    sizeBytes: source.sizeBytes,
    oneLakePath,
  };
  const operationHash = sha256(stableJson(proof));
  return {
    kind: source.kind,
    operationId: `${source.fileName}:${operationHash.slice(0, 16)}`,
    operationHash,
    fileName: source.fileName,
    relativeSourcePath: source.relativePath,
    contentHash: source.contentHash,
    sizeBytes: source.sizeBytes,
    oneLakePath,
  };
}

function desiredArtifactProof(
  artifact: Pick<
    PlannedOneLakeArtifact,
    | "operationId"
    | "operationHash"
    | "kind"
    | "fileName"
    | "relativeSourcePath"
    | "contentHash"
    | "sizeBytes"
    | "oneLakePath"
  >,
) {
  return {
    kind: artifact.kind,
    operationId: artifact.operationId,
    operationHash: artifact.operationHash,
    fileName: artifact.fileName,
    relativeSourcePath: artifact.relativeSourcePath,
    contentHash: artifact.contentHash,
    sizeBytes: artifact.sizeBytes,
    oneLakePath: artifact.oneLakePath,
  };
}
