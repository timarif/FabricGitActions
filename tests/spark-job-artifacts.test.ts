import { describe, expect, it, vi } from "vitest";

import {
  assertSparkJobArtifactEndpoints,
  materializeSparkJobArtifactUris,
  planSparkJobArtifacts,
  requireSparkJobArtifactTarget,
} from "../src/fabric/spark-job-artifacts";
import { MAX_ONELAKE_SINGLE_UPLOAD_BYTES } from "../src/fabric/onelake-artifacts";
import type { SparkJobArtifactSource } from "../src/fabric/spark-job-definition";

const WORKSPACE_ID = "11111111-1111-1111-1111-111111111111";
const LAKEHOUSE_ID = "22222222-2222-2222-2222-222222222222";
const DFS_ENDPOINT = "https://onelake.dfs.fabric.microsoft.com";
const BLOB_ENDPOINT = "https://onelake.blob.fabric.microsoft.com";

function source(
  overrides: Partial<SparkJobArtifactSource> = {},
): SparkJobArtifactSource {
  return {
    kind: "executable",
    fileName: "app.jar",
    relativePath: "definition/main.jar",
    sourcePath: "C:\\repo\\definition\\main.jar",
    contentHash: "a".repeat(64),
    sizeBytes: 42,
    ...overrides,
  };
}

describe("Spark Job artifact staging plans", () => {
  it("requires a logical default Lakehouse binding", () => {
    expect(() =>
      requireSparkJobArtifactTarget("job", {}, [source()]),
    ).toThrow("must declare a logical defaultLakehouse");
    expect(
      requireSparkJobArtifactTarget(
        "job",
        {
          "/properties/defaultLakehouseArtifactId": {
            logicalId: "bronze",
            valueFrom: "items.bronze.id",
            targetType: "Lakehouse",
          },
        },
        [source()],
      ),
    ).toBe("bronze");
  });

  it("plans deterministic symbolic creates for a new Lakehouse", async () => {
    const planned = await planSparkJobArtifacts({
      deploymentId: "deployment",
      environment: "prod",
      workspaceId: WORKSPACE_ID,
      logicalId: "job",
      targetLakehouseLogicalId: "bronze",
      sources: [source()],
      oneLakeDfsEndpoint: DFS_ENDPOINT,
      oneLakeBlobEndpoint: BLOB_ENDPOINT,
    });

    expect(planned).toMatchObject({
      targetLakehouseLogicalId: "bronze",
      targetBinding: "symbolic",
      oneLakeDfsEndpoint: DFS_ENDPOINT,
      oneLakeBlobEndpoint: BLOB_ENDPOINT,
      stagingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      artifacts: [
        {
          kind: "executable",
          action: "create",
          fileName: "app.jar",
          oneLakePath: `Files/.fabric-deploy/deployment/prod/job/${"a".repeat(64)}/app.jar`,
          observedHash: "absent",
        },
      ],
    });
  });

  it("blocks oversized artifacts before apply", async () => {
    const planned = await planSparkJobArtifacts({
      deploymentId: "deployment",
      environment: "prod",
      workspaceId: WORKSPACE_ID,
      logicalId: "job",
      targetLakehouseLogicalId: "bronze",
      sources: [
        source({
          sizeBytes: MAX_ONELAKE_SINGLE_UPLOAD_BYTES + 1,
        }),
      ],
      oneLakeDfsEndpoint: DFS_ENDPOINT,
      oneLakeBlobEndpoint: BLOB_ENDPOINT,
    });

    expect(planned?.artifacts[0]).toMatchObject({
      action: "blocked",
      observedHash: "uninspected",
    });
  });

  it("classifies physical paths by exact content inspection", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce({
        exists: false,
        matches: false,
        observedHash: "",
      })
      .mockResolvedValueOnce({
        exists: true,
        matches: true,
        observedHash: "b".repeat(64),
      })
      .mockResolvedValueOnce({
        exists: true,
        matches: false,
        observedHash: "c".repeat(64),
      });
    const sources = [
      source({ fileName: "a.jar" }),
      source({
        kind: "library",
        fileName: "b.jar",
        relativePath: "definition/libs/b.jar",
        contentHash: "b".repeat(64),
      }),
      source({
        kind: "library",
        fileName: "c.jar",
        relativePath: "definition/libs/c.jar",
        contentHash: "d".repeat(64),
      }),
    ];

    const planned = await planSparkJobArtifacts({
      deploymentId: "deployment",
      environment: "prod",
      workspaceId: WORKSPACE_ID,
      logicalId: "job",
      targetLakehouseLogicalId: "bronze",
      targetLakehousePhysicalId: LAKEHOUSE_ID,
      sources,
      oneLakeDfsEndpoint: DFS_ENDPOINT,
      oneLakeBlobEndpoint: BLOB_ENDPOINT,
      stager: { inspect },
    });

    expect(planned?.artifacts.map((artifact) => artifact.action)).toEqual([
      "create",
      "no-op",
      "blocked",
    ]);
    expect(planned?.artifacts[0]?.abfssUri).toContain(
      `abfss://${WORKSPACE_ID}@onelake.dfs.fabric.microsoft.com/${LAKEHOUSE_ID}/Files/.fabric-deploy/`,
    );
  });

  it("materializes approved URIs and rejects source drift", async () => {
    const planned = await planSparkJobArtifacts({
      deploymentId: "deployment",
      environment: "prod",
      workspaceId: WORKSPACE_ID,
      logicalId: "job",
      targetLakehouseLogicalId: "bronze",
      sources: [source()],
      oneLakeDfsEndpoint: DFS_ENDPOINT,
      oneLakeBlobEndpoint: BLOB_ENDPOINT,
    });
    expect(planned).toBeDefined();

    expect(
      materializeSparkJobArtifactUris(
        planned!,
        [source()],
        DFS_ENDPOINT,
        WORKSPACE_ID,
        LAKEHOUSE_ID,
        "deployment",
        "prod",
        "job",
      ),
    ).toEqual([
      {
        kind: "executable",
        fileName: "app.jar",
        contentHash: "a".repeat(64),
        abfssUri: `abfss://${WORKSPACE_ID}@onelake.dfs.fabric.microsoft.com/${LAKEHOUSE_ID}/Files/.fabric-deploy/deployment/prod/job/${"a".repeat(64)}/app.jar`,
      },
    ]);
    expect(() =>
      materializeSparkJobArtifactUris(
        planned!,
        [source({ contentHash: "b".repeat(64) })],
        DFS_ENDPOINT,
        WORKSPACE_ID,
        LAKEHOUSE_ID,
        "deployment",
        "prod",
        "job",
      ),
    ).toThrow("proof changed after approval");
    expect(() =>
      materializeSparkJobArtifactUris(
        planned!,
        [source()],
        "https://alternate.dfs.fabric.microsoft.com",
        WORKSPACE_ID,
        LAKEHOUSE_ID,
        "deployment",
        "prod",
        "job",
      ),
    ).toThrow("DFS endpoint changed after plan approval");
    expect(() =>
      assertSparkJobArtifactEndpoints(
        planned!,
        DFS_ENDPOINT,
        "https://alternate.blob.fabric.microsoft.com",
      ),
    ).toThrow("endpoint configuration changed after plan approval");
  });
});
