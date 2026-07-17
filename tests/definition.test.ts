import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
  getFabricDeploymentMarker,
  hashFabricDefinition,
  loadEnvironmentDefinition,
  withFabricDeploymentMarker,
} from "../src/fabric/definition";

function createItem(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-environment-"));
  const definition = path.join(root, "definition");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(definition, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }
  return root;
}

describe("Fabric definition parts", () => {
  it("maps the short Environment YAML paths to Fabric definition paths", () => {
    const itemDirectory = createItem({
      "environment.yml": "dependencies: []\n",
      "Sparkcompute.yml": "runtime_version: '1.3'\n",
    });

    const definition = loadEnvironmentDefinition(itemDirectory);

    expect(definition.parts.map((part) => part.path)).toEqual([
      "Libraries/PublicLibraries/environment.yml",
      "Setting/Sparkcompute.yml",
    ]);
    expect(
      Buffer.from(definition.parts[0]!.payload, "base64").toString("utf8"),
    ).toBe("dependencies: []\n");
  });

  it("rejects unsupported Environment definition paths", () => {
    const itemDirectory = createItem({
      "unsupported.txt": "nope",
    });

    expect(() => loadEnvironmentDefinition(itemDirectory)).toThrow(
      "Unsupported Environment definition path",
    );
  });

  it("ignores generated platform metadata unless it is managed", () => {
    const payload = Buffer.from("dependencies: []\n").toString("base64");
    const desired = {
      parts: [
        {
          path: "Libraries/PublicLibraries/environment.yml",
          payload,
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const actual = {
      parts: [
        ...desired.parts,
        {
          path: ".platform",
          payload: Buffer.from("{}").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ],
    };

    expect(hashFabricDefinition(actual, false)).toBe(
      hashFabricDefinition(desired, false),
    );
    expect(hashFabricDefinition(actual, true)).not.toBe(
      hashFabricDefinition(desired, true),
    );
  });

  it("hashes YAML semantically and can ignore generated Spark settings", () => {
    const desired = {
      parts: [
        {
          path: "Libraries/PublicLibraries/environment.yml",
          payload: Buffer.from("dependencies: []\n").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ],
    };
    const actual = {
      parts: [
        {
          path: "Libraries/PublicLibraries/environment.yml",
          payload: Buffer.from(
            "# generated formatting\r\ndependencies: []\r\n",
          ).toString("base64"),
          payloadType: "InlineBase64" as const,
        },
        {
          path: "Setting/Sparkcompute.yml",
          payload: Buffer.from("runtime_version: 1.3\r\n").toString("base64"),
          payloadType: "InlineBase64" as const,
        },
      ],
    };

    expect(hashFabricDefinition(actual, false, false)).toBe(
      hashFabricDefinition(desired, false),
    );
  });

  it("injects a published definition marker without changing the managed hash", () => {
    const definition = loadEnvironmentDefinition(
      createItem({
        "environment.yml": "dependencies: []\n",
        "Sparkcompute.yml": `
enable_native_execution_engine: false
driver_cores: 8
driver_memory: 56g
executor_cores: 8
executor_memory: 56g
dynamic_executor_allocation:
  enabled: true
  min_executors: 1
  max_executors: 8
runtime_version: 1.3
`,
      }),
    );

    const marked = withFabricDeploymentMarker(definition);
    const sparkPart = marked.parts.find(
      (part) => part.path === "Setting/Sparkcompute.yml",
    );
    const sparkYaml = Buffer.from(
      sparkPart?.payload ?? "",
      "base64",
    ).toString("utf8");

    expect(sparkYaml).toContain(
      `${FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY}: ${getFabricDeploymentMarker(
        definition,
      )}`,
    );
    expect(hashFabricDefinition(marked, false)).toBe(
      hashFabricDefinition(definition, false),
    );
  });

  it("requires Spark settings when custom libraries need publication proof", () => {
    const itemDirectory = createItem({
      "environment.yml": "dependencies: []\n",
      "libraries/customlibraries/library.py": "print('ok')\n",
    });

    expect(() => loadEnvironmentDefinition(itemDirectory)).toThrow(
      "custom libraries must include definition/Sparkcompute.yml",
    );
  });
});
