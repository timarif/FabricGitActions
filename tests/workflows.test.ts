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
