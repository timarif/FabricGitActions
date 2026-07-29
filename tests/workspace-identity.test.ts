import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  WorkspaceIdentityAdapter,
  type WorkspaceIdentity,
  type WorkspaceRoleAssignment,
} from "../src/fabric/workspace-identity";

const tokenProvider = {
  getToken: async () => "token",
};

const identity: WorkspaceIdentity = {
  applicationId: "app-1",
  servicePrincipalId: "sp-1",
};

function createAdapter(fetchImpl: FetchLike): WorkspaceIdentityAdapter {
  return new WorkspaceIdentityAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
      operationPollIntervalMs: 1,
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function assignment(
  id: string,
  role: WorkspaceRoleAssignment["role"] = "Contributor",
  overrides: Omit<Partial<WorkspaceRoleAssignment>, "principal"> & {
    principal?: Partial<WorkspaceRoleAssignment["principal"]>;
  } = {},
): WorkspaceRoleAssignment {
  const { principal: principalOverride, ...assignmentOverrides } = overrides;
  return {
    id,
    principal: {
      id: identity.servicePrincipalId,
      type: "ServicePrincipal",
      displayName: "Managed workspace identity",
      servicePrincipalDetails: { aadAppId: identity.applicationId },
      ...principalOverride,
    },
    role,
    ...assignmentOverrides,
  };
}

describe("WorkspaceIdentityAdapter", () => {
  it("plans identity creation and defers every role when identity is absent", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "source-workspace" }),
    );
    const adapter = createAdapter(fetchImpl);

    const plan = await adapter.plan("source-workspace", {
      provision: true,
      roleAssignments: [
        { role: "Contributor" },
        { workspaceId: "target-workspace", role: "Viewer" },
      ],
    });

    expect(plan).toMatchObject({
      action: "create",
      roleAssignments: [
        {
          action: "blocked",
          targetWorkspaceId: "source-workspace",
          role: "Contributor",
        },
        {
          action: "blocked",
          targetWorkspaceId: "target-workspace",
          role: "Viewer",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("plans a missing role assignment as create and ignores unrelated principals", async () => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.endsWith("/v1/workspaces/source-workspace")) {
          return jsonResponse({
            id: "source-workspace",
            workspaceIdentity: identity,
          });
        }
        return jsonResponse({
          value: [
            {
              id: "unrelated",
              principal: { id: "someone-else", type: "User" },
              role: "Admin",
            },
          ],
        });
      }),
    );

    const plan = await adapter.plan("source-workspace", {
      provision: true,
      roleAssignments: [{ role: "Contributor" }],
    });

    expect(plan).toMatchObject({
      action: "update",
      applicationId: "app-1",
      servicePrincipalId: "sp-1",
      roleAssignments: [
        {
          action: "create",
          targetWorkspaceId: "source-workspace",
          role: "Contributor",
        },
      ],
    });
  });

  it("plans an exact existing role assignment as no-op", async () => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/roleAssignments")
          ? jsonResponse({ value: [assignment("assignment-1")] })
          : jsonResponse({
              id: "source-workspace",
              workspaceIdentity: identity,
            }),
      ),
    );

    const plan = await adapter.plan("source-workspace", {
      provision: true,
      roleAssignments: [{ role: "Contributor" }],
    });

    expect(plan.roleAssignments).toEqual([
      expect.objectContaining({
        action: "no-op",
        assignmentId: "assignment-1",
      }),
    ]);
  });

  it("does not include unrelated principals in managed observed hashes", async () => {
    const planWithUnrelated = async (
      unrelatedRole: WorkspaceRoleAssignment["role"],
    ) =>
      createAdapter(
        vi.fn(async (input: string | URL) =>
          String(input).endsWith("/roleAssignments")
            ? jsonResponse({
                value: [
                  {
                    id: "unrelated",
                    principal: { id: "someone-else", type: "User" },
                    role: unrelatedRole,
                  },
                ],
              })
            : jsonResponse({
                id: "source-workspace",
                workspaceIdentity: identity,
              }),
        ),
      ).plan("source-workspace", {
        provision: true,
        roleAssignments: [{ role: "Contributor" }],
      });

    const adminPlan = await planWithUnrelated("Admin");
    const viewerPlan = await planWithUnrelated("Viewer");

    expect(adminPlan.observedStateHash).toBe(viewerPlan.observedStateHash);
    expect(adminPlan.roleAssignments[0]?.observedStateHash).toBe(
      viewerPlan.roleAssignments[0]?.observedStateHash,
    );
  });

  it.each([
    {
      name: "a different role",
      assignments: [assignment("assignment-1", "Viewer")],
    },
    {
      name: "a mismatched application ID",
      assignments: [
        assignment("assignment-1", "Contributor", {
          principal: {
            servicePrincipalDetails: { aadAppId: "different-app" },
          },
        }),
      ],
    },
  ])("blocks $name for the managed principal", async ({ assignments }) => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/roleAssignments")
          ? jsonResponse({ value: assignments })
          : jsonResponse({
              id: "source-workspace",
              workspaceIdentity: identity,
            }),
      ),
    );

    const plan = await adapter.plan("source-workspace", {
      provision: true,
      roleAssignments: [{ role: "Contributor" }],
    });

    expect(plan.roleAssignments[0]).toMatchObject({ action: "blocked" });
  });

  it("blocks duplicate assignments for the managed principal", async () => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/roleAssignments")
          ? jsonResponse({
              value: [
                assignment("assignment-1"),
                assignment("assignment-2"),
              ],
            })
          : jsonResponse({
              id: "source-workspace",
              workspaceIdentity: identity,
            }),
      ),
    );

    const plan = await adapter.plan("source-workspace", {
      provision: true,
      roleAssignments: [{ role: "Contributor" }],
    });

    expect(plan.roleAssignments[0]).toMatchObject({ action: "blocked" });
    expect(plan.roleAssignments[0]?.reason).toContain("duplicate");
  });

  it.each([
    {
      principal: {
        id: "sp-1",
        type: "ServicePrincipal",
        displayName: 42,
      },
    },
    {
      principal: {
        id: "sp-1",
        type: "ServicePrincipal",
        servicePrincipalDetails: "malformed",
      },
    },
    {
      principal: {
        id: "sp-1",
        type: "ServicePrincipal",
        servicePrincipalDetails: { aadAppId: " " },
      },
    },
  ])("fails closed for malformed nested principal details", async (entry) => {
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) =>
        String(input).endsWith("/roleAssignments")
          ? jsonResponse({
              value: [{ id: "assignment-1", role: "Contributor", ...entry }],
            })
          : jsonResponse({
              id: "source-workspace",
              workspaceIdentity: identity,
            }),
      ),
    );

    await expect(
      adapter.plan("source-workspace", {
        provision: true,
        roleAssignments: [{ role: "Contributor" }],
      }),
    ).rejects.toThrow();
  });

  it("provisions synchronously without a body and verifies canonical read-back", async () => {
    const lifecycle: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          lifecycle.push("POST");
          expect(init.body).toBeUndefined();
          return jsonResponse(identity, 200);
        }
        expect(url).toMatch(/\/v1\/workspaces\/source-workspace$/);
        return jsonResponse({
          id: "source-workspace",
          workspaceIdentity: identity,
        });
      },
    );
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.provision("source-workspace", {
      onProvisionSubmitting: () => lifecycle.push("SUBMITTING"),
      onProvisionAccepted: (operation) => {
        expect(operation).toBeUndefined();
        lifecycle.push("ACCEPTED");
      },
    });

    expect(result).toEqual(identity);
    expect(lifecycle).toEqual(["SUBMITTING", "POST", "ACCEPTED"]);
  });

  it("captures a 202 operation before polling and verifies canonical read-back", async () => {
    const lifecycle: string[] = [];
    const accepted = vi.fn();
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          lifecycle.push("POST");
          return new Response(undefined, {
            status: 202,
            headers: {
              "x-ms-operation-id": "operation-1",
              location:
                "https://api.fabric.microsoft.com/v1/operations/operation-1",
            },
          });
        }
        if (url.endsWith("/v1/operations/operation-1")) {
          lifecycle.push("POLL");
          return jsonResponse({ status: "Succeeded" });
        }
        if (url.endsWith("/v1/operations/operation-1/result")) {
          return jsonResponse(identity);
        }
        return jsonResponse({
          id: "source-workspace",
          workspaceIdentity: identity,
        });
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.provision("source-workspace", {
      onProvisionSubmitting: () => lifecycle.push("SUBMITTING"),
      onProvisionAccepted: (operation) => {
        lifecycle.push("ACCEPTED");
        accepted(operation);
      },
    });

    expect(accepted).toHaveBeenCalledWith({
      operationId: "operation-1",
      location:
        "https://api.fabric.microsoft.com/v1/operations/operation-1",
    });
    expect(lifecycle.slice(0, 4)).toEqual([
      "SUBMITTING",
      "POST",
      "ACCEPTED",
      "POLL",
    ]);
  });

  it("resumes a saved accepted provisioning operation without redispatching", async () => {
    const methods: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        methods.push(init?.method ?? "GET");
        if (url.endsWith("/v1/operations/operation-1")) {
          return jsonResponse({ status: "Succeeded" });
        }
        if (url.endsWith("/v1/operations/operation-1/result")) {
          return jsonResponse(identity);
        }
        return jsonResponse({
          id: "source-workspace",
          workspaceIdentity: identity,
        });
      }),
    );

    await expect(
      adapter.resumeProvision("source-workspace", {
        phase: "accepted",
        operationReference: { operationId: "operation-1" },
      }),
    ).resolves.toEqual(identity);
    expect(methods.every((method) => method === "GET")).toBe(true);
  });

  it("adopts an identity during submitting recovery but fails closed when absent", async () => {
    const adopting = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          id: "source-workspace",
          workspaceIdentity: identity,
        }),
      ),
    );
    await expect(
      adopting.resumeProvision("source-workspace", {
        phase: "submitting",
      }),
    ).resolves.toEqual(identity);

    const ambiguousFetch = vi.fn(async () =>
      jsonResponse({ id: "source-workspace" }),
    );
    await expect(
      createAdapter(ambiguousFetch).resumeProvision("source-workspace", {
        phase: "submitting",
      }),
    ).rejects.toThrow("ambiguous recovery state");
    expect(ambiguousFetch).toHaveBeenCalledTimes(1);
  });

  it("creates a role assignment with the GA body and verifies its exact ID", async () => {
    const lifecycle: string[] = [];
    let requestBody: unknown;
    const created = assignment("assignment-1");
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          lifecycle.push("POST");
          requestBody = JSON.parse(String(init.body));
          return jsonResponse(created, 201);
        }
        expect(url).toMatch(
          /\/v1\/workspaces\/target-workspace\/roleAssignments$/,
        );
        return jsonResponse({ value: [created] });
      }),
    );

    const result = await adapter.createRoleAssignment(
      "source-workspace",
      identity,
      { workspaceId: "target-workspace", role: "Contributor" },
      {
        onRoleAssignmentSubmitting: () => lifecycle.push("SUBMITTING"),
        onRoleAssignmentAccepted: (id) =>
          lifecycle.push(`ACCEPTED:${id}`),
      },
    );

    expect(requestBody).toEqual({
      principal: { id: "sp-1", type: "ServicePrincipal" },
      role: "Contributor",
    });
    expect(result).toEqual(created);
    expect(lifecycle).toEqual([
      "SUBMITTING",
      "POST",
      "ACCEPTED:assignment-1",
    ]);
  });

  it("adopts exactly one matching role assignment during submitting recovery", async () => {
    const accepted = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ value: [assignment("assignment-1")] }),
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.resumeRoleAssignment(
        "source-workspace",
        identity,
        { role: "Contributor" },
        { phase: "submitting" },
        { onRoleAssignmentAccepted: accepted },
      ),
    ).resolves.toMatchObject({ id: "assignment-1" });

    expect(accepted).toHaveBeenCalledWith("assignment-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "no assignment", assignments: [] },
    {
      name: "duplicate assignments",
      assignments: [
        assignment("assignment-1"),
        assignment("assignment-2"),
      ],
    },
    {
      name: "a conflicting role",
      assignments: [assignment("assignment-1", "Viewer")],
    },
  ])(
    "fails closed for submitting role recovery with $name",
    async ({ assignments }) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ value: assignments }));
      const adapter = createAdapter(fetchImpl);

      await expect(
        adapter.resumeRoleAssignment(
          "source-workspace",
          identity,
          { role: "Contributor" },
          { phase: "submitting" },
        ),
      ).rejects.toThrow("ambiguous recovery state");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("resumes an accepted role assignment by verifying the exact saved ID", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          value: [
            assignment("other-assignment"),
            assignment("assignment-1"),
          ],
        }),
      ),
    );

    await expect(
      adapter.resumeRoleAssignment(
        "source-workspace",
        identity,
        { role: "Contributor" },
        { phase: "accepted", assignmentId: "assignment-1" },
      ),
    ).resolves.toMatchObject({ id: "assignment-1" });
  });

  it.each([
    { workspaceIdentity: { applicationId: "app-1" } },
    { workspaceIdentity: { servicePrincipalId: "sp-1" } },
    { workspaceIdentity: "not-an-object" },
    { workspaceIdentity: { applicationId: " ", servicePrincipalId: "sp-1" } },
  ])("fails closed for partial or malformed identity read-back", async (body) => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ id: "source-workspace", ...body }),
      ),
    );

    await expect(
      adapter.verifyIdentity("source-workspace"),
    ).rejects.toThrow();
  });

  it("validates nonblank IDs and exact supported roles before dispatch", async () => {
    const fetchImpl = vi.fn();
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.createRoleAssignment(
        "source-workspace",
        identity,
        { workspaceId: " ", role: "Contributor" },
      ),
    ).rejects.toThrow("nonblank");
    await expect(
      adapter.createRoleAssignment(
        "source-workspace",
        identity,
        { role: "contributor" as "Contributor" },
      ),
    ).rejects.toThrow("Admin, Member, Contributor, Viewer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
