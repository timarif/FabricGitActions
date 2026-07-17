import { describe, expect, it } from "vitest";

import { enrichPlanWithFabric } from "../src/fabric/live-planner";
import { buildPlan } from "../src/planner";
import { rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

describe("online Fabric planning", () => {
  it("classifies Lakehouses and Environments while leaving later adapters unknown", async () => {
    const loaded: LoadedManifest = {
      manifestPath: "deployment.yaml",
      manifestDirectory: ".",
      sourceHash: "source",
      resolvedHash: "resolved",
      itemContentHashes: {
        lakehouse: "lakehouse-content",
        environment: "environment-content",
        notebook: "notebook-content",
      },
      itemDirectories: {
        lakehouse: "items/lakehouse",
        environment: "items/environment",
        notebook: "items/notebook",
      },
      itemDefinitions: {
        lakehouse: { displayName: "Bronze" },
        environment: { displayName: "Spark" },
        notebook: { displayName: "Notebook" },
      },
      environmentDefinitions: {
        environment: {
          parts: [
            {
              path: "Libraries/PublicLibraries/environment.yml",
              payload: Buffer.from("dependencies: []\n").toString("base64"),
              payloadType: "InlineBase64",
            },
          ],
        },
      },
      manifest: {
        apiVersion: "fabric.deploy/v1alpha1",
        kind: "FabricDeployment",
        metadata: { deploymentId: "sample" },
        workspace: { id: "workspace" },
        items: [
          {
            logicalId: "lakehouse",
            type: "Lakehouse",
            path: "items/lakehouse",
          },
          {
            logicalId: "environment",
            type: "Environment",
            path: "items/environment",
          },
          {
            logicalId: "notebook",
            type: "Notebook",
            path: "items/notebook",
            dependsOn: ["lakehouse"],
          },
        ],
      },
    };
    const offline = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    const adapter = {
      plan: async () => ({
        action: "create" as const,
        reason: "missing",
        observedStateHash: "absent",
      }),
    };
    const environmentAdapter = {
      plan: async () => ({
        action: "no-op" as const,
        reason: "published",
        physicalId: "environment-1",
        observedStateHash: "environment-state",
      }),
    };

    const online = await enrichPlanWithFabric(offline, loaded, {
      lakehouse: adapter,
      environment: environmentAdapter,
    });

    expect(online.items[0]?.action).toBe("create");
    expect(online.items[0]?.observedStateHash).toBe("absent");
    expect(online.items[1]?.action).toBe("no-op");
    expect(online.items[1]?.physicalId).toBe("environment-1");
    expect(online.items[2]?.action).toBe("unknown");
    expect(online.planHash).not.toBe(offline.planHash);

    const savedPlan = JSON.parse(JSON.stringify(online));
    expect(rehashPlan(savedPlan).planHash).toBe(online.planHash);
  });
});
