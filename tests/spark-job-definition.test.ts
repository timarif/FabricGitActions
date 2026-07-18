import {
  mkdirSync,
  mkdtempSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import { MAX_ONELAKE_SINGLE_UPLOAD_BYTES } from "../src/fabric/onelake-artifacts";
import {
  hashSparkJobDefinition,
  loadSparkJobDefinition,
  loadSparkJobDefinitionBundle,
  sparkJobDefinitionFormat,
} from "../src/fabric/spark-job-definition";

function sparkJobDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-spark-job-"));
  const itemDirectory = path.join(root, "spark-job");
  mkdirSync(path.join(itemDirectory, "definition"), { recursive: true });
  return itemDirectory;
}

function createSparkJob(files: Record<string, string>): string {
  const itemDirectory = sparkJobDirectory();
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(
      itemDirectory,
      "definition",
      relativePath,
    );
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  return itemDirectory;
}

describe("Spark Job definitions", () => {
  it("builds a V2 definition from an inline Python main file", () => {
    const itemDirectory = sparkJobDirectory();
    writeFileSync(
      path.join(itemDirectory, "definition", "main.py"),
      "print('hello')\n",
      "utf8",
    );

    const definition = loadSparkJobDefinition(itemDirectory);

    expect(definition.format).toBe("SparkJobDefinitionV2");
    expect(definition.parts.map((part) => part.path)).toEqual([
      "Main/main.py",
      "SparkJobDefinitionV1.json",
    ]);
    const configPart = definition.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    expect(
      JSON.parse(
        Buffer.from(
          configPart?.payload ?? "",
          "base64",
        ).toString("utf8"),
      ),
    ).toMatchObject({
      executableFile: "main.py",
      language: "Python",
      additionalLibraryUris: [],
      environmentArtifactId: null,
    });
  });

  it("maps libraries and optional platform metadata", () => {
    const itemDirectory = sparkJobDirectory();
    const definitionDirectory = path.join(
      itemDirectory,
      "definition",
    );
    mkdirSync(path.join(definitionDirectory, "libs"), {
      recursive: true,
    });
    writeFileSync(
      path.join(definitionDirectory, "main.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(definitionDirectory, "libs", "helper.py"),
      "VALUE = 1\n",
      "utf8",
    );
    writeFileSync(
      path.join(definitionDirectory, ".platform"),
      JSON.stringify({
        metadata: {
          type: "SparkJobDefinition",
          displayName: "Hello",
          description: "",
        },
      }),
      "utf8",
    );

    const definition = loadSparkJobDefinition(itemDirectory);

    expect(definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      "Libs/helper.py",
      "Main/main.py",
      "SparkJobDefinitionV1.json",
    ]);
  });

  it("orders generated library references deterministically", () => {
    const first = loadSparkJobDefinition(
      createSparkJob({
        "main.py": "print('hello')\n",
        "libs/zeta.py": "ZETA = 1\n",
        "libs/alpha.py": "ALPHA = 1\n",
      }),
    );
    const second = loadSparkJobDefinition(
      createSparkJob({
        "main.py": "print('hello')\n",
        "libs/alpha.py": "ALPHA = 1\n",
        "libs/zeta.py": "ZETA = 1\n",
      }),
    );
    const config = first.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );

    expect(
      JSON.parse(
        Buffer.from(
          config?.payload ?? "",
          "base64",
        ).toString("utf8"),
      ).additionalLibraryUris,
    ).toEqual(["alpha.py", "zeta.py"]);
    expect(hashSparkJobDefinition(first, false)).toBe(
      hashSparkJobDefinition(second, false),
    );
  });

  it("preserves explicit external library and runtime settings", () => {
    const itemDirectory = sparkJobDirectory();
    const definitionDirectory = path.join(
      itemDirectory,
      "definition",
    );
    writeFileSync(
      path.join(definitionDirectory, "main.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(
        definitionDirectory,
        "SparkJobDefinitionV1.json",
      ),
      JSON.stringify({
        executableFile: "main.py",
        defaultLakehouseArtifactId: "lakehouse-id",
        commandLineArguments: "--date 2026-07-17",
        additionalLibraryUris: [
          "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/helper.py",
        ],
        language: "Python",
        environmentArtifactId: "environment-id",
      }),
      "utf8",
    );

    const definition = loadSparkJobDefinition(itemDirectory);
    const config = definition.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    expect(
      JSON.parse(
        Buffer.from(
          config?.payload ?? "",
          "base64",
        ).toString("utf8"),
      ),
    ).toMatchObject({
      defaultLakehouseArtifactId: "lakehouse-id",
      commandLineArguments: "--date 2026-07-17",
      environmentArtifactId: "environment-id",
    });
  });

  it("hashes text and JSON semantically", () => {
    const first: FabricDefinition = {
      format: "SparkJobDefinitionV2",
      parts: [
        {
          path: "SparkJobDefinitionV1.json",
          payload: Buffer.from(
            '{"language":"Python","executableFile":"main.py"}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "Main/main.py",
          payload: Buffer.from("print('hello')\r\n").toString(
            "base64",
          ),
          payloadType: "InlineBase64",
        },
      ],
    };
    const second: FabricDefinition = {
      parts: [
        {
          path: "Main/main.py",
          payload: Buffer.from("print('hello')\n").toString(
            "base64",
          ),
          payloadType: "InlineBase64",
        },
        {
          path: "SparkJobDefinitionV1.json",
          payload: Buffer.from(
            '{\n  "executableFile": "main.py",\n  "language": "Python"\n}',
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(hashSparkJobDefinition(first, false)).toBe(
      hashSparkJobDefinition(second, false),
    );
  });

  it("treats Fabric null and source empty Lakehouse IDs as equivalent", () => {
    const first = loadSparkJobDefinition(
      createSparkJob({
        "main.py": "print('hello')\n",
      }),
    );
    const configPart = first.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    const config = JSON.parse(
      Buffer.from(
        configPart?.payload ?? "",
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    config.defaultLakehouseArtifactId = null;
    const second: FabricDefinition = {
      ...first,
      parts: first.parts.map((part) =>
        part.path === "SparkJobDefinitionV1.json"
          ? {
              ...part,
              payload: Buffer.from(JSON.stringify(config)).toString(
                "base64",
              ),
            }
          : part,
      ),
    };

    expect(hashSparkJobDefinition(first, false)).toBe(
      hashSparkJobDefinition(second, false),
    );
  });

  it("allows an external executable definition", () => {
    const external: FabricDefinition = {
      format: "SparkJobDefinitionV2",
      parts: [
        {
          path: "SparkJobDefinitionV1.json",
          payload: Buffer.from(
            JSON.stringify({
              executableFile:
                "abfss://workspace@onelake.dfs.fabric.microsoft.com/lakehouse/Files/jobs/main.py",
              language: "Python",
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(() =>
      hashSparkJobDefinition(external, false),
    ).not.toThrow();
    expect(() =>
      hashSparkJobDefinition(external, false, {
        allowExternalExecutable: true,
      }),
    ).not.toThrow();
  });

  it("captures a JVM executable and JAR libraries for external staging", () => {
    const itemDirectory = sparkJobDirectory();
    const definitionDirectory = path.join(
      itemDirectory,
      "definition",
    );
    mkdirSync(path.join(definitionDirectory, "libs"), {
      recursive: true,
    });

    writeFileSync(
      path.join(definitionDirectory, "main.jar"),
      "main-jar",
      "utf8",
    );
    writeFileSync(
      path.join(definitionDirectory, "libs", "helper.jar"),
      "helper-jar",
      "utf8",
    );
    writeFileSync(
      path.join(
        definitionDirectory,
        "SparkJobDefinitionV1.json",
      ),
      JSON.stringify({
        executableFile: "main.jar",
        language: "Scala/Java",
        mainClass: "com.example.Main",
      }),
      "utf8",
    );

    const bundle = loadSparkJobDefinitionBundle(itemDirectory);
    const configPart = bundle.definition.parts.find(
      (part) => part.path === "SparkJobDefinitionV1.json",
    );
    expect(bundle.artifacts).toEqual([
      expect.objectContaining({
        kind: "library",
        fileName: "helper.jar",
        relativePath: "definition/libs/helper.jar",
        sizeBytes: 10,
      }),
      expect.objectContaining({
        kind: "executable",
        fileName: "main.jar",
        relativePath: "definition/main.jar",
        sizeBytes: 8,
      }),
    ]);
    expect(sparkJobDefinitionFormat(bundle.definition)).toBe(
      "SparkJobDefinitionV2",
    );
    expect(bundle.definition.parts.map((part) => part.path)).toEqual([
      "SparkJobDefinitionV1.json",
    ]);
    expect(
      JSON.parse(
        Buffer.from(configPart?.payload ?? "", "base64").toString(
          "utf8",
        ),
      ),
    ).toMatchObject({
      executableFile: "main.jar",
      additionalLibraryUris: ["helper.jar"],
      language: "Scala/Java",
      mainClass: "com.example.Main",
    });
  });

  it("rejects staged JARs above the single-upload limit", () => {
    const itemDirectory = sparkJobDirectory();
    const definitionDirectory = path.join(
      itemDirectory,
      "definition",
    );
    mkdirSync(path.join(definitionDirectory, "libs"), {
      recursive: true,
    });
    writeFileSync(
      path.join(definitionDirectory, "main.jar"),
      "main-jar",
      "utf8",
    );
    writeFileSync(
      path.join(
        definitionDirectory,
        "SparkJobDefinitionV1.json",
      ),
      JSON.stringify({
        executableFile: "main.jar",
        language: "Scala/Java",
        mainClass: "com.example.Main",
      }),
      "utf8",
    );
    const jarPath = path.join(
      definitionDirectory,
      "libs",
      "large.jar",
    );
    writeFileSync(jarPath, "");
    truncateSync(jarPath, MAX_ONELAKE_SINGLE_UPLOAD_BYTES + 1);

    expect(() =>
      loadSparkJobDefinitionBundle(itemDirectory),
    ).toThrow("exceeds the 512 MiB");
  });

  it("rejects unsafe executable replacement", () => {
    const secondItemDirectory = sparkJobDirectory();
    const secondDefinitionDirectory = path.join(
      secondItemDirectory,
      "definition",
    );

    writeFileSync(
      path.join(secondDefinitionDirectory, "main.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(
        secondDefinitionDirectory,
        "SparkJobDefinitionV1.json",
      ),
      JSON.stringify({
        executableFile: "different.py",
      }),
      "utf8",
    );

    expect(() =>
      loadSparkJobDefinition(secondItemDirectory),
    ).toThrow("executableFile must be 'main.py'");
  });

  it("rejects JAR libraries on Python Spark Jobs", () => {
    expect(() =>
      loadSparkJobDefinitionBundle(
        createSparkJob({
          "main.py": "print('hello')\n",
          "libs/helper.jar": "jar",
        }),
      ),
    ).toThrow("Fabric rejects JAR libraries for Python jobs");
  });

  it("rejects inline library names unsupported by Fabric", () => {
    expect(() =>
      loadSparkJobDefinition(
        createSparkJob({
          "main.py": "print('hello')\n",
          "libs/shared helper.py": "VALUE = 1\n",
        }),
      ),
    ).toThrow("library file names contain unsupported characters");
  });
});
