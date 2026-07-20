import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  hashMaterializedSparkJobDefinition,
  materializeSparkJobDefinitionSnapshot,
  validateLogicalReferenceDeclarations,
} from "../src/fabric/logical-references";
import type {
  DeploymentItem,
  ItemDefinition,
} from "../src/types";

const lakehouse: DeploymentItem = {
  logicalId: "bronze",
  type: "Lakehouse",
  path: "items/bronze",
};
const environment: DeploymentItem = {
  logicalId: "sparkEnvironment",
  type: "Environment",
  path: "items/environment",
};
const sparkJob: DeploymentItem = {
  logicalId: "job",
  type: "SparkJobDefinition",
  path: "items/job",
  dependsOn: ["bronze", "sparkEnvironment"],
};
const itemGraph = [lakehouse, environment, sparkJob];

function validate(
  definition: Pick<ItemDefinition, "references" | "bindings">,
  item: DeploymentItem = sparkJob,
  graph: readonly DeploymentItem[] = itemGraph,
) {
  return validateLogicalReferenceDeclarations({
    item,
    definition,
    itemGraph: graph,
  });
}

function snapshot(
  config: unknown = {
    executableFile: "main.py",
    language: "Python",
    untouched: {
      zeta: 2,
      alpha: 1,
    },
  },
): FabricDefinition {
  return {
    format: "SparkJobDefinitionV2",
    parts: [
      {
        path: "Main/main.py",
        payload: Buffer.from("print('ok')\n").toString("base64"),
        payloadType: "InlineBase64",
      },
      {
        path: "SparkJobDefinitionV1.json",
        payload: Buffer.from(JSON.stringify(config), "utf8").toString(
          "base64",
        ),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function readConfig(definition: FabricDefinition): Record<string, unknown> {
  const part = definition.parts.find(
    (candidate) =>
      candidate.path === "SparkJobDefinitionV1.json",
  );
  return JSON.parse(
    Buffer.from(part?.payload ?? "", "base64").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("logical reference declarations", () => {
  it("canonicalizes both supported reference sugars", () => {
    expect(
      validate({
        references: {
          environment: "sparkEnvironment",
          defaultLakehouse: "bronze",
        },
      }),
    ).toEqual({
      "/properties/defaultLakehouseArtifactId": {
        logicalId: "bronze",
        valueFrom: "items.bronze.id",
        targetType: "Lakehouse",
      },
      "/properties/environmentArtifactId": {
        logicalId: "sparkEnvironment",
        valueFrom: "items.sparkEnvironment.id",
        targetType: "Environment",
      },
    });
  });

  it("accepts canonical and legacy scalar binding sources", () => {
    expect(
      validate({
        bindings: [
          {
            target: "/properties/defaultLakehouseArtifactId",
            valueFrom: "item.bronze.id",
          },
          {
            target: "/properties/environmentArtifactId",
            valueFrom: "items.sparkEnvironment.id",
          },
        ],
      }),
    ).toEqual(
      validate({
        references: {
          defaultLakehouse: "bronze",
          environment: "sparkEnvironment",
        },
      }),
    );
  });

  it.each([
    ["Notebook", "Notebook"],
    ["DataPipeline", "DataPipeline"],
    ["SemanticModel", "SemanticModel"],
    ["Environment", "Environment"],
  ] as const)(
    "rejects declarations on unsupported %s items",
    (_label, type) => {
      const item: DeploymentItem = {
        logicalId: "unsupported",
        type,
        path: "items/unsupported",
        dependsOn: ["bronze"],
      };
      expect(() =>
        validate(
          { references: { defaultLakehouse: "bronze" } },
          item,
          [lakehouse, item],
        ),
      ).toThrow("does not support logical references or bindings");
    },
  );

  it("rejects wrong target types and missing dependencies", () => {
    expect(() =>
      validate({
        references: { defaultLakehouse: "sparkEnvironment" },
      }),
    ).toThrow("requires type 'Lakehouse'");

    const jobWithoutDependency = { ...sparkJob, dependsOn: [] };
    expect(() =>
      validate(
        { references: { defaultLakehouse: "bronze" } },
        jobWithoutDependency,
        [lakehouse, environment, jobWithoutDependency],
      ),
    ).toThrow("dependsOn does not include it");
  });

  it("rejects unknown names, paths, sources, and logical IDs", () => {
    expect(() =>
      validate({ references: { notebook: "bronze" } }),
    ).toThrow("unsupported logical reference 'notebook'");
    expect(() =>
      validate({
        bindings: [
          {
            target: "/properties/unknown",
            valueFrom: "items.bronze.id",
          },
        ],
      }),
    ).toThrow("unsupported binding target");
    expect(() =>
      validate({
        bindings: [
          {
            target: "/properties/defaultLakehouseArtifactId",
            valueFrom: "parameters.bronze",
          },
        ],
      }),
    ).toThrow("expected 'items.<logicalId>.id'");
    expect(() =>
      validate({
        references: { defaultLakehouse: "missing" },
      }),
    ).toThrow("unknown logicalId 'missing'");
  });

  it("rejects duplicate and conflicting declarations", () => {
    expect(() =>
      validate({
        references: { defaultLakehouse: "bronze" },
        bindings: [
          {
            target: "/properties/defaultLakehouseArtifactId",
            valueFrom: "items.bronze.id",
          },
        ],
      }),
    ).toThrow("declares '/properties/defaultLakehouseArtifactId' more than once");

    expect(() =>
      validate({
        bindings: [
          {
            target: "/properties/environmentArtifactId",
            valueFrom: "items.sparkEnvironment.id",
          },
          {
            target: "/properties/environmentArtifactId",
            valueFrom: "items.sparkEnvironment.id",
          },
        ],
      }),
    ).toThrow("declares '/properties/environmentArtifactId' more than once");
  });
});

describe("Spark Job logical reference materialization", () => {
  it("clones the snapshot and updates only allowlisted fields", () => {
    const source = snapshot({
      executableFile: "main.py",
      defaultLakehouseArtifactId: "old-lakehouse",
      environmentArtifactId: null,
      untouched: { zeta: 2, alpha: 1 },
    });
    const sourceBytes = JSON.stringify(source);
    const bindings = validate({
      references: {
        defaultLakehouse: "bronze",
        environment: "sparkEnvironment",
      },
    });

    const materialized = materializeSparkJobDefinitionSnapshot(
      source,
      bindings,
      {
        bronze: "lakehouse-physical-id",
        sparkEnvironment: "environment-physical-id",
      },
    );

    expect(materialized).not.toBe(source);
    expect(materialized.parts).not.toBe(source.parts);
    expect(materialized.parts[0]).not.toBe(source.parts[0]);
    expect(JSON.stringify(source)).toBe(sourceBytes);
    expect(readConfig(materialized)).toEqual({
      defaultLakehouseArtifactId: "lakehouse-physical-id",
      environmentArtifactId: "environment-physical-id",
      executableFile: "main.py",
      untouched: { alpha: 1, zeta: 2 },
    });
  });

  it("produces deterministic bytes and hashes", () => {
    const bindings = validate({
      references: {
        environment: "sparkEnvironment",
        defaultLakehouse: "bronze",
      },
    });
    const first = materializeSparkJobDefinitionSnapshot(
      snapshot({
        zeta: { second: 2, first: 1 },
        alpha: true,
      }),
      bindings,
      {
        sparkEnvironment: "environment-id",
        bronze: "lakehouse-id",
      },
    );
    const secondSource = snapshot({
      alpha: true,
      zeta: { first: 1, second: 2 },
    });
    secondSource.parts.reverse();
    const second = materializeSparkJobDefinitionSnapshot(
      secondSource,
      bindings,
      {
        bronze: "lakehouse-id",
        sparkEnvironment: "environment-id",
      },
    );

    expect(first).toEqual(second);
    expect(hashMaterializedSparkJobDefinition(first)).toBe(
      hashMaterializedSparkJobDefinition(second),
    );
  });

  it("rejects missing physical IDs", () => {
    expect(() =>
      materializeSparkJobDefinitionSnapshot(
        snapshot(),
        validate({
          references: { defaultLakehouse: "bronze" },
        }),
        {},
      ),
    ).toThrow("Physical ID is missing for logicalId 'bronze'");
  });

  it("materializes a staged JAR executable URI", () => {
    const materialized = materializeSparkJobDefinitionSnapshot(
      snapshot({
        executableFile: "app.jar",
        additionalLibraryUris: [],
        language: "Scala/Java",
        mainClass: "com.example.Main",
      }),
      validate({
        references: { defaultLakehouse: "bronze" },
      }),
      { bronze: "lakehouse-id" },
      [
        {
          kind: "executable",
          fileName: "app.jar",
          contentHash: "a".repeat(64),
          abfssUri:
            "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/.fabric-deploy/app.jar",
        },
      ],
    );

    expect(readConfig(materialized)).toMatchObject({
      defaultLakehouseArtifactId: "lakehouse-id",
      executableFile:
        "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/.fabric-deploy/app.jar",
      additionalLibraryUris: [],
    });
  });

  it("rejects staged artifacts missing from the Spark configuration", () => {
    expect(() =>
      materializeSparkJobDefinitionSnapshot(
        snapshot({
          executableFile: "other.jar",
          additionalLibraryUris: [],
          language: "Scala/Java",
          mainClass: "com.example.Main",
        }),
        validate({
          references: { defaultLakehouse: "bronze" },
        }),
        { bronze: "lakehouse-id" },
        [
          {
            kind: "executable",
            fileName: "app.jar",
            contentHash: "a".repeat(64),
            abfssUri:
              "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/app.jar",
          },
        ],
      ),
    ).toThrow("missing from executableFile");
  });

  it.each([
    ["not base64!", "canonical base64"],
    [
      Buffer.from("not json", "utf8").toString("base64"),
      "valid JSON",
    ],
    [
      Buffer.from("[]", "utf8").toString("base64"),
      "JSON object",
    ],
  ])("rejects malformed configuration payloads", (payload, message) => {
    const malformed = snapshot();
    malformed.parts[1] = {
      ...malformed.parts[1]!,
      payload,
    };

    expect(() =>
      materializeSparkJobDefinitionSnapshot(malformed, {}, {}),
    ).toThrow(message);
  });
});
