import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadManifest,
  type LoadManifestOptions,
} from "../src/manifest";

const EXAMPLES_ROOT = path.join(process.cwd(), "examples");
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

interface ExampleCase {
  name: string;
  manifestPath: string;
  options: LoadManifestOptions;
  itemCount: number;
}

const examples: ExampleCase[] = [
  {
    name: "basic",
    manifestPath: "basic/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 5,
  },
  {
    name: "live Lakehouse",
    manifestPath: "live-lakehouse/fabric/deployment.yaml",
    options: {
      workspaceIdOverride: WORKSPACE_ID,
      variables: {
        LAKEHOUSE_DESCRIPTION: "Example validation",
      },
    },
    itemCount: 1,
  },
  {
    name: "Phase 3",
    manifestPath: "live-phase3/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 6,
  },
  {
    name: "live pipeline",
    manifestPath: "live-pipeline/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 1,
  },
  {
    name: "managed workspace",
    manifestPath: "workspace/fabric/deployment.yaml",
    options: {
      variables: {
        WORKSPACE_NAME: "Example Managed Workspace",
        FABRIC_CAPACITY_ID:
          "00000000-0000-0000-0000-000000000002",
      },
    },
    itemCount: 0,
  },
  {
    name: "Fabric tags",
    manifestPath: "tags/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 2,
  },
  {
    name: "guarded deletion",
    manifestPath: "deletion/fabric/deployment.yaml",
    options: {
      variables: { FABRIC_WORKSPACE_ID: WORKSPACE_ID },
    },
    itemCount: 2,
  },
  {
    name: "network protection",
    manifestPath: "network-protection/fabric/deployment.yaml",
    options: {
      variables: {
        FABRIC_WORKSPACE_ID: WORKSPACE_ID,
        FABRIC_GATEWAY_ID: "00000000-0000-0000-0000-000000000003",
      },
    },
    itemCount: 1,
  },
];

describe("maintained examples", () => {
  it.each(examples)(
    "loads the $name example",
    ({ manifestPath, options, itemCount }) => {
      const loaded = loadManifest(
        path.join(EXAMPLES_ROOT, manifestPath),
        options,
      );

      expect(loaded.manifest.items).toHaveLength(itemCount);
      if (manifestPath.startsWith("deletion/")) {
        expect(
          loaded.manifest.items.every(
            (item) => item.desiredState === "absent",
          ),
        ).toBe(true);
      }
    },
  );
});
