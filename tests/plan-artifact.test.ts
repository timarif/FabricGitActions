import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeManagedPrivateEndpoints,
  planManagedPrivateEndpoints,
} from "../src/fabric/managed-private-endpoints";
import {
  hashCommunicationPolicy,
  hashInboundAzureResourceRules,
  hashInboundFirewallRules,
} from "../src/fabric/network-protection";
import { loadApprovedPlan } from "../src/plan-artifact";
import { buildPlan, rehashPlan } from "../src/planner";
import type { LoadedManifest } from "../src/types";

const TARGET_ID =
  "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourceGroups/data/providers/Microsoft.Storage/storageAccounts/storage";

function createPlan() {
  const loaded: LoadedManifest = {
    manifestPath: "deployment.yaml",
    manifestDirectory: ".",
    sourceHash: "source",
    resolvedHash: "resolved",
    itemContentHashes: { lakehouse: "content" },
    itemDirectories: { lakehouse: "items/lakehouse" },
    itemDefinitions: { lakehouse: { displayName: "Bronze" } },
    environmentDefinitions: {},
    notebookDefinitions: {},
    sparkJobDefinitions: {},
    pipelineDefinitions: {},
    sparkCustomPoolDefinitions: {},
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
      ],
    },
  };
  return buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "commit-1",
  });
}

describe("approved plan loading", () => {
  it("loads a valid approved plan", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    writeFileSync(planPath, JSON.stringify(plan), "utf8");

    expect(loadApprovedPlan(planPath).planHash).toBe(plan.planHash);
  });

  it("rejects a plan changed after hashing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items[0]!.displayName = "Tampered";
    writeFileSync(planPath, JSON.stringify(plan), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "Approved plan hash is invalid",
    );
  });

  it("rejects items omitted from deployment stages", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items.push({
      ...plan.items[0]!,
      logicalId: "unreachable",
    });
    const rehashed = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(rehashed), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow("invalid structure");
  });

  it("requires materialized definition and binding proofs as a pair", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items[0]!.materializedDefinitionHash = "a".repeat(64);
    plan.items[0]!.resolvedBindingsHash = "b".repeat(64);
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");
    expect(loadApprovedPlan(planPath).items[0]).toMatchObject({
      materializedDefinitionHash: "a".repeat(64),
      resolvedBindingsHash: "b".repeat(64),
    });

    delete approved.items[0]!.resolvedBindingsHash;
    const invalid = rehashPlan(approved);
    writeFileSync(planPath, JSON.stringify(invalid), "utf8");
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("validates exact deletion proofs and desired-state action pairing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items[0] = {
      ...plan.items[0]!,
      type: "Notebook",
      desiredState: "absent",
      action: "delete",
      reason: "approved soft deletion",
      physicalId: "22222222-2222-4222-8222-222222222222",
      observedStateHash: "a".repeat(64),
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(loadApprovedPlan(planPath).items[0]).toMatchObject({
      desiredState: "absent",
      action: "delete",
      physicalId: "22222222-2222-4222-8222-222222222222",
    });

    delete approved.items[0]!.physicalId;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    approved.items[0]!.physicalId =
      "22222222-2222-4222-8222-222222222222";
    approved.items[0]!.desiredState = "present";
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("rejects a managed workspace changed after approval", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.workspace = {
      displayName: "Managed",
      contentHash: "a".repeat(64),
      action: "no-op",
      reason: "matches",
      physicalId: "workspace",
      observedStateHash: "state",
    };
    const approved = rehashPlan(plan);
    approved.workspace!.displayName = "Tampered";
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "Approved plan hash is invalid",
    );
  });

  it("validates Spark Job OneLake artifact staging payloads", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items[0] = {
      ...plan.items[0]!,
      logicalId: "sparkJob",
      type: "SparkJobDefinition",
      action: "create",
      reason: "create",
      observedStateHash: "absent",
      sparkJobArtifacts: {
        targetLakehouseLogicalId: "bronze",
        targetLakehousePhysicalId:
          "22222222-2222-2222-2222-222222222222",
        targetBinding: "physical",
        oneLakeDfsEndpoint:
          "https://onelake.dfs.fabric.microsoft.com",
        oneLakeBlobEndpoint:
          "https://onelake.blob.fabric.microsoft.com",
        stagingHash: "a".repeat(64),
        artifacts: [
          {
            action: "create",
            kind: "executable",
            operationId: "main.jar:proof",
            operationHash: "b".repeat(64),
            fileName: "main.jar",
            relativeSourcePath: "definition/main.jar",
            contentHash: "c".repeat(64),
            sizeBytes: 42,
            oneLakePath: `Files/.fabric-deploy/sample/dev/sparkJob/${"c".repeat(64)}/main.jar`,
            abfssUri:
              "abfss://11111111-1111-1111-1111-111111111111@onelake.dfs.fabric.microsoft.com/22222222-2222-2222-2222-222222222222/Files/main.jar",
            observedHash: "absent",
            reason: "absent",
          },
        ],
      },
    };
    plan.stages = [["sparkJob"]];
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");
    expect(
      loadApprovedPlan(planPath).items[0]?.sparkJobArtifacts,
    ).toBeDefined();

    approved.items[0]!.sparkJobArtifacts!.artifacts[0]!.relativeSourcePath =
      "definition/libs/main.jar";
    const invalidExecutablePath = rehashPlan(approved);
    writeFileSync(
      planPath,
      JSON.stringify(invalidExecutablePath),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    approved.items[0]!.sparkJobArtifacts!.artifacts[0]!.relativeSourcePath =
      "definition/main.jar";
    approved.items[0]!.sparkJobArtifacts!.targetBinding =
      "symbolic";
    const invalid = rehashPlan(approved);
    writeFileSync(planPath, JSON.stringify(invalid), "utf8");
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("validates FabricTag resources and item assignment proofs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.items.unshift({
      logicalId: "reviewTag",
      type: "FabricTag",
      path: "items/tags/review",
      dependsOn: [],
      desiredState: "present",
      contentHash: "tag-content",
      displayName: "Phase 4 Review",
      physicalId: "22222222-2222-4222-8222-222222222222",
      observedStateHash: "tag-state",
      action: "no-op",
      reason: "exists",
    });
    plan.items[1] = {
      ...plan.items[1]!,
      dependsOn: ["reviewTag"],
      physicalId: "33333333-3333-4333-8333-333333333333",
      observedStateHash: "lakehouse-state",
      action: "no-op",
      reason: "exists",
      tagAssignment: {
        assignmentHash: "a".repeat(64),
        tagLogicalIds: ["reviewTag"],
        missingTagLogicalIds: ["reviewTag"],
        action: "update",
        observedStateHash: "tags-absent",
        reason: "missing",
      },
    };
    plan.stages = [["reviewTag"], ["lakehouse"]];
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(
      loadApprovedPlan(planPath).items[1]?.tagAssignment,
    ).toMatchObject({
      action: "update",
      tagLogicalIds: ["reviewTag"],
    });

    approved.items[1]!.tagAssignment!.tagLogicalIds = ["lakehouse"];
    approved.items[1]!.tagAssignment!.missingTagLogicalIds = ["lakehouse"];
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("round-trips a plan with configured network protection surfaces", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const desiredPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Deny" } },
    });

    const observedPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "update",
        reason: "Outbound default action differs.",
        desiredHash: desiredPolicyHash,
        observedStateHash: observedPolicyHash,
        etag: '"etag-1"',
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Deny",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundFirewallRules: {
        action: "update",
        reason: "Preview firewall differs.",
        desiredHash: hashInboundFirewallRules({
          rules: [
            {
              displayName: "corporate",
              value: "12.34.56.78",
            },
          ],
        }),
        observedStateHash: hashInboundFirewallRules({ rules: [] }),
        etag: "firewall-etag",
        ruleCount: 1,
      },
      outboundGatewayRules: {
        action: "no-op",
        reason: "Matches.",
        desiredHash: "c".repeat(64),
        observedStateHash: "c".repeat(64),
      },
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(
      loadApprovedPlan(planPath).networkProtection?.communicationPolicy,
    ).toMatchObject({ action: "update", isRelaxation: false });
    expect(
      loadApprovedPlan(planPath).networkProtection
        ?.inboundFirewallRules,
    ).toMatchObject({
      action: "update",
      etag: "firewall-etag",
      ruleCount: 1,
    });

    const headerless = structuredClone(approved);
    delete headerless.networkProtection!.inboundFirewallRules!.etag;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(headerless)),
      "utf8",
    );
    expect(
      loadApprovedPlan(planPath).networkProtection
        ?.inboundFirewallRules,
    ).not.toHaveProperty("etag");
  });

  it("rejects rehashed inbound firewall plan metadata tampering", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const policyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Deny" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "update",
        reason: "Inbound tightening.",
        desiredHash: policyHash,
        observedStateHash: hashCommunicationPolicy({
          inbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
          outbound: {
            publicAccessRules: { defaultAction: "Allow" },
          },
        }),
        desiredInboundDefaultAction: "Deny",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundFirewallRules: {
        action: "update",
        reason: "differs",
        desiredHash: hashInboundFirewallRules({
          rules: [
            {
              displayName: "corporate",
              value: "12.34.56.78",
            },
          ],
        }),
        observedStateHash: hashInboundFirewallRules({ rules: [] }),
        etag: "etag",
        ruleCount: 1,
      },
    };
    const approved = rehashPlan(plan);

    const missingFirewall = structuredClone(approved);
    delete missingFirewall.networkProtection!.inboundFirewallRules;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(missingFirewall)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    approved.networkProtection!.inboundFirewallRules!.etag = "";
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    approved.networkProtection!.inboundFirewallRules!.etag = "etag";
    (
      approved.networkProtection!.inboundFirewallRules as unknown as Record<
        string,
        unknown
      >
    ).unexpected = true;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("round-trips a plan with a configured inbound Azure resource rules surface, including a headerless variant", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const resourceId =
      "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourcegroups/data/providers/microsoft.sql/servers/sqlserver";
    const desiredPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "no-op",
        reason: "Matches.",
        desiredHash: desiredPolicyHash,
        observedStateHash: desiredPolicyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundAzureResourceRules: {
        action: "update",
        reason: "Preview Azure resource rules differ.",
        desiredHash: hashInboundAzureResourceRules({
          rules: [{ displayName: "sql-server", resourceId }],
        }),
        observedStateHash: hashInboundAzureResourceRules({ rules: [] }),
        etag: "azure-resource-etag",
        ruleCount: 1,
      },
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(
      loadApprovedPlan(planPath).networkProtection
        ?.inboundAzureResourceRules,
    ).toMatchObject({
      action: "update",
      etag: "azure-resource-etag",
      ruleCount: 1,
    });

    const headerless = structuredClone(approved);
    delete headerless.networkProtection!.inboundAzureResourceRules!.etag;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(headerless)),
      "utf8",
    );
    expect(
      loadApprovedPlan(planPath).networkProtection
        ?.inboundAzureResourceRules,
    ).not.toHaveProperty("etag");

    const uncapped = structuredClone(approved);
    uncapped.networkProtection!.inboundAzureResourceRules!.ruleCount =
      257;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(uncapped)),
      "utf8",
    );
    expect(
      loadApprovedPlan(planPath).networkProtection
        ?.inboundAzureResourceRules?.ruleCount,
    ).toBe(257);
  });

  it("rejects rehashed inbound Azure resource rules plan metadata tampering", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const resourceId =
      "/subscriptions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resourcegroups/data/providers/microsoft.sql/servers/sqlserver";
    const desiredPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "no-op",
        reason: "Matches.",
        desiredHash: desiredPolicyHash,
        observedStateHash: desiredPolicyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      inboundAzureResourceRules: {
        action: "update",
        reason: "differs",
        desiredHash: hashInboundAzureResourceRules({
          rules: [{ displayName: "sql-server", resourceId }],
        }),
        observedStateHash: hashInboundAzureResourceRules({ rules: [] }),
        etag: "etag",
        ruleCount: 1,
      },
    };
    const approved = rehashPlan(plan);

    approved.networkProtection!.inboundAzureResourceRules!.etag = "";
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );

    approved.networkProtection!.inboundAzureResourceRules!.etag = "etag";
    (
      approved.networkProtection!
        .inboundAzureResourceRules as unknown as Record<string, unknown>
    ).unexpected = true;
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("round-trips a guarded managed private endpoint plan without exposing requestMessage", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const desiredPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Deny" } },
    });
    const observedPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    const endpoints = planManagedPrivateEndpoints(
      normalizeManagedPrivateEndpoints([
        {
          name: "storage-blob",
          targetPrivateLinkResourceId: TARGET_ID,
          requestMessage: "Approve this endpoint",
        },
      ]),
      [],
    );
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "blocked",
        reason: "Endpoint approval required.",
        desiredHash: desiredPolicyHash,
        observedStateHash: observedPolicyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Deny",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
        blockedByManagedPrivateEndpoints: ["storage-blob"],
      },
      managedPrivateEndpoints: endpoints,
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    const loaded = loadApprovedPlan(planPath);
    expect(
      loaded.networkProtection?.managedPrivateEndpoints?.[0],
    ).toMatchObject({
      action: "create",
      requestMessageHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(loaded)).not.toContain(
      "Approve this endpoint",
    );

    (
      approved.networkProtection!.managedPrivateEndpoints![0] as unknown as Record<
        string,
        unknown
      >
    ).requestMessage = "leak";
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(approved)),
      "utf8",
    );
    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("rejects non-deterministic managed private endpoint ordering", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const policyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: policyHash,
        observedStateHash: policyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
      managedPrivateEndpoints: planManagedPrivateEndpoints(
        normalizeManagedPrivateEndpoints([
          {
            name: "zeta",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve zeta",
          },
          {
            name: "alpha",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve alpha",
          },
        ]),
        [],
      ).reverse(),
    };
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(plan)),
      "utf8",
    );

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("rejects an OAP prerequisite block that omits a declared endpoint blocker", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const desiredPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Deny" } },
    });
    const observedPolicyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "blocked",
        reason: "Endpoint approval required.",
        desiredHash: desiredPolicyHash,
        observedStateHash: observedPolicyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Deny",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
        blockedByManagedPrivateEndpoints: ["alpha"],
      },
      managedPrivateEndpoints: planManagedPrivateEndpoints(
        normalizeManagedPrivateEndpoints([
          {
            name: "alpha",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve alpha",
          },
          {
            name: "zeta",
            targetPrivateLinkResourceId: TARGET_ID,
            requestMessage: "Approve zeta",
          },
        ]),
        [],
      ),
    };
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(plan)),
      "utf8",
    );

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "invalid structure",
    );
  });

  it("rejects inconsistent network policy relaxation metadata", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "update",
        reason: "Outbound policy is being relaxed.",
        desiredHash: hashCommunicationPolicy({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Allow" } },
        }),
        observedStateHash: hashCommunicationPolicy({
          inbound: { publicAccessRules: { defaultAction: "Allow" } },
          outbound: { publicAccessRules: { defaultAction: "Deny" } },
        }),
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Deny",
        isRelaxation: false,
      },
    };
    writeFileSync(
      planPath,
      JSON.stringify(rehashPlan(plan)),
      "utf8",
    );

    expect(() => loadApprovedPlan(planPath)).toThrow("invalid structure");
  });

  it("rejects a network protection surface with an invalid action", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.networkProtection = {
      communicationPolicy: {
        action: "create" as never,
        reason: "invalid",
        desiredHash: "a".repeat(64),
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
      },
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow("invalid structure");
  });

  it("rejects a network protection surface with a malformed desired hash", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    plan.networkProtection = {
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: "not-a-hash",
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
      },
    };
    const approved = rehashPlan(plan);
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow("invalid structure");
  });

  it("rejects tampering with an approved network protection surface", () => {
    const root = mkdtempSync(path.join(tmpdir(), "fabric-plan-"));
    const planPath = path.join(root, "plan.json");
    const plan = createPlan();
    const policyHash = hashCommunicationPolicy({
      inbound: { publicAccessRules: { defaultAction: "Allow" } },
      outbound: { publicAccessRules: { defaultAction: "Allow" } },
    });
    plan.networkProtection = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      communicationPolicy: {
        action: "no-op",
        reason: "matches",
        desiredHash: policyHash,
        observedStateHash: policyHash,
        desiredInboundDefaultAction: "Allow",
        desiredOutboundDefaultAction: "Allow",
        observedInboundDefaultAction: "Allow",
        observedOutboundDefaultAction: "Allow",
        isRelaxation: false,
      },
    };
    const approved = rehashPlan(plan);
    approved.networkProtection!.communicationPolicy.reason = "tampered";
    writeFileSync(planPath, JSON.stringify(approved), "utf8");

    expect(() => loadApprovedPlan(planPath)).toThrow(
      "Approved plan hash is invalid",
    );
  });
});
