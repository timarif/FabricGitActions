import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { ReportAdapter } from "../src/fabric/report";

const tokenProvider = {
  getToken: async () => "token",
};

function jsonPart(
  partPath: string,
  value: Record<string, unknown>,
) {
  return {
    path: partPath,
    payload: Buffer.from(JSON.stringify(value)).toString("base64"),
    payloadType: "InlineBase64" as const,
  };
}

function reportDefinition(
  modelId = "model-1",
  version = 1,
  includePlatform = false,
): FabricDefinition {
  const parts = [
    jsonPart("definition.pbir", {
      $schema:
        "https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json",
      version: "4.0",
      datasetReference: {
        byConnection: {
          connectionString: `semanticmodelid=${modelId}`,
        },
      },
    }),
    jsonPart("definition/report.json", {
      version,
      themeCollection: {},
    }),
    jsonPart("definition/version.json", {
      version: "1.0.0",
    }),
  ];
  if (includePlatform) {
    parts.push(
      jsonPart(".platform", {
        $schema:
          "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
        config: {
          version: "2.0",
          logicalId: "550e8400-e29b-41d4-a716-446655440000",
        },
        metadata: {
          type: "Report",
          displayName: "Sales Report",
          description: "Managed",
        },
      }),
    );
  }
  return { format: "PBIR", parts };
}

function adapter(fetchImpl: FetchLike): ReportAdapter {
  return new ReportAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Report adapter", () => {
  it("plans no-op and verifies the materialized Semantic Model binding", async () => {
    const requested: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/reports?")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "report-1",
                  displayName: "Sales Report",
                  folderId: "folder-1",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({
              definition: reportDefinition("model-1"),
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "report-1",
            displayName: "Sales Report",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      adapter(fetchImpl).plan(
        "workspace",
        {
          displayName: "Sales Report",
          folderId: "folder-1",
        },
        reportDefinition("model-1"),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "report-1",
    });
    expect(
      requested.find((url) => url.includes("/getDefinition?")),
    ).toContain("format=PBIR");
  });

  it("allows a new Report to wait for a same-apply model and blocks an existing Report", async () => {
    let exists = false;
    const reportAdapter = adapter(
      vi.fn(async (input: string | URL) => {
        if (String(input).includes("/reports?")) {
          return new Response(
            JSON.stringify({
              value: exists
                ? [
                    {
                      id: "report-1",
                      displayName: "Sales Report",
                    },
                  ]
                : [],
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected request");
      }),
    );

    await expect(
      reportAdapter.planUnresolvedReferences(
        "workspace",
        { displayName: "Sales Report" },
        reportDefinition("source"),
        ["salesModel"],
      ),
    ).resolves.toMatchObject({ action: "create" });

    exists = true;
    await expect(
      reportAdapter.planUnresolvedReferences(
        "workspace",
        { displayName: "Sales Report" },
        reportDefinition("source"),
        ["salesModel"],
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "report-1",
    });
  });

  it("finds an existing renamed Report by platform logicalId before approving an unresolved create", async () => {
    const desiredDefinition = reportDefinition(
      "source",
      1,
      true,
    );
    const reportAdapter = adapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/reports?")) {
          return new Response(
            JSON.stringify({
              value: url.includes("recursive=true")
                ? [
                    {
                      id: "renamed-report",
                      displayName: "Old Report Name",
                    },
                  ]
                : [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({
              definition: desiredDefinition,
            }),
            { status: 200 },
          );
        }
        throw new Error("Unexpected request");
      }),
    );

    await expect(
      reportAdapter.planUnresolvedReferences(
        "workspace",
        { displayName: "Sales Report" },
        desiredDefinition,
        ["salesModel"],
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "renamed-report",
    });
  });

  it("plans an update when platform identity resolves a Report under its old display name", async () => {
    const desiredDefinition = reportDefinition(
      "model-1",
      1,
      true,
    );
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/reports?")) {
          return new Response(
            JSON.stringify({
              value: url.includes("recursive=true")
                ? [
                    {
                      id: "renamed-report",
                      displayName: "Old Report Name",
                    },
                  ]
                : [],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({ definition: desiredDefinition }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "renamed-report",
            displayName: "Old Report Name",
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      adapter(fetchImpl).plan(
        "workspace",
        {
          displayName: "Sales Report",
        },
        desiredDefinition,
      ),
    ).resolves.toMatchObject({
      action: "update",
      physicalId: "renamed-report",
      reason: expect.stringContaining("metadata differs"),
    });
  });

  it("blocks folder mismatches instead of attempting a move", async () => {
      const fetchImpl = vi.fn(
        async (input: string | URL) => {
          const url = String(input);
          if (url.includes("/reports?")) {
            return new Response(
              JSON.stringify({
                value: [
                  {
                    id: "report-1",
                    displayName: "Sales Report",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.includes("/getDefinition?")) {
            return new Response(
              JSON.stringify({
                definition: reportDefinition("model-1"),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              id: "report-1",
              displayName: "Sales Report",
              folderId: "different-folder",
            }),
            { status: 200 },
          );
        },
      );

      await expect(
        adapter(fetchImpl).plan(
          "workspace",
          {
            displayName: "Sales Report",
            folderId: "desired-folder",
          },
          reportDefinition("model-1"),
        ),
      ).resolves.toMatchObject({
        action: "blocked",
        reason: expect.stringContaining("folder moves"),
    });
  });

  it("creates through an LRO and never emits sensitivityLabelSettings", async () => {
    let createBody: Record<string, unknown> | undefined;
    const events: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith("/workspaces/workspace/reports")
        ) {
          createBody = JSON.parse(
            String(init.body),
          ) as Record<string, unknown>;
          return new Response(undefined, {
            status: 202,
            headers: {
              "x-ms-operation-id": "create-report",
            },
          });
        }
        if (url.endsWith("/v1/operations/create-report")) {
          events.push("poll");
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/v1/operations/create-report/result")) {
          return new Response(
            JSON.stringify({
              id: "report-1",
              displayName: "Sales Report",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({
              definition: reportDefinition("model-1"),
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "report-1",
            displayName: "Sales Report",
          }),
          { status: 200 },
        );
      },
    );

    await adapter(fetchImpl).create(
      "workspace",
      { displayName: "Sales Report" },
      reportDefinition("model-1"),
      undefined,
      (operation) =>
        events.push(`accepted:${operation.operationId}`),
    );

    expect(events).toEqual(["accepted:create-report", "poll"]);
    expect(createBody).toMatchObject({
      displayName: "Sales Report",
      definition: { format: "PBIR" },
    });
    expect(createBody).not.toHaveProperty(
      "sensitivityLabelSettings",
    );
  });

  it("uses desired platform management to control updateMetadata and preserves omitted auxiliary parts", async () => {
    const requests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    let updated = false;
    const current = reportDefinition("model-1", 1);
    current.parts.push(
      jsonPart(".platform", {
        metadata: { type: "Report", displayName: "Service" },
      }),
      jsonPart("semanticModelDiagramLayout.json", {
        diagrams: [],
      }),
    );
    const desired = reportDefinition("model-1", 2);
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({
          method: init?.method ?? "GET",
          url,
          ...(init?.body
            ? {
                body: JSON.parse(
                  String(init.body),
                ) as Record<string, unknown>,
              }
            : {}),
        });
        if (init?.method === "PATCH") {
          return new Response(
            JSON.stringify({
              id: "report-1",
              displayName: "Sales Report",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          updated = true;
          return new Response(null, { status: 200 });
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({
              definition: updated
                ? {
                    ...desired,
                    parts: [
                      ...desired.parts,
                      ...current.parts.filter(
                        (part) =>
                          part.path === ".platform" ||
                          part.path ===
                            "semanticModelDiagramLayout.json",
                      ),
                    ],
                  }
                : current,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "report-1",
            displayName: "Sales Report",
          }),
          { status: 200 },
        );
      },
    );

    await adapter(fetchImpl).update(
      "workspace",
      "report-1",
      { displayName: "Sales Report" },
      desired,
    );

    expect(
      requests.some(
        ({ url }) =>
          url.includes(
            "/updateDefinition?updateMetadata=false",
          ),
      ),
    ).toBe(true);
    const updateBody = requests.find(({ url }) =>
      url.includes("/updateDefinition?"),
    )?.body;
    const paths = (
      updateBody?.definition as FabricDefinition
    ).parts.map((part) => part.path);
    expect(paths).toContain(".platform");
    expect(paths).toContain("semanticModelDiagramLayout.json");
  });

  it("sets updateMetadata only when desired explicitly manages platform metadata", async () => {
    const requests: string[] = [];
    const desired = reportDefinition("model-1", 2, true);
    let updated = false;
    await adapter(
      vi.fn(
        async (
          input: string | URL,
          init?: RequestInit,
        ) => {
          const url = String(input);
          requests.push(`${init?.method ?? "GET"} ${url}`);
          if (url.includes("/updateDefinition?")) {
            updated = true;
            return new Response(null, { status: 200 });
          }
          if (url.includes("/getDefinition?")) {
            return new Response(
              JSON.stringify({
                definition: updated
                  ? desired
                  : reportDefinition("model-1", 1, true),
              }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              id: "report-1",
              displayName: "Sales Report",
              description: "Managed",
            }),
            { status: 200 },
          );
        },
      ),
    ).update(
      "workspace",
      "report-1",
      {
        displayName: "Sales Report",
        description: "Managed",
      },
      desired,
    );

    expect(
      requests.some((request) => request.startsWith("PATCH ")),
    ).toBe(false);
    expect(
      requests.some((request) =>
        request.includes(
          "/updateDefinition?updateMetadata=true",
        ),
      ),
    ).toBe(true);
  });

  it("blocks planning when an encrypted label makes getDefinition unsupported", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/reports?")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "report-1",
                  displayName: "Sales Report",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({
              errorCode: "OperationNotSupportedForItem",
              message: "Definition is unavailable.",
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "report-1",
            displayName: "Sales Report",
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      adapter(fetchImpl).plan(
        "workspace",
        { displayName: "Sales Report" },
        reportDefinition("model-1"),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "report-1",
      reason: expect.stringContaining("encrypted sensitivity label"),
    });
  });
});
