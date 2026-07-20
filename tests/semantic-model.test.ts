import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { SemanticModelAdapter } from "../src/fabric/semantic-model";
import {
  auxiliarySemanticModelParts,
  hashAuxiliarySemanticModelParts,
  hashSemanticModelDefinition,
} from "../src/fabric/semantic-model-definition";
import type { DefinitionItemUpdateRecoveryState } from "../src/types";

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

/** Builds a v2 `.platform` part with a UUID logicalId. */
function platformV2Part(logicalId: string, displayName = "Sales") {
  return jsonPart(".platform", {
    $schema:
      "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    config: {
      version: "2.0",
      logicalId,
    },
    metadata: {
      type: "SemanticModel",
      displayName,
    },
  });
}

function semanticDefinition(
  format: "TMSL" | "TMDL" = "TMSL",
  version = 1,
  includePlatform = false,
): FabricDefinition {
  const parts =
    format === "TMSL"
      ? [
          jsonPart("model.bim", {
            compatibilityLevel: 1702,
            model: {
              culture: "en-US",
              annotations: [{ name: "version", value: version }],
              tables: [],
            },
          }),
        ]
      : [
          {
            path: "definition/model.tmdl",
            payload: Buffer.from(
              `model Model\nannotation version = ${version}\n`,
            ).toString("base64"),
            payloadType: "InlineBase64" as const,
          },
        ];
  parts.push(
    jsonPart("definition.pbism", {
      version: "5.0",
      settings: { qnaEnabled: false },
    }),
  );
  if (includePlatform) {
    parts.push(
      jsonPart(".platform", {
        metadata: {
          type: "SemanticModel",
          displayName: "Sales",
          description: "Managed",
        },
      }),
    );
  }
  return { format, parts };
}

function definitionResponse(
  format: "TMSL" | "TMDL" = "TMSL",
  version = 1,
  includePlatform = false,
) {
  return {
    definition: semanticDefinition(
      format,
      version,
      includePlatform,
    ),
  };
}

function createAdapter(fetchImpl: FetchLike): SemanticModelAdapter {
  return new SemanticModelAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Semantic Model adapter", () => {
  it.each(["TMSL", "TMDL"] as const)(
    "uses format=%s and plans a no-op for matching definitions",
    async (format) => {
      const requestedUrls: string[] = [];
      const fetchImpl = vi.fn(
        async (input: string | URL) => {
          const url = String(input);
          requestedUrls.push(url);
          if (url.includes("/semanticModels?")) {
            return new Response(
              JSON.stringify({
                value: [
                  {
                    id: "model-1",
                    displayName: "Sales",
                    folderId: "folder-1",
                  },
                ],
              }),
              { status: 200 },
            );
          }
          if (url.includes("/getDefinition?")) {
            return new Response(
              JSON.stringify(definitionResponse(format)),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              id: "model-1",
              displayName: "Sales",
              folderId: "folder-1",
            }),
            { status: 200 },
          );
        },
      );
      const adapter = createAdapter(fetchImpl);

      await expect(
        adapter.plan(
          "workspace",
          { displayName: "Sales", folderId: "folder-1" },
          semanticDefinition(format),
        ),
      ).resolves.toMatchObject({
        action: "no-op",
        physicalId: "model-1",
        managedMetadataMatches: true,
      });
      expect(requestedUrls[0]).toContain(
        "/semanticModels?recursive=false",
      );
      expect(requestedUrls[0]).toContain(
        "rootFolderId=folder-1",
      );
      expect(
        requestedUrls.find((url) =>
          url.includes("/getDefinition?"),
        ),
      ).toContain(`format=${format}`);
    },
  );

  it("plans an update when the definition differs and blocks folder moves", async () => {
    let currentFolder = "folder-1";
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/semanticModels?")) {
          return new Response(
            JSON.stringify({
              value: [
                { id: "model-1", displayName: "Sales" },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify(definitionResponse("TMSL", 2)),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Sales",
            folderId: currentFolder,
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Sales", folderId: "folder-1" },
        semanticDefinition("TMSL", 1),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
      stagedDefinitionHash: expect.any(String),
    });

    currentFolder = "different-folder";
    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Sales", folderId: "folder-1" },
        semanticDefinition("TMSL", 1),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      managedMetadataMatches: false,
    });
  });

  it("treats omitted current Copilot parts as preserved during plan and verification", async () => {
    const desired = semanticDefinition("TMSL", 1);
    desired.parts.push(
      jsonPart("Copilot/managed.json", { enabled: true }),
    );
    const current: FabricDefinition = {
      ...desired,
      parts: [
        ...desired.parts,
        jsonPart("Copilot/service-state.json", {
          generated: true,
        }),
      ],
    };
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/semanticModels?")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "model-1",
                  displayName: "Sales",
                  folderId: "folder-1",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?")) {
          return new Response(
            JSON.stringify({ definition: current }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Sales",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);
    const desiredItem = {
      displayName: "Sales",
      folderId: "folder-1",
    };

    await expect(
      adapter.plan("workspace", desiredItem, desired),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "model-1",
    });
    await expect(
      adapter.verify(
        "workspace",
        "model-1",
        desiredItem,
        desired,
      ),
    ).resolves.toMatchObject({ id: "model-1" });
  });

  it("resolves renamed Semantic Models by stable platform logicalId", async () => {
    const logicalId =
      "550e8400-e29b-41d4-a716-446655440000";
    const currentDefinition = semanticDefinition("TMSL", 1);
    currentDefinition.parts.push(
      platformV2Part(logicalId, "Original Sales"),
    );
    const desiredDefinition = semanticDefinition("TMSL", 1);
    desiredDefinition.parts.push(
      platformV2Part(logicalId, "Renamed Sales"),
    );
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("/semanticModels?")) {
          return new Response(
            JSON.stringify({
              value: url.includes("recursive=true")
                ? [
                    {
                      id: "model-1",
                      displayName: "Original Sales",
                      folderId: "folder-1",
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
              definition: currentDefinition,
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Original Sales",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        {
          displayName: "Renamed Sales",
          folderId: "folder-1",
        },
        desiredDefinition,
      ),
    ).resolves.toMatchObject({
      action: "update",
      physicalId: "model-1",
    });
    expect(
      requestedUrls.some((url) =>
        url.includes("recursive=true"),
      ),
    ).toBe(true);
  });

  it("creates through an LRO, checkpoints acceptance, and omits sensitivity settings", async () => {
    const events: string[] = [];
    let createBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith(
            "/workspaces/workspace/semanticModels",
          )
        ) {
          createBody = JSON.parse(
            String(init.body),
          ) as Record<string, unknown>;
          return new Response(undefined, {
            status: 202,
            headers: {
              "x-ms-operation-id": "create-operation",
            },
          });
        }
        if (url.endsWith("/v1/operations/create-operation")) {
          events.push("poll");
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        if (
          url.endsWith(
            "/v1/operations/create-operation/result",
          )
        ) {
          return new Response(
            JSON.stringify({
              id: "model-1",
              displayName: "Sales",
              description: "Managed",
              folderId: "folder-1",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?format=TMSL")) {
          return new Response(
            JSON.stringify(definitionResponse()),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Sales",
            description: "Managed",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    const created = await adapter.create(
      "workspace",
      {
        displayName: "Sales",
        description: "Managed",
        folderId: "folder-1",
      },
      semanticDefinition(),
      undefined,
      (operation) => {
        events.push(`accepted:${operation.operationId}`);
      },
    );

    expect(created.id).toBe("model-1");
    expect(events).toEqual([
      "accepted:create-operation",
      "poll",
    ]);
    expect(createBody).toMatchObject({
      displayName: "Sales",
      description: "Managed",
      folderId: "folder-1",
      definition: { format: "TMSL" },
    });
    expect(createBody).not.toHaveProperty(
      "sensitivityLabelSettings",
    );
  });

  it("patches unmanaged metadata, performs full replacement, and waits for update LRO verification", async () => {
    const requests: string[] = [];
    const checkpoints: string[] = [];
    let definitionVersion = 1;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (
          init?.method === "PATCH" &&
          url.endsWith("/semanticModels/model-1")
        ) {
          return new Response(
            JSON.stringify({
              id: "model-1",
              displayName: "Sales",
              description: "Managed",
            }),
            { status: 200 },
          );
        }
        if (
          url.includes(
            "/updateDefinition?updateMetadata=false",
          )
        ) {
          definitionVersion = 2;
          return new Response(undefined, {
            status: 202,
            headers: { "x-ms-operation-id": "update-operation" },
          });
        }
        if (url.endsWith("/v1/operations/update-operation")) {
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        if (url.includes("/getDefinition?format=TMSL")) {
          return new Response(
            JSON.stringify(
              definitionResponse("TMSL", definitionVersion),
            ),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Sales",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales", description: "Managed" },
      semanticDefinition("TMSL", 2),
      undefined,
      (state) => {
        if (state) {
          checkpoints.push(state.phase);
        }
      },
    );

    expect(
      requests.some(
        (request) =>
          request.startsWith("PATCH ") &&
          request.endsWith("/semanticModels/model-1"),
      ),
    ).toBe(true);
    expect(
      requests.some((request) =>
        request.includes(
          "/updateDefinition?updateMetadata=false",
        ),
      ),
    ).toBe(true);
    expect(checkpoints).toEqual([
      "metadata-submitting",
      "metadata-updated",
      "definition-submitting",
      "definition-staged",
    ]);
    const pollIndex = requests.findIndex((request) =>
      request.endsWith("/v1/operations/update-operation"),
    );
    const finalReadIndex = requests.reduce(
      (lastIndex, request, index) =>
        request.includes("/getDefinition?format=TMSL")
          ? index
          : lastIndex,
      -1,
    );
    expect(finalReadIndex).toBeGreaterThan(pollIndex);
  });

  it("lets managed .platform metadata travel only with updateDefinition", async () => {
    const requests: string[] = [];
    const definition = semanticDefinition(
      "TMSL",
      1,
      true,
    );
    const adapter = createAdapter(
      vi.fn(
        async (
          input: string | URL,
          init?: RequestInit,
        ) => {
          const url = String(input);
          requests.push(`${init?.method ?? "GET"} ${url}`);
          if (
            url.includes(
              "/updateDefinition?updateMetadata=true",
            )
          ) {
            return new Response(null, { status: 200 });
          }
          if (url.includes("/getDefinition?format=TMSL")) {
            return new Response(
              JSON.stringify({ definition }),
              { status: 200 },
            );
          }
          return new Response(
            JSON.stringify({
              id: "model-1",
              displayName: "Sales",
              description: "Managed",
            }),
            { status: 200 },
          );
        },
      ),
    );

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales", description: "Managed" },
      definition,
    );

    expect(
      requests.some((request) =>
        request.startsWith("PATCH "),
      ),
    ).toBe(false);
    expect(
      requests.some((request) =>
        request.includes(
          "/updateDefinition?updateMetadata=true",
        ),
      ),
    ).toBe(true);
  });

  it("reads a definition through a getDefinition LRO and rejects duplicate folder-scoped names", async () => {
    const lroAdapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/getDefinition?format=TMDL")) {
          return new Response(undefined, {
            status: 202,
            headers: {
              "x-ms-operation-id": "definition-operation",
            },
          });
        }
        if (
          url.endsWith("/v1/operations/definition-operation")
        ) {
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        if (
          url.endsWith(
            "/v1/operations/definition-operation/result",
          )
        ) {
          return new Response(
            JSON.stringify(definitionResponse("TMDL")),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    await expect(
      lroAdapter.getDefinition(
        "workspace",
        "model-1",
        semanticDefinition("TMDL"),
      ),
    ).resolves.toMatchObject({ format: "TMDL" });

    const duplicateAdapter = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [
              { id: "one", displayName: "Sales" },
              { id: "two", displayName: "Sales" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      duplicateAdapter.plan(
        "workspace",
        { displayName: "Sales" },
        semanticDefinition(),
      ),
    ).rejects.toThrow("Multiple Semantic Models");
  });
});

describe("Semantic Model full-replacement update safety", () => {
  // Valid RFC 4122 UUIDs (version 4, variant 8).
  const CURRENT_LOGICAL_ID = "12345678-1234-4234-8234-1234567890ab";
  const DESIRED_LOGICAL_ID = "87654321-4321-4321-8321-ba0987654321";

  it("blocks plan when current and desired .platform logicalIds differ", async () => {
    const desiredDef = semanticDefinition("TMSL", 1, false);
    desiredDef.parts.push(platformV2Part(DESIRED_LOGICAL_ID));

    const currentDef = semanticDefinition("TMSL", 1, false);
    currentDef.parts.push(platformV2Part(CURRENT_LOGICAL_ID));

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/semanticModels?")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "model-1", displayName: "Sales" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/getDefinition?")) {
        return new Response(
          JSON.stringify({ definition: currentDef }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: "model-1", displayName: "Sales" }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.plan(
      "workspace",
      { displayName: "Sales" },
      desiredDef,
    );

    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("logicalId mismatch");
    expect(result.reason).toContain(CURRENT_LOGICAL_ID);
    expect(result.reason).toContain(DESIRED_LOGICAL_ID);
  });

  it("does not block plan when only one side carries a logicalId", async () => {
    const desiredDef = semanticDefinition("TMSL", 1, false);
    desiredDef.parts.push(platformV2Part(DESIRED_LOGICAL_ID));

    // Current has no .platform → no logicalId extracted.
    const currentDef = semanticDefinition("TMSL", 1, false);

    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/semanticModels?")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "model-1", displayName: "Sales" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/getDefinition?")) {
        return new Response(
          JSON.stringify({ definition: currentDef }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: "model-1", displayName: "Sales" }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.plan(
      "workspace",
      { displayName: "Sales" },
      desiredDef,
    );

    // One-sided logicalId should not block; result should be update (definition differs).
    expect(result.action).not.toBe("blocked");
  });

  it("sends effectiveDefinition preserving current aux parts not in desired", async () => {
    let updateBody: Record<string, unknown> | null = null;
    let updateUrl = "";

    const diagramPart = jsonPart("diagramLayout.json", {
      diagrams: [],
    });
    const platformPart = jsonPart(".platform", {
      metadata: { type: "SemanticModel", displayName: "Sales" },
    });

    const currentDef = semanticDefinition("TMSL", 1, false);
    currentDef.parts.push(diagramPart, platformPart);

    // Desired v=2 without aux — effective will be v=2 + diagramLayout + .platform.
    const desired = semanticDefinition("TMSL", 2, false);
    const verifyDef: FabricDefinition = {
      ...desired,
      parts: [...desired.parts, diagramPart, platformPart],
    };

    let getDefinitionCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/getDefinition?")) {
          getDefinitionCalls++;
          // 1st call: always-fetch before staging.
          // Subsequent calls: verify readback — return effective definition.
          return new Response(
            JSON.stringify({
              definition:
                getDefinitionCalls === 1 ? currentDef : verifyDef,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          updateUrl = url;
          updateBody = JSON.parse(
            init?.body as string,
          ) as Record<string, unknown>;
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: "model-1", displayName: "Sales" }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales" },
      desired,
    );

    // At least one getDefinition call for the always-fetch pre-update fetch.
    expect(getDefinitionCalls).toBeGreaterThanOrEqual(1);
    const body = updateBody as unknown as {
      definition?: { parts?: Array<{ path: string }> };
    };
    const paths = (body?.definition?.parts ?? []).map(
      (p) => p.path,
    );
    expect(paths).toContain(".platform");
    expect(paths).toContain("diagramLayout.json");
    expect(updateUrl).toContain(
      "/updateDefinition?updateMetadata=false",
    );
  });

  it("checkpoints the full effective auxiliary hash before definition dispatch", async () => {
    const checkpoints: Array<
      DefinitionItemUpdateRecoveryState | undefined
    > = [];
    const events: string[] = [];

    const diagramPart = jsonPart("diagramLayout.json", {
      diagrams: [],
    });
    const currentDef = semanticDefinition("TMSL", 1, false);
    currentDef.parts.push(diagramPart);

    const desired = semanticDefinition("TMSL", 2, false);
    desired.parts.push(
      platformV2Part(
        "550e8400-e29b-41d4-a716-446655440000",
      ),
    );
    const verifyDef: FabricDefinition = {
      ...desired,
      parts: [...desired.parts, diagramPart],
    };

    let getDefinitionCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/getDefinition?")) {
          getDefinitionCalls++;
          return new Response(
            JSON.stringify({
              definition:
                getDefinitionCalls === 1 ? currentDef : verifyDef,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          events.push("dispatch");
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: "model-1", displayName: "Sales" }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales" },
      desired,
      undefined,
      (state) => {
        checkpoints.push(state);
        if (state) {
          events.push(state.phase);
        }
      },
    );

    const submitting = checkpoints.find(
      (cp) => cp?.phase === "definition-submitting",
    );
    const staged = checkpoints.find(
      (cp) => cp?.phase === "definition-staged",
    );
    const expectedAuxiliaryHash =
      hashAuxiliarySemanticModelParts(
        auxiliarySemanticModelParts(verifyDef),
      );
    expect(submitting?.preservedAuxiliaryHash).toBe(
      expectedAuxiliaryHash,
    );
    expect(staged).toBeDefined();
    expect(staged?.preservedAuxiliaryHash).toBe(
      expectedAuxiliaryHash,
    );
    expect(events.indexOf("definition-submitting")).toBeLessThan(
      events.indexOf("dispatch"),
    );
  });

  it("checkpoints the effective target hash when preserving omitted Copilot parts", async () => {
    const checkpoints: Array<
      DefinitionItemUpdateRecoveryState | undefined
    > = [];
    const currentDef = semanticDefinition("TMSL", 1);
    currentDef.parts.push(
      jsonPart("Copilot/managed.json", { enabled: false }),
      jsonPart("Copilot/service-state.json", {
        generated: true,
      }),
    );
    const desired = semanticDefinition("TMSL", 2);
    desired.parts.push(
      jsonPart("Copilot/managed.json", { enabled: true }),
    );
    const effective: FabricDefinition = {
      ...desired,
      parts: [
        ...desired.parts,
        jsonPart("Copilot/service-state.json", {
          generated: true,
        }),
      ],
    };
    let getDefinitionCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/getDefinition?")) {
          getDefinitionCalls++;
          return new Response(
            JSON.stringify({
              definition:
                getDefinitionCalls === 1
                  ? currentDef
                  : effective,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify({
            id: "model-1",
            displayName: "Sales",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales" },
      desired,
      undefined,
      (state) => checkpoints.push(state),
    );

    const staged = checkpoints.find(
      (checkpoint) =>
        checkpoint?.phase === "definition-staged",
    );
    expect(staged?.stagedDefinitionHash).toBe(
      hashSemanticModelDefinition(
        effective,
        false,
        false,
        true,
      ),
    );
    expect(staged?.stagedDefinitionHash).not.toBe(
      hashSemanticModelDefinition(
        desired,
        false,
        false,
        true,
      ),
    );
  });

  it("checkpoints the canonical empty auxiliary hash when no aux parts exist", async () => {
    const checkpoints: Array<
      DefinitionItemUpdateRecoveryState | undefined
    > = [];

    // Current definition has NO aux parts; effective = desired (no preserved).
    const currentDef = semanticDefinition("TMSL", 1, false);
    const desired = semanticDefinition("TMSL", 2, false);

    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("/getDefinition?")) {
          // Both calls (pre-update and verify) return a v=2 definition;
          // desired is v=2 and current (no aux) means effectiveDefinition = desired.
          return new Response(
            JSON.stringify({
              definition: desired,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: "model-1", displayName: "Sales" }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "model-1",
      { displayName: "Sales" },
      desired,
      undefined,
      (state) => {
        checkpoints.push(state);
      },
    );

    const submitting = checkpoints.find(
      (cp) => cp?.phase === "definition-submitting",
    );
    expect(submitting?.preservedAuxiliaryHash).toBe(
      hashAuxiliarySemanticModelParts([]),
    );
  });

  it("verify throws when preserved aux parts are absent after update", async () => {
    // Current definition has diagramLayout.json; post-update the service
    // returns a definition without it (simulates silent aux-part loss).
    const diagramPart = jsonPart("diagramLayout.json", {
      diagrams: [],
    });
    const currentDef = semanticDefinition("TMSL", 1, false);
    currentDef.parts.push(diagramPart);

    // Post-update definition intentionally lacks diagramLayout.json.
    const postUpdateDef = semanticDefinition("TMSL", 2, false);

    let getDefinitionCalls = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/getDefinition?")) {
          getDefinitionCalls++;
          // 1st call: always-fetch in update(); subsequent: post-update verify.
          return new Response(
            JSON.stringify({
              definition:
                getDefinitionCalls === 1
                  ? currentDef
                  : postUpdateDef,
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?")) {
          return new Response(null, { status: 200 });
        }
        return new Response(
          JSON.stringify({ id: "model-1", displayName: "Sales" }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);
    const desired = semanticDefinition("TMSL", 2, false);

    await expect(
      adapter.update(
        "workspace",
        "model-1",
        { displayName: "Sales" },
        desired,
      ),
    ).rejects.toThrow("verification failed");
  });
});
