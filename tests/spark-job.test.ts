import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { SparkJobAdapter } from "../src/fabric/spark-job";

const tokenProvider = {
  getToken: async () => "token",
};

function sparkDefinition(
  content = "print('hello')\n",
): FabricDefinition {
  return {
    format: "SparkJobDefinitionV2",
    parts: [
      {
        path: "SparkJobDefinitionV1.json",
        payload: Buffer.from(
          JSON.stringify({
            executableFile: "main.py",
            defaultLakehouseArtifactId: "",
            mainClass: "",
            additionalLakehouseIds: [],
            retryPolicy: null,
            commandLineArguments: "",
            additionalLibraryUris: [],
            language: "Python",
            environmentArtifactId: null,
          }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
      {
        path: "Main/main.py",
        payload: Buffer.from(content).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function definitionResponse(
  content = "print('hello')\n",
): object {
  const desired = sparkDefinition(content);
  return {
    definition: {
      parts: [
        {
          path: "SparkJobDefinitionV1.json",
          payload: Buffer.from(
            JSON.stringify(
              JSON.parse(
                Buffer.from(
                  desired.parts[0]!.payload,
                  "base64",
                ).toString("utf8"),
              ),
              null,
              2,
            ),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: "Main/main.py",
          payload: Buffer.from(
            content.replace(/\n/g, "\r\n"),
          ).toString("base64"),
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

function createAdapter(fetchImpl: FetchLike): SparkJobAdapter {
  return new SparkJobAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Spark Job Definition adapter", () => {
  it("plans creation when the Spark Job Definition is absent", async () => {
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
        sparkDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans unresolved logical references only when the item is absent", async () => {
    const absent = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
        }),
      ),
    );

    await expect(
      absent.planUnresolvedReferences(
        "workspace",
        { displayName: "Hello" },
        ["bronze"],
      ),
    ).resolves.toMatchObject({
      action: "create",
    });

    const existing = createAdapter(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            value: [{ id: "spark-1", displayName: "Hello" }],
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(
      existing.planUnresolvedReferences(
        "workspace",
        { displayName: "Hello" },
        ["bronze"],
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "spark-1",
      reason: expect.stringContaining("generate a new plan"),
    });
  });

  it("plans no-op when metadata and V2 content match", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "spark-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (
        url.includes(
          "/getDefinition?format=SparkJobDefinitionV2",
        )
      ) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ id: "spark-1", displayName: "Hello" }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        sparkDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "spark-1",
    });
  });

  it("plans update when the main source differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "spark-1", displayName: "Hello" }],
          }),
          { status: 200 },
        );
      }
      if (
        url.includes(
          "/getDefinition?format=SparkJobDefinitionV2",
        )
      ) {
        return new Response(
          JSON.stringify(
            definitionResponse("print('changed')\n"),
          ),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ id: "spark-1", displayName: "Hello" }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Hello" },
        sparkDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
    });
  });

  it("creates a Spark Job Definition with immutable V2 content", async () => {
    let createBody: unknown;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith(
            "/workspaces/workspace/sparkJobDefinitions",
          )
        ) {
          createBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "spark-1",
              displayName: "Hello",
            }),
            { status: 201 },
          );
        }
        if (
          url.includes(
            "/getDefinition?format=SparkJobDefinitionV2",
          )
        ) {
          return new Response(
            JSON.stringify(definitionResponse()),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "spark-1",
            displayName: "Hello",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);
    const onMutationAccepted = vi.fn();

    const created = await adapter.create(
      "workspace",
      { displayName: "Hello" },
      sparkDefinition(),
      onMutationAccepted,
    );

    expect(created.id).toBe("spark-1");
    expect(createBody).toMatchObject({
      displayName: "Hello",
      definition: {
        format: "SparkJobDefinitionV2",
        parts: expect.arrayContaining([
          expect.objectContaining({
            path: "SparkJobDefinitionV1.json",
          }),
          expect.objectContaining({ path: "Main/main.py" }),
        ]),
      },
    });
    expect(onMutationAccepted).toHaveBeenCalledWith("spark-1");
  });

  it("waits for definition update completion before verification", async () => {
    const methods: string[] = [];
    const definition = sparkDefinition();
    definition.parts.push({
      path: ".platform",
      payload: Buffer.from("{}").toString("base64"),
      payloadType: "InlineBase64",
    });
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        methods.push(`${init?.method ?? "GET"} ${url}`);
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
        if (
          url.includes(
            "/getDefinition?format=SparkJobDefinitionV2",
          )
        ) {
          return new Response(JSON.stringify({ definition }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            id: "spark-1",
            displayName: "Hello",
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "spark-1",
      { displayName: "Hello" },
      definition,
    );

    const operationIndex = methods.findIndex((entry) =>
      entry.endsWith("/v1/operations/operation-1"),
    );
    const verifyIndex = methods.findIndex(
      (entry, index) =>
        index > operationIndex &&
        entry.includes(
          "/getDefinition?format=SparkJobDefinitionV2",
        ),
    );
    expect(operationIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(operationIndex);
    expect(
      methods.some(
        (entry) =>
          entry.startsWith("PATCH ") &&
          entry.includes("/sparkJobDefinitions/spark-1"),
      ),
    ).toBe(false);
  });
});
