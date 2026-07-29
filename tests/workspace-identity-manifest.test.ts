import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest";
import { buildPlan } from "../src/planner";

function writeManifest(source: string): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-workspace-identity-"),
  );
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(manifestPath, source, "utf8");
  return manifestPath;
}

describe("workspace identity manifest", () => {
  it("loads provisioning with self and explicit role targets", () => {
    const loaded = loadManifest(
      writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-identity
workspace:
  id: workspace-1
workspaceIdentity:
  provision: true
  roleAssignments:
    - role: Contributor
    - workspaceId: workspace-2
      role: Viewer
items: []
`),
    );

    expect(loaded.manifest.workspaceIdentity).toEqual({
      provision: true,
      roleAssignments: [
        { role: "Contributor" },
        { workspaceId: "workspace-2", role: "Viewer" },
      ],
    });

    const plan = buildPlan(loaded, {
      mode: "plan",
      environment: "dev",
    });
    expect(plan.workspaceIdentity).toMatchObject({
      action: "unknown",
      roleAssignments: [
        {
          targetWorkspaceId: "workspace-1",
          role: "Contributor",
          action: "unknown",
        },
        {
          targetWorkspaceId: "workspace-2",
          role: "Viewer",
          action: "unknown",
        },
      ],
    });
  });

  it("rejects unsupported identity and role mutations", () => {
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-identity
workspace:
  id: workspace-1
workspaceIdentity:
  provision: false
items: []
`),
      ),
    ).toThrow("Invalid deployment manifest");

    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-identity
workspace:
  id: workspace-1
workspaceIdentity:
  provision: true
  roleAssignments:
    - role: Owner
items: []
`),
      ),
    ).toThrow("Invalid deployment manifest");
  });

  it("rejects duplicate role assignment targets", () => {
    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-identity
workspace:
  id: workspace-1
workspaceIdentity:
  provision: true
  roleAssignments:
    - role: Contributor
    - role: Viewer
items: []
`),
      ),
    ).toThrow(
      "Workspace identity role assignments contain duplicate target",
    );

    expect(() =>
      loadManifest(
        writeManifest(`
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: workspace-identity
workspace:
  id: workspace-1
workspaceIdentity:
  provision: true
  roleAssignments:
    - role: Contributor
    - workspaceId: WORKSPACE-1
      role: Viewer
items: []
`),
      ),
    ).toThrow(
      "Workspace identity role assignments contain duplicate target",
    );
  });
});
