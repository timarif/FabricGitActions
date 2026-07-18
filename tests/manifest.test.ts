import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";
import { substituteVariables } from "../src/substitution";
import { createFixture } from "./test-helpers";

const VALID_MANIFEST = `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: \${var.FABRIC_WORKSPACE_ID}
items:
  - logicalId: bronze
    type: Lakehouse
    path: items/lakehouses/bronze
`;

describe("manifest loading", () => {
  it("supports a workspace-only managed manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-only
workspace:
  displayName: tva-Analytics
  description: Managed workspace
  capacityId: capacity-1
items: []
`,
      "utf8",
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.manifest.workspace).toEqual({
      displayName: "tva-Analytics",
      description: "Managed workspace",
      capacityId: "capacity-1",
    });
    expect(loaded.manifest.items).toEqual([]);
  });

  it("rejects an empty deployment without a managed workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: empty
workspace:
  id: workspace-1
items: []
`,
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("rejects reserved managed workspace names", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: reserved
workspace:
  displayName: Admin monitoring
items: []
`,
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "reserved name 'Admin monitoring'",
    );
  });

  it("substitutes environment variables and validates the manifest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(root, VALID_MANIFEST);

    const loaded = loadManifest(manifestPath, {
      variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
    });

    expect(loaded.manifest.workspace?.id).toBe("workspace-1");
    expect(loaded.manifest.items[0]?.logicalId).toBe("bronze");
    expect(loaded.sourceHash).not.toBe(loaded.resolvedHash);
  });

  it("fails when a required environment variable is missing", () => {
    expect(() => substituteVariables("${var.MISSING}", {})).toThrow(
      "Required deployment variable MISSING is not set.",
    );
  });

  it("captures staged Spark Job JARs and requires a default Lakehouse binding", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = path.join(root, "deployment.yaml");
    const lakehouseDirectory = path.join(
      root,
      "items",
      "lakehouses",
      "bronze",
    );
    const sparkDirectory = path.join(
      root,
      "items",
      "spark-jobs",
      "job",
    );
    mkdirSync(
      path.join(sparkDirectory, "definition", "libs"),
      { recursive: true },
    );
    mkdirSync(lakehouseDirectory, { recursive: true });
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: staging
workspace:
  id: 11111111-1111-1111-1111-111111111111
items:
  - logicalId: bronze
    type: Lakehouse
    path: items/lakehouses/bronze
  - logicalId: sparkJob
    type: SparkJobDefinition
    path: items/spark-jobs/job
    dependsOn: [bronze]
`,
      "utf8",
    );
    writeFileSync(
      path.join(lakehouseDirectory, "item.yaml"),
      "displayName: Bronze\n",
      "utf8",
    );
    const itemPath = path.join(sparkDirectory, "item.yaml");
    writeFileSync(
      itemPath,
      "displayName: Spark\nreferences:\n  defaultLakehouse: bronze\n",
      "utf8",
    );
    writeFileSync(
      path.join(
        sparkDirectory,
        "definition",
        "SparkJobDefinitionV1.json",
      ),
      JSON.stringify({
        executableFile: "main.jar",
        language: "Scala/Java",
        mainClass: "com.example.Main",
      }),
      "utf8",
    );
    writeFileSync(
      path.join(sparkDirectory, "definition", "main.jar"),
      Buffer.from("jar"),
    );

    const loaded = loadManifest(manifestPath);
    expect(
      loaded.sparkJobArtifactSources?.sparkJob,
    ).toEqual([
      expect.objectContaining({
        kind: "executable",
        fileName: "main.jar",
        relativePath: "definition/main.jar",
        sizeBytes: 3,
      }),
    ]);

    writeFileSync(itemPath, "displayName: Spark\n", "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(
      "must declare a logical defaultLakehouse",
    );
  });

  it("rejects duplicate logical IDs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `${VALID_MANIFEST}
  - logicalId: bronze
    type: Notebook
    path: items/notebooks/duplicate
`,
      ["items/lakehouses/bronze", "items/notebooks/duplicate"],
    );

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("Duplicate logicalId 'bronze'.");
  });

  it("rejects multiple logical items using the same directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `${VALID_MANIFEST}
  - logicalId: duplicatePath
    type: Lakehouse
    path: items/lakehouses/bronze
`,
    );

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("use the same item directory");
  });

  it("rejects duplicate desired Lakehouse identities", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `${VALID_MANIFEST}
  - logicalId: duplicateLakehouse
    type: Lakehouse
    path: items/lakehouses/duplicate
`,
      [
        "items/lakehouses/bronze",
        "items/lakehouses/duplicate",
      ],
    );
    writeFileSync(
      path.join(root, "items/lakehouses/bronze/item.yaml"),
      "displayName: Shared\n",
      "utf8",
    );
    writeFileSync(
      path.join(root, "items/lakehouses/duplicate/item.yaml"),
      "displayName: Shared\n",
      "utf8",
    );

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("resolve to the same folder and displayName");
  });

  it("rejects duplicate desired Environment identities", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: firstEnvironment
    type: Environment
    path: items/environments/first
  - logicalId: secondEnvironment
    type: Environment
    path: items/environments/second
`,
      ["items/environments/first", "items/environments/second"],
    );
    for (const name of ["first", "second"]) {
      const itemDirectory = path.join(root, "items/environments", name);
      writeFileSync(
        path.join(itemDirectory, "item.yaml"),
        "displayName: Shared\n",
        "utf8",
      );
      mkdirSync(path.join(itemDirectory, "definition"));
      writeFileSync(
        path.join(itemDirectory, "definition/environment.yml"),
        "dependencies: []\n",
        "utf8",
      );
    }

    expect(() => loadManifest(manifestPath)).toThrow(
      "Environment items 'firstEnvironment' and 'secondEnvironment' resolve to the same folder and displayName",
    );
  });

  it("snapshots Environment definition bytes during manifest loading", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: environment
    type: Environment
    path: items/environment
`,
      ["items/environment"],
    );
    const itemDirectory = path.join(root, "items/environment");
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      "displayName: Spark\n",
      "utf8",
    );
    mkdirSync(path.join(itemDirectory, "definition"));
    const environmentFile = path.join(
      itemDirectory,
      "definition/environment.yml",
    );
    writeFileSync(environmentFile, "dependencies: []\n", "utf8");

    const loaded = loadManifest(manifestPath);
    writeFileSync(
      environmentFile,
      "dependencies:\n  - pip:\n      - pandas\n",
      "utf8",
    );

    const part = loaded.environmentDefinitions.environment?.parts.find(
      (entry) =>
        entry.path === "Libraries/PublicLibraries/environment.yml",
    );
    expect(Buffer.from(part?.payload ?? "", "base64").toString("utf8")).toBe(
      "dependencies: []\n",
    );
  });

  it("rejects managed Environment platform metadata that conflicts with item.yaml", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: environment
    type: Environment
    path: items/environment
`,
      ["items/environment"],
    );
    const itemDirectory = path.join(root, "items/environment");
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      "displayName: Spark\ndescription: Desired\n",
      "utf8",
    );
    mkdirSync(path.join(itemDirectory, "definition"));
    writeFileSync(
      path.join(itemDirectory, "definition/environment.yml"),
      "dependencies: []\n",
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition/.platform"),
      JSON.stringify({
        metadata: {
          type: "Environment",
          displayName: "Different",
          description: "Desired",
        },
      }),
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      ".platform displayName must match item.yaml",
    );
  });

  it("requires an explicit description when Notebook platform metadata is managed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: notebook
    type: Notebook
    path: items/notebook
`,
      ["items/notebook"],
    );
    const itemDirectory = path.join(root, "items/notebook");
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      "displayName: Hello\n",
      "utf8",
    );
    mkdirSync(path.join(itemDirectory, "definition"));
    writeFileSync(
      path.join(itemDirectory, "definition/notebook-content.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition/.platform"),
      JSON.stringify({
        metadata: {
          type: "Notebook",
          displayName: "Hello",
          description: "",
        },
      }),
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "must define item.yaml description when .platform metadata is managed",
    );
  });

  it("rejects sensitivity labels in managed platform definitions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: notebook
    type: Notebook
    path: items/notebook
`,
      ["items/notebook"],
    );
    const itemDirectory = path.join(root, "items/notebook");
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      "displayName: Hello\ndescription: Managed\n",
      "utf8",
    );
    mkdirSync(path.join(itemDirectory, "definition"));
    writeFileSync(
      path.join(itemDirectory, "definition/notebook-content.py"),
      "print('hello')\n",
      "utf8",
    );
    writeFileSync(
      path.join(itemDirectory, "definition/.platform"),
      JSON.stringify({
        metadata: {
          type: "Notebook",
          displayName: "Hello",
          description: "Managed",
          sensitivityLabelId: "11111111-1111-1111-1111-111111111111",
        },
      }),
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      ".platform sensitivity labels are not supported",
    );
  });

  it("rejects item paths outside the manifest directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      VALID_MANIFEST.replace("items/lakehouses/bronze", "../outside"),
    );

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("path escapes the manifest directory");
  });

  it("rejects deletion intent until deletion ordering is implemented", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      VALID_MANIFEST.replace(
        "    path: items/lakehouses/bronze",
        "    path: items/lakehouses/bronze\n    desiredState: absent",
      ),
    );

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("Invalid deployment manifest");
  });

  it("applies the workspace override before variable resolution", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(root, VALID_MANIFEST);

    const loaded = loadManifest(manifestPath, {
      workspaceIdOverride: "workspace-override",
    });

    expect(loaded.manifest.workspace?.id).toBe("workspace-override");
  });

  it("changes item content hashes when definition files change", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(root, VALID_MANIFEST);
    const options = {
      variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
    };
    const first = loadManifest(manifestPath, options);

    writeFileSync(
      path.join(root, "items/lakehouses/bronze/item.yaml"),
      "displayName: Changed\n",
      "utf8",
    );
    const second = loadManifest(manifestPath, options);

    expect(first.itemContentHashes.bronze).not.toBe(
      second.itemContentHashes.bronze,
    );
  });

  it("changes item content hashes when resolved item variables change", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(root, VALID_MANIFEST);
    writeFileSync(
      path.join(root, "items/lakehouses/bronze/item.yaml"),
      "displayName: ${var.LAKEHOUSE_NAME}\n",
      "utf8",
    );

    const first = loadManifest(manifestPath, {
      variables: {
        FABRIC_WORKSPACE_ID: "workspace-1",
        LAKEHOUSE_NAME: "Bronze_Dev",
      },
    });
    const second = loadManifest(manifestPath, {
      variables: {
        FABRIC_WORKSPACE_ID: "workspace-1",
        LAKEHOUSE_NAME: "Bronze_Prod",
      },
    });

    expect(first.itemContentHashes.bronze).not.toBe(
      second.itemContentHashes.bronze,
    );
  });

  it("snapshots Spark custom pool definitions during manifest loading", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: batchPool
    type: SparkCustomPool
    path: items/pools/batch
`,
      ["items/pools/batch"],
    );
    const definitionDirectory = path.join(
      root,
      "items/pools/batch/definition",
    );
    mkdirSync(definitionDirectory);
    const definitionFile = path.join(definitionDirectory, "pool.yaml");
    writeFileSync(
      definitionFile,
      `
nodeFamily: MemoryOptimized
nodeSize: Small
autoScale: { enabled: true, minNodeCount: 1, maxNodeCount: 2 }
dynamicExecutorAllocation: { enabled: true, minExecutors: 1, maxExecutors: 1 }
`,
      "utf8",
    );

    const loaded = loadManifest(manifestPath);
    writeFileSync(
      definitionFile,
      `
nodeFamily: MemoryOptimized
nodeSize: Medium
autoScale: { enabled: true, minNodeCount: 2, maxNodeCount: 4 }
dynamicExecutorAllocation: { enabled: true, minExecutors: 2, maxExecutors: 2 }
`,
      "utf8",
    );

    expect(loaded.sparkCustomPoolDefinitions.batchPool).toMatchObject({
      nodeSize: "Small",
      autoScale: { minNodeCount: 1, maxNodeCount: 2 },
    });
  });

  it("rejects case-insensitive Spark custom pool name collisions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: sample
workspace:
  id: workspace-1
items:
  - logicalId: firstPool
    type: SparkCustomPool
    path: items/pools/first
  - logicalId: secondPool
    type: SparkCustomPool
    path: items/pools/second
`,
      ["items/pools/first", "items/pools/second"],
    );
    for (const [directory, displayName] of [
      ["first", "Batch"],
      ["second", "batch"],
    ] as const) {
      const itemDirectory = path.join(root, "items/pools", directory);
      writeFileSync(
        path.join(itemDirectory, "item.yaml"),
        `displayName: ${displayName}\n`,
        "utf8",
      );
      mkdirSync(path.join(itemDirectory, "definition"));
      writeFileSync(
        path.join(itemDirectory, "definition/pool.yaml"),
        `
nodeFamily: MemoryOptimized
nodeSize: Small
autoScale: { enabled: true, minNodeCount: 1, maxNodeCount: 2 }
dynamicExecutorAllocation: { enabled: true, minExecutors: 1, maxExecutors: 1 }
`,
        "utf8",
      );
    }

    expect(() => loadManifest(manifestPath)).toThrow(
      "SparkCustomPool items 'firstPool' and 'secondPool' resolve to the same folder and displayName",
    );
  });

  it("uses unambiguous framing when hashing file paths and contents", () => {
    const firstRoot = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const secondRoot = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const firstManifest = createFixture(firstRoot, VALID_MANIFEST);
    const secondManifest = createFixture(secondRoot, VALID_MANIFEST);

    writeFileSync(
      path.join(firstRoot, "items/lakehouses/bronze/a"),
      Buffer.from("x\0b\0y"),
    );
    writeFileSync(
      path.join(secondRoot, "items/lakehouses/bronze/a"),
      Buffer.from("x"),
    );
    writeFileSync(
      path.join(secondRoot, "items/lakehouses/bronze/b"),
      Buffer.from("y"),
    );

    const options = {
      variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
    };
    const first = loadManifest(firstManifest, options);
    const second = loadManifest(secondManifest, options);

    expect(first.itemContentHashes.bronze).not.toBe(
      second.itemContentHashes.bronze,
    );
  });

  it("rejects symbolic links and junctions in item content", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const outside = mkdtempSync(path.join(tmpdir(), "fabric-outside-"));
    mkdirSync(path.join(root, "items/lakehouses/bronze"), { recursive: true });
    symlinkSync(
      outside,
      path.join(root, "items/lakehouses/bronze/external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const manifestPath = createFixture(root, VALID_MANIFEST);

    expect(() =>
      loadManifest(manifestPath, {
        variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
      }),
    ).toThrow("symbolic link or junction");
  });
});
