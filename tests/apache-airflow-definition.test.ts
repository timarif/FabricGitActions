import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { FabricDefinition } from "../src/fabric/definition";
import {
  APACHE_AIRFLOW_DEFINITION_PATH,
  APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES,
  hashApacheAirflowDefinition,
  isUntouchedApacheAirflowShellDefinition,
  loadApacheAirflowBundle,
} from "../src/fabric/apache-airflow-definition";

function fixture(): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-airflow-definition-"),
  );
  const itemDirectory = path.join(root, "airflow");
  mkdirSync(path.join(itemDirectory, "definition", "dags"), {
    recursive: true,
  });
  mkdirSync(path.join(itemDirectory, "definition", "plugins"), {
    recursive: true,
  });
  writeFileSync(
    path.join(
      itemDirectory,
      "definition",
      APACHE_AIRFLOW_DEFINITION_PATH,
    ),
    JSON.stringify({
      properties: {
        type: "Airflow",
        typeProperties: {
          airflowProperties: {
            airflowVersion: "2.10.5",
            pythonVersion: "3.12",
            airflowRequirements: [],
          },
          computeProperties: {
            computePool: "StarterPool",
            computeSize: "Small",
          },
        },
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", ".platform"),
    JSON.stringify({
      metadata: {
        type: "ApacheAirflowJob",
        displayName: "HelloAirflow",
      },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(itemDirectory, "definition", "dags", "hello.py"),
    "print('hello')\n",
    "utf8",
  );
  writeFileSync(
    path.join(
      itemDirectory,
      "definition",
      "plugins",
      "helper.py",
    ),
    "VALUE = 1\n",
    "utf8",
  );
  return itemDirectory;
}

describe("Apache Airflow definitions", () => {
  it("separates the public definition from DAG and plugin files", () => {
    const bundle = loadApacheAirflowBundle(fixture());

    expect(bundle.definition.format).toBeUndefined();
    expect(bundle.definition.parts.map((part) => part.path)).toEqual([
      ".platform",
      APACHE_AIRFLOW_DEFINITION_PATH,
    ]);
    expect(bundle.files).toEqual([
      expect.objectContaining({
        filePath: "dags/hello.py",
        sizeBytes: 15,
      }),
      expect.objectContaining({
        filePath: "plugins/helper.py",
        sizeBytes: 10,
      }),
    ]);
  });

  it("hashes JSON semantically and ignores generated schema and platform config", () => {
    const desired = loadApacheAirflowBundle(fixture()).definition;
    const main = JSON.parse(
      Buffer.from(
        desired.parts.find(
          (part) => part.path === APACHE_AIRFLOW_DEFINITION_PATH,
        )!.payload,
        "base64",
      ).toString("utf8"),
    ) as Record<string, unknown>;
    const observed: FabricDefinition = {
      parts: [
        {
          path: APACHE_AIRFLOW_DEFINITION_PATH,
          payload: Buffer.from(
            JSON.stringify({
              $schema: "https://example.invalid/schema.json",
              ...main,
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              config: {
                logicalId:
                  "11111111-1111-4111-8111-111111111111",
              },
              metadata: {
                displayName: "HelloAirflow",
                type: "ApacheAirflowJob",
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(hashApacheAirflowDefinition(observed, true)).toBe(
      hashApacheAirflowDefinition(desired, true),
    );
  });

  it("recognizes the untouched shell returned by Fabric", () => {
    const definition: FabricDefinition = {
      parts: [
        {
          path: APACHE_AIRFLOW_DEFINITION_PATH,
          payload: Buffer.from(
            JSON.stringify({
              properties: {
                type: "Airflow",
                typeProperties: {
                  airflowProperties: {
                    airflowConfigurationOverrides: {},
                    airflowEnvironment: "FabricAirflowJob-1.0.0",
                    airflowEnvironmentVariables: {},
                    airflowRequirements: [],
                    airflowVersion: "2.10.5",
                    enableAADIntegration: true,
                    enableTriggerers: false,
                    pythonVersion: "3.12",
                  },
                  computeProperties: {
                    computePool: "StarterPool",
                    computeSize: "Small",
                    enableAutoscale: false,
                    enableAvailabilityZones: true,
                    extraNodes: 0,
                    poolId:
                      "00000000-0000-0000-0000-000000000000",
                    poolName: "Starter Pool (Auto Pausing)",
                    vnetEnabled: false,
                  },
                },
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    expect(isUntouchedApacheAirflowShellDefinition(definition)).toBe(
      true,
    );
  });

  it("rejects unsupported paths, reserved ownership state, and oversized files", () => {
    const unsupported = fixture();
    writeFileSync(
      path.join(unsupported, "definition", "notes.txt"),
      "unsupported",
      "utf8",
    );
    expect(() => loadApacheAirflowBundle(unsupported)).toThrow(
      "must be a relative path under dags/ or plugins/",
    );

    const reserved = fixture();
    writeFileSync(
      path.join(
        reserved,
        "definition",
        "plugins",
        "fabric-deploy-manifest.json",
      ),
      "{}",
      "utf8",
    );
    expect(() => loadApacheAirflowBundle(reserved)).toThrow(
      "reserved for Fabric Deploy ownership state",
    );

    const oversized = fixture();
    writeFileSync(
      path.join(oversized, "definition", "dags", "large.py"),
      Buffer.alloc(APACHE_AIRFLOW_MAX_FILE_SIZE_BYTES + 1, 65),
    );
    expect(() => loadApacheAirflowBundle(oversized)).toThrow(
      "exceeds the 2 MB Fabric file limit",
    );
  });
});
