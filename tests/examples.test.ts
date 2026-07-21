import { Buffer } from "node:buffer";
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
    name: "Eventhouse",
    manifestPath: "eventhouse/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 1,
  },
  {
    name: "KQL Database",
    manifestPath: "kql-database/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 2,
  },
  {
    name: "Eventstream",
    manifestPath: "eventstream/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
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
    name: "Semantic Model and Report",
    manifestPath: "semantic-model/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 2,
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
        PRIVATE_LINK_RESOURCE_ID:
          "/subscriptions/00000000-0000-4000-8000-000000000004/resourceGroups/example/providers/Microsoft.Storage/storageAccounts/example",
      },
    },
    itemCount: 1,
  },
  {
    name: "read-only inbound firewall probe",
    manifestPath: "inbound-firewall-probe/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 0,
  },
  {
    name: "Copy Job",
    manifestPath: "copy-job/fabric/deployment.yaml",
    options: {
      variables: { FABRIC_WORKSPACE_ID: WORKSPACE_ID },
    },
    itemCount: 1,
  },
  {
    name: "Data Agent",
    manifestPath: "data-agent/fabric/deployment.yaml",
    options: { workspaceIdOverride: WORKSPACE_ID },
    itemCount: 2,
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

describe("Data Agent example — targeted assertions", () => {
  const loaded = loadManifest(
    path.join(EXAMPLES_ROOT, "data-agent/fabric/deployment.yaml"),
    { workspaceIdOverride: WORKSPACE_ID },
  );

  it("contains exactly 2 items, both of type DataAgent", () => {
    expect(loaded.manifest.items).toHaveLength(2);
    for (const item of loaded.manifest.items) {
      expect(item.type).toBe("DataAgent");
    }
  });

  it("salesAssistant item has a definition (Files/Config present)", () => {
    expect(loaded.dataAgentDefinitions).toBeDefined();
    const def = loaded.dataAgentDefinitions!["salesAssistant"];
    expect(def).toBeDefined();
    expect(def!.parts.length).toBeGreaterThanOrEqual(1);
    const rootPart = def!.parts.find(
      (p) => p.path === "Files/Config/data_agent.json",
    );
    expect(rootPart).toBeDefined();
  });

  it("salesAssistant definition includes stage_config with aiInstructions", () => {
    const def = loaded.dataAgentDefinitions!["salesAssistant"]!;
    const stagePart = def.parts.find(
      (p) => p.path === "Files/Config/draft/stage_config.json",
    );
    expect(stagePart).toBeDefined();
    const payload = JSON.parse(
      Buffer.from(stagePart!.payload, "base64").toString("utf8"),
    );
    expect(typeof payload.aiInstructions).toBe("string");
    expect(payload.aiInstructions.length).toBeGreaterThan(0);
  });

  it("shellAgent item has no definition (shell mode)", () => {
    const def = loaded.dataAgentDefinitions?.["shellAgent"];
    // Shell agent: no Files/Config directory → definition is undefined
    expect(def).toBeUndefined();
  });

  it("no DataAgent item declares desiredState: absent", () => {
    for (const item of loaded.manifest.items) {
      expect(item.desiredState).not.toBe("absent");
    }
  });

  it("salesAssistant itemDefinition has correct displayName", () => {
    const itemDef = loaded.itemDefinitions["salesAssistant"];
    expect(itemDef).toBeDefined();
    expect(itemDef!.displayName).toBe("Sales Assistant");
  });

  it("shellAgent itemDefinition has correct displayName", () => {
    const itemDef = loaded.itemDefinitions["shellAgent"];
    expect(itemDef).toBeDefined();
    expect(itemDef!.displayName).toBe("Shell Data Agent");
  });
});
