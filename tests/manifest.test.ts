import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadManifest,
  loadManifestItemDirectoriesForSafety,
  loadNetworkProtectionManifest,
} from "../src/manifest";
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
  it("does not include malformed requestMessage source text in YAML diagnostics", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = path.join(root, "deployment.yaml");
    const requestMessage = "do-not-print-this";
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: malformed-request-message
workspace:
  id: 11111111-1111-4111-8111-111111111111
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  managedPrivateEndpoints:
    - name: storage
      targetPrivateLinkResourceId: /subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage
      requestMessage: "${requestMessage}\\q"
items: []
`,
      "utf8",
    );

    for (const load of [
      () => loadManifestItemDirectoriesForSafety(manifestPath),
      () => loadNetworkProtectionManifest(manifestPath),
      () => loadManifest(manifestPath),
    ]) {
      let error: unknown;
      try {
        load();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(
        requestMessage,
      );
      expect((error as Error).message).toContain(
        "Invalid escape sequence",
      );
    }
  });

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
  displayName: Fabric Deploy Analytics
  description: Managed workspace
  capacityId: capacity-1
items: []
`,
      "utf8",
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.manifest.workspace).toEqual({
      displayName: "Fabric Deploy Analytics",
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

  it("rejects duplicate desired Eventhouse identities", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: eventhouse-identities
workspace:
  id: workspace-1
items:
  - logicalId: firstEventhouse
    type: Eventhouse
    path: items/eventhouses/first
  - logicalId: secondEventhouse
    type: Eventhouse
    path: items/eventhouses/second
`,
      [
        "items/eventhouses/first",
        "items/eventhouses/second",
      ],
    );
    for (const name of ["first", "second"]) {
      writeFileSync(
        path.join(
          root,
          "items/eventhouses",
          name,
          "item.yaml",
        ),
        "displayName: Shared-Eventhouse\n",
        "utf8",
      );
    }

    expect(() => loadManifest(manifestPath)).toThrow(
      "Eventhouse items 'firstEventhouse' and 'secondEventhouse' resolve to the same folder and displayName",
    );
  });

  it("rejects duplicate desired KQL Database identities", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: kql-database-identities
workspace:
  id: workspace-1
items:
  - logicalId: eventhouse
    type: Eventhouse
    path: items/eventhouse
  - logicalId: firstDatabase
    type: KQLDatabase
    path: items/databases/first
    dependsOn: [eventhouse]
  - logicalId: secondDatabase
    type: KQLDatabase
    path: items/databases/second
    dependsOn: [eventhouse]
`,
      [
        "items/eventhouse",
        "items/databases/first",
        "items/databases/second",
      ],
    );
    writeFileSync(
      path.join(root, "items/eventhouse/item.yaml"),
      "displayName: ParentEventhouse\n",
      "utf8",
    );
    for (const name of ["first", "second"]) {
      writeFileSync(
        path.join(
          root,
          "items/databases",
          name,
          "item.yaml",
        ),
        "displayName: Shared-Database\nreferences:\n  eventhouse: eventhouse\n",
        "utf8",
      );
    }

    expect(() => loadManifest(manifestPath)).toThrow(
      "KQLDatabase items 'firstDatabase' and 'secondDatabase' resolve to the same folder and displayName",
    );
  });

  it("rejects duplicate desired Warehouse identities", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: warehouse-identities
workspace:
  id: workspace-1
items:
  - logicalId: firstWarehouse
    type: Warehouse
    path: items/warehouses/first
  - logicalId: secondWarehouse
    type: Warehouse
    path: items/warehouses/second
`,
      [
        "items/warehouses/first",
        "items/warehouses/second",
      ],
    );
    for (const name of ["first", "second"]) {
      writeFileSync(
        path.join(root, "items/warehouses", name, "item.yaml"),
        "displayName: Shared-Warehouse\n",
        "utf8",
      );
    }

    expect(() => loadManifest(manifestPath)).toThrow(
      "Warehouse items 'firstWarehouse' and 'secondWarehouse' resolve to the same folder and displayName",
    );
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

  it("loads minimal supported deletion items without workload definitions", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const itemDirectory = path.join(root, "items", "notebooks", "old");
    mkdirSync(itemDirectory, { recursive: true });
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      "displayName: Old Notebook\ndesiredState: absent\n",
      "utf8",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: delete-notebook
workspace:
  id: workspace-1
items:
  - logicalId: oldNotebook
    type: Notebook
    path: items/notebooks/old
    desiredState: absent
`,
      "utf8",
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.itemDefinitions.oldNotebook).toEqual({
      displayName: "Old Notebook",
      desiredState: "absent",
    });
    expect(loaded.notebookDefinitions).toEqual({});
  });

  it("requires deletion intent in both the manifest and item definition", () => {
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
    ).toThrow("does not match deployment manifest desiredState");
  });

  it("loads Lakehouse deletion intent for separately safeguarded apply", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    const manifestPath = createFixture(
      root,
      VALID_MANIFEST.replace(
        "    path: items/lakehouses/bronze",
        "    path: items/lakehouses/bronze\n    desiredState: absent",
      ),
    );
    writeFileSync(
      path.join(root, "items/lakehouses/bronze/item.yaml"),
      "displayName: bronze\ndesiredState: absent\n",
      "utf8",
    );

    const loaded = loadManifest(manifestPath, {
      variables: { FABRIC_WORKSPACE_ID: "workspace-1" },
    });

    expect(loaded.itemDefinitions.bronze).toEqual({
      displayName: "bronze",
      desiredState: "absent",
    });
  });

  it("rejects present items that depend on absent items", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-"));
    for (const [directory, content] of [
      [
        "items/notebooks/old",
        "displayName: Old Notebook\ndesiredState: absent\n",
      ],
      ["items/notebooks/current", "displayName: Current Notebook\n"],
    ] as const) {
      mkdirSync(path.join(root, directory), { recursive: true });
      writeFileSync(
        path.join(root, directory, "item.yaml"),
        content,
        "utf8",
      );
    }
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: invalid-delete-dependency
workspace:
  id: workspace-1
items:
  - logicalId: oldNotebook
    type: Notebook
    path: items/notebooks/old
    desiredState: absent
  - logicalId: currentNotebook
    type: Notebook
    path: items/notebooks/current
    dependsOn: [oldNotebook]
`,
      "utf8",
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Present item 'currentNotebook' cannot depend on absent item 'oldNotebook'",
    );
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

// ---------------------------------------------------------------------------
// DataAgent duplicate identity validation (item 4 regression tests)
// ---------------------------------------------------------------------------

describe("DataAgent duplicate identity detection", () => {
  const ROOT_SCHEMA_URL =
    "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";

  function createTwoDataAgents(
    name1: string,
    name2: string,
    folder1?: string,
    folder2?: string,
  ): string {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-deploy-da-"));
    const dir1 = path.join(root, "items/agent1");
    const dir2 = path.join(root, "items/agent2");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      path.join(dir1, "item.yaml"),
      `displayName: ${name1}\n${folder1 ? `folderId: ${folder1}\n` : ""}`,
      "utf8",
    );
    writeFileSync(
      path.join(dir2, "item.yaml"),
      `displayName: ${name2}\n${folder2 ? `folderId: ${folder2}\n` : ""}`,
      "utf8",
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: da-dupe-test
workspace:
  id: workspace-1
items:
  - logicalId: agent1
    type: DataAgent
    path: items/agent1
  - logicalId: agent2
    type: DataAgent
    path: items/agent2
`,
      "utf8",
    );
    return manifestPath;
  }

  it("rejects two DataAgents with the same displayName in root folder (item 4)", () => {
    const manifestPath = createTwoDataAgents("My Agent", "My Agent");
    expect(() => loadManifest(manifestPath)).toThrow(
      /DataAgent.*resolve to the same folder and displayName/,
    );
  });

  it("allows two DataAgents with the same displayName in different folders", () => {
    const folderId1 = "11111111-1111-4111-8111-111111111111";
    const folderId2 = "22222222-2222-4222-8222-222222222222";
    const manifestPath = createTwoDataAgents(
      "My Agent",
      "My Agent",
      folderId1,
      folderId2,
    );
    expect(() => loadManifest(manifestPath)).not.toThrow();
  });

  it("allows two DataAgents with different displayNames in the same folder", () => {
    const manifestPath = createTwoDataAgents("Agent One", "Agent Two");
    expect(() => loadManifest(manifestPath)).not.toThrow();
  });
});
