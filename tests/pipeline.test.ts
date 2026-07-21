import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { PipelineAdapter } from "../src/fabric/pipeline";

const tokenProvider = {
  getToken: async () => "token",
};

function pipelineDefinition(
  waitTimeInSeconds = 1,
  includePlatform = false,
): FabricDefinition {
  const definition: FabricDefinition = {
    parts: [
      {
        path: "pipeline-content.json",
        payload: Buffer.from(
          JSON.stringify({
            properties: {
              activities: [
                {
                  name: "Wait1",
                  type: "Wait",
                  dependsOn: [],
                  typeProperties: { waitTimeInSeconds },
                },
              ],
            },
          }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
  if (includePlatform) {
    definition.parts.push({
      path: ".platform",
      payload: Buffer.from(
        JSON.stringify({
          metadata: {
            type: "DataPipeline",
            displayName: "Hello",
            description: "Managed",
          },
        }),
      ).toString("base64"),
      payloadType: "InlineBase64",
    });
  }
  return definition;
}

function definitionResponse(
  waitTimeInSeconds = 1,
  includePlatform = true,
): object {
  const definition = pipelineDefinition(
    waitTimeInSeconds,
    includePlatform,
  );
  return {
    definition: {
      format: "service-default",
      parts: definition.parts.map((part) => ({
        ...part,
        payload: Buffer.from(
          JSON.stringify(
            JSON.parse(
              Buffer.from(part.payload, "base64").toString("utf8"),
            ),
            null,
            2,
          ),
        ).toString("base64"),
      })),
    },
  };
}

function createAdapter(fetchImpl: FetchLike): PipelineAdapter {
  return new PipelineAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Data Pipeline adapter", () => {
  it("plans creation when the Data Pipeline is absent", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
        }),
      ),
    );

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("uses folder-scoped pagination and plans no-op for semantic JSON matches", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (
        url.includes("/dataPipelines?") &&
        !url.includes("continuationToken")
      ) {
        return new Response(
          JSON.stringify({
            value: [],
            continuationToken: "next",
          }),
          { status: 200 },
        );
      }
      if (url.includes("continuationToken=next")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "pipeline-1",
                displayName: "Hello",
                folderId: "folder-1",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
          folderId: "folder-1",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello", folderId: "folder-1" },
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "pipeline-1",
      managedMetadataMatches: true,
    });
    expect(requestedUrls[0]).toContain("recursive=false");
    expect(requestedUrls[0]).toContain("rootFolderId=folder-1");
  });

  it("plans update when pipeline content differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "pipeline-1", displayName: "Hello" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify(definitionResponse(2)),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
      stagedDefinitionHash: expect.any(String),
    });
  });

  it("reads an omitted-format definition through a 202 operation result", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/getDefinition")) {
        return new Response(undefined, {
          status: 202,
          headers: { "x-ms-operation-id": "definition-operation" },
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
        const response = definitionResponse();
        delete (
          response as {
            definition: { format?: string };
          }
        ).definition.format;
        return new Response(JSON.stringify(response), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.getDefinition(
        "workspace",
        "pipeline-1",
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      parts: expect.arrayContaining([
        expect.objectContaining({
          path: "pipeline-content.json",
        }),
      ]),
    });
    expect(requests[0]).toBe(
      "https://api.fabric.microsoft.com/v1/workspaces/workspace/dataPipelines/pipeline-1/getDefinition",
    );
  });

  it("blocks an implicit folder move", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "pipeline-1", displayName: "Hello" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
          folderId: "different-folder",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      managedMetadataMatches: false,
    });
  });

  it("creates a Data Pipeline with the documented definition payload", async () => {
    let createBody: unknown;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith(
            "/workspaces/workspace/dataPipelines",
          )
        ) {
          createBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "pipeline-1",
              displayName: "Hello",
              description: "Managed",
              folderId: "folder-1",
            }),
            { status: 201 },
          );
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify(definitionResponse(1, false)),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "pipeline-1",
            displayName: "Hello",
            description: "Managed",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);
    const onMutationAccepted = vi.fn();

    const created = await adapter.create(
      "workspace",
      {
        displayName: "Hello",
        description: "Managed",
        folderId: "folder-1",
      },
      pipelineDefinition(),
      onMutationAccepted,
    );

    expect(created.id).toBe("pipeline-1");
    expect(createBody).toMatchObject({
      displayName: "Hello",
      description: "Managed",
      folderId: "folder-1",
      definition: {
        parts: [
          {
            path: "pipeline-content.json",
            payloadType: "InlineBase64",
          },
        ],
      },
    });
    expect(createBody).not.toHaveProperty(
      "sensitivityLabelSettings",
    );
    expect(onMutationAccepted).toHaveBeenCalledWith("pipeline-1");
  });

  it("checkpoints an accepted create operation before polling", async () => {
    const events: string[] = [];
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith(
            "/workspaces/workspace/dataPipelines",
          )
        ) {
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
              id: "pipeline-1",
              displayName: "Hello",
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify(definitionResponse(1, false)),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "pipeline-1",
            displayName: "Hello",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.create(
      "workspace",
      { displayName: "Hello" },
      pipelineDefinition(),
      undefined,
      (operation) => {
        events.push(`accepted:${operation.operationId}`);
      },
    );

    expect(events).toEqual([
      "accepted:create-operation",
      "poll",
    ]);
  });

  it("waits for update-definition completion before full verification", async () => {
    const requests: string[] = [];
    const definition = pipelineDefinition(1, true);
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (
          url.includes(
            "/updateDefinition?updateMetadata=true",
          )
        ) {
          return new Response(undefined, {
            status: 202,
            headers: { "x-ms-operation-id": "operation-1" },
          });
        }
        if (url.endsWith("/v1/operations/operation-1")) {
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify({ definition }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "pipeline-1",
            displayName: "Hello",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);
    const checkpoints: string[] = [];

    await adapter.update(
      "workspace",
      "pipeline-1",
      { displayName: "Hello", description: "Managed" },
      definition,
      undefined,
      (state) => {
        if (state) {
          checkpoints.push(state.phase);
        }
      },
    );

    const operationIndex = requests.findIndex((entry) =>
      entry.endsWith("/v1/operations/operation-1"),
    );
    const verifyDefinitionIndex = requests.findIndex(
      (entry, index) =>
        index > operationIndex &&
        entry.endsWith("/getDefinition"),
    );
    expect(operationIndex).toBeGreaterThan(-1);
    expect(verifyDefinitionIndex).toBeGreaterThan(operationIndex);
    expect(
      requests.some(
        (entry) =>
          entry.startsWith("PATCH ") &&
          entry.includes("/dataPipelines/pipeline-1"),
      ),
    ).toBe(false);
    expect(checkpoints).toEqual([
      "metadata-submitting",
      "definition-staged",
    ]);
  });

  it("preserves recovery state when accepted update polling fails", async () => {
    const definition = pipelineDefinition(1, true);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify({ definition }),
          { status: 200 },
        );
      }
      if (
        url.includes(
          "/updateDefinition?updateMetadata=true",
        )
      ) {
        return new Response(undefined, {
          status: 202,
          headers: { "x-ms-operation-id": "operation-1" },
        });
      }
      if (url.endsWith("/v1/operations/operation-1")) {
        return new Response(
          JSON.stringify({
            errorCode: "OperationNotFound",
            message: "Operation result expired.",
          }),
          { status: 404 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const adapter = createAdapter(fetchImpl);
    const onUpdateRejected = vi.fn();
    const checkpoints: string[] = [];

    await expect(
      adapter.update(
        "workspace",
        "pipeline-1",
        { displayName: "Hello", description: "Managed" },
        definition,
        undefined,
        (state) => {
          if (state) {
            checkpoints.push(state.phase);
          }
        },
        onUpdateRejected,
      ),
    ).rejects.toThrow();

    expect(checkpoints).toEqual(["metadata-submitting"]);
    expect(onUpdateRejected).not.toHaveBeenCalled();
  });

  it("blocked reason names both folders and cites the API limitation", async () => {
    // Verifies that the reason string is actionable: it tells the user which
    // folder the pipeline is currently in, which folder the manifest targets,
    // and WHY the move cannot happen (UpdateDataPipelineRequest has no
    // folderId field — confirmed in microsoft/fabric-rest-api-specs).
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "pipeline-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify(definitionResponse()),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
          folderId: "source-folder-uuid",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.plan(
      "workspace",
      { displayName: "Hello", folderId: "target-folder-uuid" },
      pipelineDefinition(),
    );

    expect(result.action).toBe("blocked");
    expect(result.reason).toContain("source-folder-uuid");
    expect(result.reason).toContain("target-folder-uuid");
    expect(result.reason).toContain("UpdateDataPipelineRequest");
  });

  it("plans update when only the description differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "pipeline-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify(definitionResponse()),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
          description: "Old Description",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello", description: "New Description" },
        pipelineDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("metadata differs"),
      managedMetadataMatches: false,
    });
  });

  it("PATCH body for a metadata-only update contains displayName and description but not folderId", async () => {
    // Guards the API contract: UpdateDataPipelineRequest has no folderId,
    // so we must never send it — even when the desired ItemDefinition has one.
    let capturedPatchBody: unknown;
    const definition = pipelineDefinition(1, false); // no .platform → PATCH path
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "PATCH" &&
          url.includes("/dataPipelines/pipeline-1")
        ) {
          capturedPatchBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "pipeline-1",
              displayName: "Hello",
              description: "Managed",
              folderId: "folder-1",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition")) {
          return new Response(undefined, { status: 200 });
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify(definitionResponse(1, false)),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "pipeline-1",
            displayName: "Hello",
            description: "Managed",
            folderId: "folder-1",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "pipeline-1",
      { displayName: "Hello", description: "Managed", folderId: "folder-1" },
      definition,
    );

    expect(capturedPatchBody).toMatchObject({
      displayName: "Hello",
      description: "Managed",
    });
    // folderId MUST NOT appear — the Fabric API rejects it.
    expect(capturedPatchBody).not.toHaveProperty("folderId");
  });

  it("verify throws when the live pipeline is in a different folder than desired", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify(definitionResponse()),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "pipeline-1",
          displayName: "Hello",
          folderId: "actual-folder",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.verify(
        "workspace",
        "pipeline-1",
        { displayName: "Hello", folderId: "expected-folder" },
        pipelineDefinition(),
      ),
    ).rejects.toThrow("folder placement");
  });
});
