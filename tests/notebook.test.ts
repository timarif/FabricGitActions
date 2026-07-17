import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { NotebookAdapter } from "../src/fabric/notebook";

const tokenProvider = {
  getToken: async () => "token",
};

function sourceDefinition(
  content = "print('hello')\n",
): FabricDefinition {
  return {
    format: "fabricGitSource",
    parts: [
      {
        path: "notebook-content.py",
        payload: Buffer.from(content).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function definitionResponse(
  content = "print('hello')\n",
): object {
  return {
    definition: {
      parts: [
        {
          path: "notebook-content.py",
          payload: Buffer.from(content.replace(/\n/g, "\r\n")).toString(
            "base64",
          ),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from("{}").toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    },
  };
}

function createAdapter(fetchImpl: FetchLike): NotebookAdapter {
  return new NotebookAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Notebook adapter", () => {
  it("plans creation when the Notebook is absent", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      ),
    );

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        sourceDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans no-op when metadata and source content match", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "notebook-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/getDefinition?format=fabricGitSource")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "notebook-1",
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
        sourceDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "notebook-1",
    });
  });

  it("uses the requested ipynb format when Fabric omits it from readback", async () => {
    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      cells: [],
      metadata: {},
    };
    const desired: FabricDefinition = {
      format: "ipynb",
      parts: [
        {
          path: "notebook-content.ipynb",
          payload: Buffer.from(JSON.stringify(notebook)).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "notebook-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/getDefinition?format=ipynb")) {
        return new Response(
          JSON.stringify({
            definition: {
              parts: [
                {
                  path: "artifact.content.ipynb",
                  payload: Buffer.from(
                    JSON.stringify(notebook, null, 2),
                  ).toString("base64"),
                  payloadType: "InlineBase64",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "notebook-1",
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
        desired,
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "notebook-1",
    });
  });

  it("plans update when the source content differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "notebook-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/getDefinition?format=fabricGitSource")) {
        return new Response(
          JSON.stringify(definitionResponse("print('changed')\n")),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "notebook-1",
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
        sourceDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
    });
  });

  it("creates a Notebook with its immutable definition", async () => {
    let createBody: unknown;
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        init?.method === "POST" &&
        url.endsWith("/workspaces/workspace/notebooks")
      ) {
        createBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: "notebook-1",
            displayName: "Hello",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/getDefinition?format=fabricGitSource")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "notebook-1",
          displayName: "Hello",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);
    const onMutationAccepted = vi.fn();

    const created = await adapter.create(
      "workspace",
      { displayName: "Hello" },
      sourceDefinition(),
      onMutationAccepted,
    );

    expect(created.id).toBe("notebook-1");
    expect(createBody).toMatchObject({
      displayName: "Hello",
      definition: {
        format: "fabricGitSource",
        parts: [
          {
            path: "notebook-content.py",
            payloadType: "InlineBase64",
          },
        ],
      },
    });
    expect(onMutationAccepted).toHaveBeenCalledWith("notebook-1");
  });

  it("waits for update-definition completion before verification", async () => {
    const methods: string[] = [];
    const definition = sourceDefinition();
    definition.parts.push({
      path: ".platform",
      payload: Buffer.from("{}").toString("base64"),
      payloadType: "InlineBase64",
    });
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "notebook-1", displayName: "Hello" }),
          { status: 200 },
        );
      }
      if (url.includes("/updateDefinition?updateMetadata=true")) {
        return new Response(undefined, {
          status: 202,
          headers: { "x-ms-operation-id": "operation-1" },
        });
      }
      if (url.endsWith("/v1/operations/operation-1")) {
        return new Response(JSON.stringify({ status: "Succeeded" }), {
          status: 200,
        });
      }
      if (url.includes("/getDefinition?format=fabricGitSource")) {
        return new Response(JSON.stringify({ definition }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "notebook-1",
          displayName: "Hello",
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "notebook-1",
      { displayName: "Hello" },
      definition,
    );

    const operationIndex = methods.findIndex((entry) =>
      entry.endsWith("/v1/operations/operation-1"),
    );
    const verifyIndex = methods.findIndex(
      (entry, index) =>
        index > operationIndex &&
        entry.includes("/getDefinition?format=fabricGitSource"),
    );
    expect(operationIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(operationIndex);
    expect(
      methods.some(
        (entry) =>
          entry.startsWith("PATCH ") &&
          entry.includes("/notebooks/notebook-1"),
      ),
    ).toBe(false);
  });

  it("preserves recovery state when polling an accepted definition update fails", async () => {
    const definition = sourceDefinition();
    definition.parts.push({
      path: ".platform",
      payload: Buffer.from("{}").toString("base64"),
      payloadType: "InlineBase64",
    });
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/getDefinition?format=fabricGitSource")) {
        return new Response(JSON.stringify({ definition }), {
          status: 200,
        });
      }
      if (url.includes("/updateDefinition?updateMetadata=true")) {
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

    await expect(
      adapter.update(
        "workspace",
        "notebook-1",
        { displayName: "Hello", description: "Managed" },
        definition,
        undefined,
        vi.fn(),
        onUpdateRejected,
      ),
    ).rejects.toThrow();

    expect(onUpdateRejected).not.toHaveBeenCalled();
  });
});
