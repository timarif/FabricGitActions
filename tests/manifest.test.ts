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
        LAKEHOUSE_NAME: "Bronze Dev",
      },
    });
    const second = loadManifest(manifestPath, {
      variables: {
        FABRIC_WORKSPACE_ID: "workspace-1",
        LAKEHOUSE_NAME: "Bronze Prod",
      },
    });

    expect(first.itemContentHashes.bronze).not.toBe(
      second.itemContentHashes.bronze,
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
