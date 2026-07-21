/**
 * Tests for Copy Job manifest loading and platform metadata validation.
 *
 * Tests cover:
 * - loadManifest loads copyJobDefinitions correctly
 * - validateCopyJobPlatformMetadata accepts valid .platform
 * - validateCopyJobPlatformMetadata rejects sensitivity labels in .platform
 * - manifest loads Copy Job without .platform (no-platform case)
 */

import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

function base64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const validContent = { properties: { jobMode: "Batch" } };
const validPlatform = {
  metadata: {
    type: "CopyJob",
    displayName: "MyJob",
    description: "My copy job",
  },
  config: {
    logicalId: "00000000-0000-0000-0000-000000000000",
    version: "2.0",
  },
};

function makeManifestYaml(workspaceId = "11111111-2222-3333-4444-555555555555"): string {
  return `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: copy-job-test
workspace:
  id: ${workspaceId}
items:
  - logicalId: my-copy-job
    type: CopyJob
    path: items/copy-jobs/my-job
`;
}

function makeFixture(opts?: {
  includePlatform?: boolean;
  platformObj?: object;
  contentObj?: object;
}): string {
  const root = mkdtempSync(path.join(tmpdir(), "copy-job-manifest-"));
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(manifestPath, makeManifestYaml(), "utf8");

  const itemDir = path.join(root, "items/copy-jobs/my-job");
  const defDir = path.join(itemDir, "definition");
  mkdirSync(defDir, { recursive: true });

  writeFileSync(path.join(itemDir, "item.yaml"), "displayName: MyJob\ndescription: My copy job\n", "utf8");

  const contentObj = opts?.contentObj ?? validContent;
  writeFileSync(
    path.join(defDir, "copyjob-content.json"),
    JSON.stringify(contentObj),
    "utf8",
  );

  if (opts?.includePlatform) {
    const platformObj = opts?.platformObj ?? validPlatform;
    writeFileSync(
      path.join(defDir, ".platform"),
      JSON.stringify(platformObj),
      "utf8",
    );
  }

  return manifestPath;
}

// ---------------------------------------------------------------------------
// loadManifest — CopyJob support
// ---------------------------------------------------------------------------

describe("loadManifest with CopyJob items", () => {
  it("loads a Copy Job item and populates copyJobDefinitions", () => {
    const manifestPath = makeFixture();
    const loaded = loadManifest(manifestPath);

    expect(loaded.copyJobDefinitions).toBeDefined();
    const def = loaded.copyJobDefinitions?.["my-copy-job"];
    expect(def).toBeDefined();
    expect(def!.parts).toHaveLength(1);
    expect(def!.parts[0]!.path).toBe("copyjob-content.json");
  });

  it("includes .platform part when present", () => {
    const manifestPath = makeFixture({ includePlatform: true });
    const loaded = loadManifest(manifestPath);
    const def = loaded.copyJobDefinitions?.["my-copy-job"];
    const platformPart = def?.parts.find((p) => p.path === ".platform");
    expect(platformPart).toBeDefined();
  });

  it("stores the item directory for a CopyJob item", () => {
    const manifestPath = makeFixture();
    const loaded = loadManifest(manifestPath);
    expect(loaded.itemDirectories["my-copy-job"]).toBeDefined();
  });

  it("populates itemContentHashes for a CopyJob", () => {
    const manifestPath = makeFixture();
    const loaded = loadManifest(manifestPath);
    expect(loaded.itemContentHashes["my-copy-job"]).toBeDefined();
    expect(loaded.itemContentHashes["my-copy-job"]).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Platform metadata validation
// ---------------------------------------------------------------------------

describe("Copy Job .platform platform metadata validation", () => {
  it("accepts a valid .platform with correct displayName", () => {
    const manifestPath = makeFixture({ includePlatform: true });
    // Should not throw
    expect(() => loadManifest(manifestPath)).not.toThrow();
  });

  it("rejects .platform containing sensitivityLabelId", () => {
    const platformWithLabel = {
      ...validPlatform,
      sensitivityLabelId: "some-label-id",
    };
    const manifestPath = makeFixture({
      includePlatform: true,
      platformObj: platformWithLabel,
    });
    expect(() => loadManifest(manifestPath)).toThrow(/sensitivity label/i);
  });

  it("rejects .platform with invalid JSON metadata structure", () => {
    const platformBadMetadata = {
      metadata: "not-an-object",
      config: validPlatform.config,
    };
    const manifestPath = makeFixture({
      includePlatform: true,
      platformObj: platformBadMetadata,
    });
    expect(() => loadManifest(manifestPath)).toThrow(/metadata/);
  });

  it("loads without .platform and does not require it", () => {
    const manifestPath = makeFixture({ includePlatform: false });
    const loaded = loadManifest(manifestPath);
    const def = loaded.copyJobDefinitions?.["my-copy-job"];
    expect(def?.parts.some((p) => p.path === ".platform")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CopyJob definition validation failures surface at manifest load
// ---------------------------------------------------------------------------

describe("Copy Job definition validation in manifest", () => {
  it("throws when copyjob-content.json has extra top-level fields", () => {
    const manifestPath = makeFixture({
      contentObj: { properties: { jobMode: "Batch" }, activities: [] },
    });
    expect(() => loadManifest(manifestPath)).toThrow(/unsupported top-level field/i);
  });

  it("throws when jobMode is invalid", () => {
    const manifestPath = makeFixture({
      contentObj: { properties: { jobMode: "Unknown" } },
    });
    expect(() => loadManifest(manifestPath)).toThrow(/jobMode/i);
  });
});

// ---------------------------------------------------------------------------
// desiredState: absent — no definition files required
// ---------------------------------------------------------------------------

describe("Copy Job manifest with desiredState: absent", () => {
  function makeAbsentFixture(): string {
    const root = mkdtempSync(
      path.join(tmpdir(), "copy-job-absent-manifest-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: delete-copy-job-test
workspace:
  id: 11111111-2222-3333-4444-555555555555
items:
  - logicalId: retire-copyjob
    type: CopyJob
    path: items/copy-jobs/retire
    desiredState: absent
`,
      "utf8",
    );
    // Only item.yaml required — no definition/ directory for absent items.
    const itemDir = path.join(root, "items/copy-jobs/retire");
    mkdirSync(itemDir, { recursive: true });
    writeFileSync(
      path.join(itemDir, "item.yaml"),
      "displayName: RetiredJob\ndesiredState: absent\n",
      "utf8",
    );
    return manifestPath;
  }

  it("loads an absent CopyJob without requiring copyjob-content.json", () => {
    const manifestPath = makeAbsentFixture();
    // Should not throw — no definition directory needed for absent items.
    expect(() => loadManifest(manifestPath)).not.toThrow();
  });

  it("excludes the absent CopyJob from copyJobDefinitions", () => {
    const manifestPath = makeAbsentFixture();
    const loaded = loadManifest(manifestPath);
    // absent items must NOT be loaded into copyJobDefinitions.
    expect(
      Object.keys(loaded.copyJobDefinitions ?? {}),
    ).not.toContain("retire-copyjob");
  });

  it("includes the absent CopyJob in itemDefinitions with desiredState: absent", () => {
    const manifestPath = makeAbsentFixture();
    const loaded = loadManifest(manifestPath);
    expect(loaded.itemDefinitions["retire-copyjob"]?.desiredState).toBe(
      "absent",
    );
  });
});
