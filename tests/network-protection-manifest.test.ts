import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadManifest,
  loadManifestItemDirectoriesForSafety,
  loadNetworkProtectionManifest,
} from "../src/manifest";

const GATEWAY_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";

function writeManifest(
  networkProtectionYaml: string,
  workspaceYaml = "  displayName: NetworkProtectionTestWorkspace",
): string {
  const root = mkdtempSync(
    path.join(tmpdir(), "fabric-network-protection-manifest-"),
  );
  const manifestPath = path.join(root, "deployment.yaml");
  writeFileSync(
    manifestPath,
    `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: network-protection-manifest-test
workspace:
${workspaceYaml}
networkProtection:
${networkProtectionYaml}
items: []
`,
    "utf8",
  );
  return manifestPath;
}

describe("networkProtection manifest contract", () => {
  it("loads a minimal outbound-Allow communication policy", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow`,
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.manifest.networkProtection).toEqual({
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Allow",
      },
    });
  });

  it("supports a network-only deployment against an existing workspace", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow`,
      "  id: 11111111-1111-4111-8111-111111111111",
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.manifest.items).toEqual([]);
    expect(loaded.manifest.workspace).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("loads network recovery input without resolving unrelated item artifacts", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-network-recovery-manifest-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: recovery-only
workspace:
  id: 11111111-1111-4111-8111-111111111111
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: \${var.OUTBOUND_ACTION}
items:
  - logicalId: missing
    type: Lakehouse
    path: \${var.UNRELATED_MISSING_PATH}
`,
      "utf8",
    );

    expect(
      loadNetworkProtectionManifest(manifestPath, {
        variables: { OUTBOUND_ACTION: "Deny" },
      }),
    ).toMatchObject({
      communicationPolicy: {
        inboundDefaultAction: "Allow",
        outboundDefaultAction: "Deny",
      },
    });
  });

  it("resolves declared item directories without requiring them to exist", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "fabric-item-directory-safety-"),
    );
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(
      manifestPath,
      `
items:
  - logicalId: future
    type: Lakehouse
    path: items/future
`,
      "utf8",
    );

    expect(
      loadManifestItemDirectoriesForSafety(manifestPath),
    ).toEqual([path.join(root, "items", "future")]);
  });

  it("loads outbound Deny with cloud connection and gateway rules", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  outboundCloudConnectionRules:
    defaultAction: Deny
    rules:
      - connectionType: Web
        defaultAction: Allow
      - connectionType: SQL
        defaultAction: Deny
        allowedEndpoints:
          - hostnamePattern: "*.database.windows.net"
  outboundGatewayRules:
    defaultAction: Deny
    allowedGateways:
      - id: ${GATEWAY_ID}`,
    );

    const loaded = loadManifest(manifestPath);

    expect(loaded.manifest.networkProtection?.outboundCloudConnectionRules?.rules).toHaveLength(2);
    expect(loaded.manifest.networkProtection?.outboundGatewayRules?.allowedGateways).toEqual([
      { id: GATEWAY_ID },
    ]);
  });

  it("accepts an explicit independent workspaceId", () => {
    const manifestPath = writeManifest(
      `  workspaceId: 44444444-4444-4444-8444-444444444444
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow`,
    );

    expect(loadManifest(manifestPath).manifest.networkProtection?.workspaceId).toBe(
      "44444444-4444-4444-8444-444444444444",
    );
  });

  it("loads guarded managed private endpoint present and absent declarations", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  managedPrivateEndpoints:
    - name: storage-blob
      targetPrivateLinkResourceId: ${TARGET_ID}
      targetSubresourceType: blob
      requestMessage: Approve the Fabric endpoint
    - name: old-endpoint
      desiredState: absent
      targetPrivateLinkResourceId: ${TARGET_ID}`,
    );

    expect(
      loadManifest(manifestPath).manifest.networkProtection
        ?.managedPrivateEndpoints,
    ).toEqual([
      {
        name: "storage-blob",
        targetPrivateLinkResourceId: TARGET_ID,
        targetSubresourceType: "blob",
        requestMessage: "Approve the Fabric endpoint",
      },
      {
        name: "old-endpoint",
        desiredState: "absent",
        targetPrivateLinkResourceId: TARGET_ID,
      },
    ]);
  });

  it("enforces requestMessage state rules and rejects targetFQDNs", () => {
    const missingMessage = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  managedPrivateEndpoints:
    - name: storage-blob
      targetPrivateLinkResourceId: ${TARGET_ID}`,
    );
    expect(() => loadManifest(missingMessage)).toThrow(
      "Invalid deployment manifest",
    );

    const absentMessage = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  managedPrivateEndpoints:
    - name: storage-blob
      desiredState: absent
      targetPrivateLinkResourceId: ${TARGET_ID}
      requestMessage: forbidden`,
    );
    expect(() => loadManifest(absentMessage)).toThrow(
      "Invalid deployment manifest",
    );

    const targetFqdns = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  managedPrivateEndpoints:
    - name: storage-blob
      targetPrivateLinkResourceId: ${TARGET_ID}
      requestMessage: Approve
      targetFQDNs:
        - storage.example`,
    );
    expect(() => loadNetworkProtectionManifest(targetFqdns)).toThrow(
      "targetFQDNs",
    );
  });

  it("requires communicationPolicy whenever networkProtection is present", () => {
    const manifestPath = writeManifest(`  outboundGatewayRules: null`);

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("rejects an unknown top-level networkProtection property", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  unexpectedField: true`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("rejects an unknown communicationPolicy property", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
    extra: true`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("rejects a communicationPolicy missing outboundDefaultAction", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("requires an explicit non-empty inbound firewall body for inbound Deny", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Deny
    outboundDefaultAction: Allow`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "requires an explicit inboundFirewallRules configuration",
    );
  });

  it("loads the exact documented inbound firewall body", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Deny
    outboundDefaultAction: Allow
  inboundFirewallRules:
    rules:
      - displayName: corporate-egress
        value: 12.34.56.78`,
    );

    expect(
      loadManifest(manifestPath).manifest.networkProtection
        ?.inboundFirewallRules,
    ).toEqual({
      rules: [
        {
          displayName: "corporate-egress",
          value: "12.34.56.78",
        },
      ],
    });
  });

  it("loads the exact documented inbound Azure resource rules body without requiring inbound Deny", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  inboundAzureResourceRules:
    rules:
      - displayName: sql-server
        resourceId: ${TARGET_ID}`,
    );

    expect(
      loadManifest(manifestPath).manifest.networkProtection
        ?.inboundAzureResourceRules,
    ).toEqual({
      rules: [
        {
          displayName: "sql-server",
          resourceId: TARGET_ID,
        },
      ],
    });
  });

  it("rejects an unknown inboundAzureResourceRules property and malformed resourceId", () => {
    const unknownProperty = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  inboundAzureResourceRules:
    rules:
      - displayName: sql-server
        resourceId: ${TARGET_ID}
        extra: true`,
    );
    expect(() => loadManifest(unknownProperty)).toThrow(
      "Invalid deployment manifest",
    );

    const malformedResourceId = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  inboundAzureResourceRules:
    rules:
      - displayName: sql-server
        resourceId: not-an-arm-id`,
    );
    expect(() =>
      loadNetworkProtectionManifest(malformedResourceId),
    ).toThrow("ARM resource ID");
  });

  it("continues to reject later inbound security surfaces", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  inboundExternalDataSharesPolicy: {}`,
    );

    expect(() =>
      loadNetworkProtectionManifest(manifestPath),
    ).toThrow("inboundExternalDataSharesPolicy");
  });

  it("rejects outboundCloudConnectionRules declared alongside outbound Allow", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Allow
  outboundCloudConnectionRules:
    defaultAction: Deny
    rules: []`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "may only be declared when communicationPolicy.outboundDefaultAction is 'Deny'",
    );
  });

  it("rejects a non-GUID gateway id", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  outboundGatewayRules:
    defaultAction: Deny
    allowedGateways:
      - id: not-a-guid`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "Invalid deployment manifest",
    );
  });

  it("rejects duplicate connection types", () => {
    const manifestPath = writeManifest(
      `  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  outboundCloudConnectionRules:
    defaultAction: Deny
    rules:
      - connectionType: SQL
        defaultAction: Deny
      - connectionType: SQL
        defaultAction: Allow`,
    );

    expect(() => loadManifest(manifestPath)).toThrow(
      "duplicate connectionType 'SQL'",
    );
  });
});
