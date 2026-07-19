import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function loadYaml(relativePath: string): Record<string, unknown> {
  return parse(
    readFileSync(path.join(process.cwd(), relativePath), "utf8"),
  ) as Record<string, unknown>;
}

function workflowSteps(
  workflow: Record<string, unknown>,
  jobName: string,
): Array<Record<string, unknown>> {
  const jobs = workflow.jobs as Record<
    string,
    Record<string, unknown>
  >;
  const concurrency = workflow.concurrency as Record<
    string,
    unknown
  >;
  return jobs[jobName]?.steps as Array<Record<string, unknown>>;
}

describe("deployment workflow metadata", () => {
  it("exposes both guarded deletion inputs from the action", () => {
    const action = loadYaml("action.yml");
    const inputs = action.inputs as Record<
      string,
      Record<string, unknown>
    >;

    expect(inputs["allow-delete"]?.default).toBe("false");
    expect(inputs["allow-lakehouse-data-loss"]?.default).toBe(
      "false",
    );
    expect(
      (action.outputs as Record<string, unknown>)["delete-count"],
    ).toBeDefined();
  });

  it("exposes the network protection safeguards, all defaulting to false", () => {
    const action = loadYaml("action.yml");
    const inputs = action.inputs as Record<
      string,
      Record<string, unknown>
    >;
    const networkInputNames = [
      "allow-network-policy-update",
      "allow-network-policy-relaxation",
      "allow-inbound-firewall-update",
      "allow-inbound-azure-resource-rule-update",
      "allow-inbound-external-data-share-policy-update",
      "allow-inbound-external-data-share-policy-relaxation",
      "acknowledge-firewall-lockout-risk",
      "allow-outbound-cloud-connection-rule-update",
      "allow-outbound-gateway-rule-update",
      "allow-managed-private-endpoint-create",
      "allow-managed-private-endpoint-delete",
    ];

    for (const name of networkInputNames) {
      expect(inputs[name]?.default).toBe("false");
      expect(inputs[name]?.required).toBe(false);
    }
    expect(
      (action.outputs as Record<string, unknown>)["network-protection-action"],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)["inbound-firewall-action"],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "inbound-firewall-rule-count"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "inbound-azure-resource-rule-action"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "inbound-azure-resource-rule-count"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "inbound-external-data-share-policy-action"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "inbound-external-data-share-policy-default-action"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "managed-private-endpoint-create-count"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "managed-private-endpoint-applied-count"
      ],
    ).toBeDefined();
    expect(
      (action.outputs as Record<string, unknown>)[
        "managed-private-endpoint-resumed-count"
      ],
    ).toBeDefined();
  });

  it("passes the network protection safeguards through the reusable workflow and promotion dispatcher", () => {
    const reusable = loadYaml(
      ".github/workflows/reusable-fabric-deploy.yml",
    );
    const call = (
      reusable.on as {
        workflow_call: { inputs: Record<string, unknown> };
      }
    ).workflow_call;
    const applySteps = workflowSteps(reusable, "apply");
    const applyStep = applySteps.find(
      (step) => step.name === "Apply approved Fabric plan",
    );
    const applyWith = applyStep?.with as Record<string, string>;

    expect(call.inputs).toMatchObject({
      allow_network_policy_update: { default: false, type: "boolean" },
      allow_network_policy_relaxation: { default: false, type: "boolean" },
      allow_inbound_firewall_update: {
        default: false,
        type: "boolean",
      },
      allow_inbound_azure_resource_rule_update: {
        default: false,
        type: "boolean",
      },
      allow_inbound_external_data_share_policy_update: {
        default: false,
        type: "boolean",
      },
      allow_inbound_external_data_share_policy_relaxation: {
        default: false,
        type: "boolean",
      },
      acknowledge_firewall_lockout_risk: {
        default: false,
        type: "boolean",
      },
      allow_outbound_cloud_connection_rule_update: {
        default: false,
        type: "boolean",
      },
      allow_outbound_gateway_rule_update: {
        default: false,
        type: "boolean",
      },
      allow_managed_private_endpoint_create: {
        default: false,
        type: "boolean",
      },
      allow_managed_private_endpoint_delete: {
        default: false,
        type: "boolean",
      },
    });
    expect(applyWith["allow-network-policy-update"]).toBe(
      "${{ inputs.allow_network_policy_update }}",
    );
    expect(applyWith["allow-network-policy-relaxation"]).toBe(
      "${{ inputs.allow_network_policy_relaxation }}",
    );
    expect(applyWith["allow-inbound-firewall-update"]).toBe(
      "${{ inputs.allow_inbound_firewall_update }}",
    );
    expect(applyWith["allow-inbound-azure-resource-rule-update"]).toBe(
      "${{ inputs.allow_inbound_azure_resource_rule_update }}",
    );
    expect(
      applyWith["allow-inbound-external-data-share-policy-update"],
    ).toBe("${{ inputs.allow_inbound_external_data_share_policy_update }}");
    expect(
      applyWith["allow-inbound-external-data-share-policy-relaxation"],
    ).toBe(
      "${{ inputs.allow_inbound_external_data_share_policy_relaxation }}",
    );
    expect(applyWith["acknowledge-firewall-lockout-risk"]).toBe(
      "${{ inputs.acknowledge_firewall_lockout_risk }}",
    );
    expect(applyWith["allow-outbound-cloud-connection-rule-update"]).toBe(
      "${{ inputs.allow_outbound_cloud_connection_rule_update }}",
    );
    expect(applyWith["allow-outbound-gateway-rule-update"]).toBe(
      "${{ inputs.allow_outbound_gateway_rule_update }}",
    );
    expect(applyWith["allow-managed-private-endpoint-create"]).toBe(
      "${{ inputs.allow_managed_private_endpoint_create }}",
    );
    expect(applyWith["allow-managed-private-endpoint-delete"]).toBe(
      "${{ inputs.allow_managed_private_endpoint_delete }}",
    );

    const promote = loadYaml(".github/workflows/promote-fabric.yml");
    const promoteInputs = (
      promote.on as { workflow_dispatch: { inputs: Record<string, unknown> } }
    ).workflow_dispatch.inputs;
    const jobs = promote.jobs as Record<string, Record<string, unknown>>;

    expect(promoteInputs).toMatchObject({
      allow_network_policy_update: { required: true, default: false },
      allow_network_policy_relaxation: { required: true, default: false },
      allow_inbound_firewall_update: {
        required: true,
        default: false,
      },
      allow_inbound_azure_resource_rule_update: {
        required: true,
        default: false,
      },
      allow_inbound_external_data_share_policy_update: {
        required: true,
        default: false,
      },
      allow_inbound_external_data_share_policy_relaxation: {
        required: true,
        default: false,
      },
      acknowledge_firewall_lockout_risk: {
        required: true,
        default: false,
      },
      allow_outbound_cloud_connection_rule_update: {
        required: true,
        default: false,
      },
      allow_outbound_gateway_rule_update: {
        required: true,
        default: false,
      },
      allow_managed_private_endpoint_create: {
        required: true,
        default: false,
      },
      allow_managed_private_endpoint_delete: {
        required: true,
        default: false,
      },
    });
    for (const job of ["dev", "test", "prod"]) {
      const jobWith = jobs[job]?.with as Record<string, string>;
      expect(jobWith.allow_network_policy_update).toBe(
        "${{ inputs.allow_network_policy_update }}",
      );
      expect(jobWith.allow_network_policy_relaxation).toBe(
        "${{ inputs.allow_network_policy_relaxation }}",
      );
      expect(jobWith.allow_inbound_firewall_update).toBe(
        "${{ inputs.allow_inbound_firewall_update }}",
      );
      expect(jobWith.allow_inbound_azure_resource_rule_update).toBe(
        "${{ inputs.allow_inbound_azure_resource_rule_update }}",
      );
      expect(
        jobWith.allow_inbound_external_data_share_policy_update,
      ).toBe(
        "${{ inputs.allow_inbound_external_data_share_policy_update }}",
      );
      expect(
        jobWith.allow_inbound_external_data_share_policy_relaxation,
      ).toBe(
        "${{ inputs.allow_inbound_external_data_share_policy_relaxation }}",
      );
      expect(jobWith.acknowledge_firewall_lockout_risk).toBe(
        "${{ inputs.acknowledge_firewall_lockout_risk }}",
      );
      expect(jobWith.allow_outbound_cloud_connection_rule_update).toBe(
        "${{ inputs.allow_outbound_cloud_connection_rule_update }}",
      );
      expect(jobWith.allow_outbound_gateway_rule_update).toBe(
        "${{ inputs.allow_outbound_gateway_rule_update }}",
      );
      expect(jobWith.allow_managed_private_endpoint_create).toBe(
        "${{ inputs.allow_managed_private_endpoint_create }}",
      );
      expect(jobWith.allow_managed_private_endpoint_delete).toBe(
        "${{ inputs.allow_managed_private_endpoint_delete }}",
      );
    }
  });

  it("allows only expected blocked child surfaces during managed workspace bootstrap", () => {
    const reusable = loadYaml(
      ".github/workflows/reusable-fabric-deploy.yml",
    );
    const planSteps = workflowSteps(reusable, "plan");
    const inspectStep = planSteps.find(
      (step) => step.name === "Inspect approved plan",
    );

    expect(inspectStep?.run).toContain(
      ".networkProtection.communicationPolicy",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.outboundCloudConnectionRules",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.inboundFirewallRules",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.inboundAzureResourceRules",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.inboundExternalDataSharesPolicy",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.outboundGatewayRules",
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.managedPrivateEndpoints",
    );
    expect(inspectStep?.run).toContain(
      ".bootstrapBlocked == true",
    );
    expect(inspectStep?.run).toContain(
      '.workspace.action == "create"',
    );
    expect(inspectStep?.run).toContain(
      ".networkProtection.workspaceId == null",
    );
    expect(inspectStep?.run).toContain(
      '.action == "blocked"',
    );
    expect(inspectStep?.run).toContain(
      ".blockedByManagedPrivateEndpoints",
    );
    expect(inspectStep?.run).toContain(
      '.action != "unknown"',
    );
  });

  it("protects reusable apply behind a GitHub Environment", () => {
    const workflow = loadYaml(
      ".github/workflows/reusable-fabric-deploy.yml",
    );
    const call = (
      workflow.on as {
        workflow_call: {
          inputs: Record<string, unknown>;
        };
      }
    ).workflow_call;
    const jobs = workflow.jobs as Record<
      string,
      Record<string, unknown>
    >;

    expect(call.inputs).toMatchObject({
      github_environment: { required: true, type: "string" },
      allow_delete: { default: false, type: "boolean" },
      allow_lakehouse_data_loss: {
        default: false,
        type: "boolean",
      },
    });
    expect(jobs.apply?.environment).toBe(
      "${{ inputs.github_environment }}",
    );
    expect(jobs.apply?.needs).toBe("plan");
  });

  it("serializes all reusable apply mutation jobs across workspace targets", () => {
    const workflow = loadYaml(
      ".github/workflows/reusable-fabric-deploy.yml",
    );
    const jobs = workflow.jobs as Record<
      string,
      Record<string, unknown>
    >;
    const concurrency = jobs.apply?.concurrency as Record<
      string,
      unknown
    >;

    expect(workflow.concurrency).toBeUndefined();
    expect(concurrency.group).toBe("fabric-deploy-apply");
    expect(concurrency.queue).toBe("max");
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  it("promotes dev to test to production in order", () => {
    const workflow = loadYaml(
      ".github/workflows/promote-fabric.yml",
    );
    const jobs = workflow.jobs as Record<
      string,
      Record<string, unknown>
    >;

    expect(jobs.dev?.uses).toBe(
      "./.github/workflows/reusable-fabric-deploy.yml",
    );
    expect(jobs.test?.needs).toBe("dev");
    expect(jobs.prod?.needs).toBe("test");
    expect(jobs.test?.if).toContain("success()");
    expect(jobs.prod?.if).toContain("success()");
    expect(jobs.prod?.if).toContain("inputs.target == 'prod'");
  });

  it("keeps authenticated artifact recovery executable", () => {
    const workflowDirectory = path.join(
      process.cwd(),
      ".github",
      "workflows",
    );
    const workflowFiles = readdirSync(workflowDirectory).filter(
      (file) => file.endsWith(".yml"),
    );

    for (const file of workflowFiles) {
      const source = readFileSync(
        path.join(workflowDirectory, file),
        "utf8",
      );
      expect(source).not.toContain("Authorization: ******");
      expect(() => parse(source)).not.toThrow();
    }

    const reusable = readFileSync(
      path.join(
        workflowDirectory,
        "reusable-fabric-deploy.yml",
      ),
      "utf8",
    );
    expect(reusable).toContain("authorization_header");
    expect(reusable).toContain('--header "$authorization_header"');
  });

  it("keeps the GitHub-hosted inbound network live probe read-only", () => {
    const workflow = loadYaml(
      ".github/workflows/live-fabric-plan.yml",
    );
    const trigger = workflow.on as {
      workflow_dispatch: {
        inputs: Record<string, Record<string, unknown>>;
      };
    };
    const steps = workflowSteps(workflow, "plan");
    const generalPlan = steps.find(
      (step) => step.name === "Plan against Fabric",
    );
    const generalVerification = steps.find(
      (step) => step.name === "Verify live Lakehouse classification",
    );
    const probe = steps.find(
      (step) => step.name === "Read-only inbound network plan probe",
    );
    const verify = steps.find(
      (step) => step.name === "Verify read-only inbound network probe",
    );
    const withValues = probe?.with as Record<string, string>;

    expect(
      trigger.workflow_dispatch.inputs.probe_inbound_firewall,
    ).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(generalPlan?.if).toContain(
      "inputs.probe_inbound_firewall == false",
    );
    expect(generalVerification?.if).toContain(
      "inputs.probe_inbound_firewall == false",
    );
    expect(probe?.if).toContain("inputs.probe_inbound_firewall");
    expect(withValues.mode).toBe("plan");
    expect(withValues.manifest).toBe(
      "examples/inbound-firewall-probe/fabric/deployment.yaml",
    );
    expect(verify?.run).toContain(
      ".networkProtection.inboundAzureResourceRules.ruleCount == 1",
    );
    expect(verify?.run).toContain(
      '.networkProtection.inboundExternalDataSharesPolicy.desiredDefaultAction == "Deny"',
    );
    expect(verify?.run).toContain(
      '.networkProtection.communicationPolicy.desiredInboundDefaultAction == "Allow"',
    );
    expect(
      steps.some(
        (step) =>
          step.name?.toString().toLowerCase().includes("firewall") &&
          (step.with as Record<string, unknown> | undefined)?.mode ===
            "apply",
      ),
    ).toBe(false);
  });

  it("runs live E2E in a disposable workspace", () => {
    const workflow = loadYaml(
      ".github/workflows/live-fabric-e2e.yml",
    );
    const trigger = workflow.on as {
      workflow_dispatch: unknown;
      schedule: unknown[];
    };
    const permissions = workflow.permissions as Record<
      string,
      string
    >;
    const jobs = workflow.jobs as Record<
      string,
      Record<string, unknown>
    >;
    const steps = workflowSteps(workflow, "e2e");
    const stepNames = steps.map((step) => step.name);
    const cleanup = steps.find(
      (step) => step.name === "Delete disposable workspace",
    );

    expect(trigger.workflow_dispatch).toBeDefined();
    expect(trigger.schedule).toHaveLength(1);
    expect(permissions["id-token"]).toBe("write");
    expect(jobs.e2e?.if).toContain("FABRIC_E2E_ENABLED");
    expect(stepNames).toContain("Create disposable workspace");
    expect(stepNames).toContain(
      "Apply core data engineering fixture",
    );
    expect(stepNames).toContain("Apply pipeline fixture");
    expect(stepNames).toContain("Apply tag fixture");
    expect(stepNames).toContain("Verify idempotent no-op plans");
    expect(cleanup?.if).toContain("always()");
    expect(cleanup?.run).toContain(
      "/v1/workspaces/${workspace_id}",
    );
  });

  it("publishes provenance-attested immutable releases", () => {
    const workflow = loadYaml(".github/workflows/release.yml");
    const permissions = workflow.permissions as Record<
      string,
      string
    >;
    const jobs = workflow.jobs as Record<
      string,
      Record<string, unknown>
    >;
    const concurrency = workflow.concurrency as Record<
      string,
      unknown
    >;
    const steps = workflowSteps(workflow, "release");
    const actions = steps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string");
    const commands = steps
      .map((step) => step.run)
      .filter((value): value is string => typeof value === "string")
      .join("\n");

    expect(permissions).toMatchObject({
      contents: "write",
      "id-token": "write",
      attestations: "write",
    });
    expect(jobs.release?.environment).toBe(
      "marketplace-release",
    );
    expect(concurrency.group).toBe("marketplace-release");
    expect(actions).toContain(
      "actions/attest-build-provenance@v3",
    );
    expect(commands).toContain("npm sbom");
    expect(commands).toContain("gh release create");
    expect(commands).toContain("targetCommitish");
    expect(commands).toContain("latest_release");
    expect(commands).toContain(
      'git push origin "refs/tags/${major_tag}" --force',
    );
  });
});
