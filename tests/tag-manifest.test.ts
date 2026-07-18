import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";

const DOMAIN_A = "11111111-1111-4111-8111-111111111111";
const DOMAIN_B = "22222222-2222-4222-8222-222222222222";

function writeManifest(
  manifest: string,
  definitions: Record<string, string>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-tags-manifest-"));
  for (const [directory, definition] of Object.entries(definitions)) {
    const itemDirectory = path.join(root, directory);
    mkdirSync(itemDirectory, { recursive: true });
    writeFileSync(
      path.join(itemDirectory, "item.yaml"),
      definition,
      "utf8",
    );
  }
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(manifestPath, manifest, "utf8");
  return manifestPath;
}

function deployment(items: string): string {
  return `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: tags
workspace:
  id: 33333333-3333-4333-8333-333333333333
items:
${items}
`;
}

describe("Fabric tag manifest contract", () => {
  it("loads a FabricTag without a definition directory and tags a dependent item", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: reviewTag
    type: FabricTag
    path: items/tags/review
  - logicalId: bronze
    type: Lakehouse
    path: items/lakehouses/bronze
    dependsOn: [reviewTag]`),
      {
        "items/tags/review": "displayName: Phase 4 Review\n",
        "items/lakehouses/bronze":
          "displayName: Bronze\ntags:\n  - reviewTag\n",
      },
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.itemDefinitions.reviewTag).toEqual({
      displayName: "Phase 4 Review",
    });
    expect(loaded.itemDefinitions.bronze?.tags).toEqual(["reviewTag"]);
  });

  it("supports an explicit Domain tag scope", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: domainTag
    type: FabricTag
    path: items/tags/domain`),
      {
        "items/tags/domain": `displayName: Finance
scope:
  type: Domain
  domainId: ${DOMAIN_A}
`,
      },
    );

    expect(loadManifest(manifestPath).itemDefinitions.domainTag?.scope).toEqual(
      { type: "Domain", domainId: DOMAIN_A },
    );
  });

  it("requires tag references to be explicit dependencies", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: reviewTag
    type: FabricTag
    path: items/tags/review
  - logicalId: bronze
    type: Lakehouse
    path: items/lakehouses/bronze`),
      {
        "items/tags/review": "displayName: Review\n",
        "items/lakehouses/bronze":
          "displayName: Bronze\ntags: [reviewTag]\n",
      },
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "dependsOn does not include it",
    );
  });

  it("requires tag references to target FabricTag items", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: silver
    type: Lakehouse
    path: items/lakehouses/silver
  - logicalId: bronze
    type: Lakehouse
    path: items/lakehouses/bronze
    dependsOn: [silver]`),
      {
        "items/lakehouses/silver": "displayName: Silver\n",
        "items/lakehouses/bronze":
          "displayName: Bronze\ntags: [silver]\n",
      },
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "must target a FabricTag item",
    );
  });

  it("rejects assignment metadata on FabricTag resources", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: reviewTag
    type: FabricTag
    path: items/tags/review
    dependsOn: [otherTag]
  - logicalId: otherTag
    type: FabricTag
    path: items/tags/other`),
      {
        "items/tags/review":
          "displayName: Review\ntags: [otherTag]\n",
        "items/tags/other": "displayName: Other\n",
      },
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "does not support Fabric tag assignment",
    );
  });

  it("rejects tenant and domain tag identities that conflict", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: tenantTag
    type: FabricTag
    path: items/tags/tenant
  - logicalId: domainTag
    type: FabricTag
    path: items/tags/domain`),
      {
        "items/tags/tenant": "displayName: Confidential\n",
        "items/tags/domain": `displayName: confidential
scope:
  type: Domain
  domainId: ${DOMAIN_A}
`,
      },
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "conflicting displayName and scope identities",
    );
  });

  it("allows the same tag name in separate domains", () => {
    const manifestPath = writeManifest(
      deployment(`  - logicalId: firstTag
    type: FabricTag
    path: items/tags/first
  - logicalId: secondTag
    type: FabricTag
    path: items/tags/second`),
      {
        "items/tags/first": `displayName: Confidential
scope:
  type: Domain
  domainId: ${DOMAIN_A}
`,
        "items/tags/second": `displayName: confidential
scope:
  type: Domain
  domainId: ${DOMAIN_B}
`,
      },
    );

    expect(loadManifest(manifestPath).manifest.items).toHaveLength(2);
  });
});
