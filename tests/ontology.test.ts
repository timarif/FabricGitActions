import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import type { FabricDefinition } from "../src/fabric/definition";
import { OntologyAdapter } from "../src/fabric/ontology";

const tokenProvider = {
  getToken: async () => "token",
};

function definition(entityName = "Asset"): FabricDefinition {
  return {
    format: "Default",
    parts: [
      {
        path: ".platform",
        payload: Buffer.from(
          JSON.stringify({
            metadata: {
              type: "Ontology",
              displayName: "AssetOntology",
              description: "Managed",
            },
          }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
      {
        path: "definition.json",
        payload: Buffer.from("{}").toString("base64"),
        payloadType: "InlineBase64",
      },
      {
        path: "EntityTypes/1001/definition.json",
        payload: Buffer.from(
          JSON.stringify({
            id: "1001",
            namespace: "usertypes",
            name: entityName,
            namespaceType: "Custom",
          }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function definitionResponse(entityName = "Asset") {
  const response = definition(entityName);
  response.parts[0] = {
    ...response.parts[0]!,
    payload: Buffer.from(
      JSON.stringify({
        metadata: {
          displayName: "AssetOntology",
          type: "Ontology",
          description: "Managed",
        },
        config: {
          logicalId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).toString("base64"),
  };
  return { definition: { parts: response.parts } };
}

function createAdapter(fetchImpl: FetchLike): OntologyAdapter {
  return new OntologyAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

describe("Ontology adapter", () => {
  it("plans creation when the Ontology is absent", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      ),
    );

    await expect(
      adapter.plan(
        "workspace",
        {
          displayName: "AssetOntology",
          description: "Managed",
        },
        definition(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans no-op when metadata and definition match", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("?recursive=false")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "ontology-1",
                  displayName: "AssetOntology",
                },
              ],
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
            id: "ontology-1",
            displayName: "AssetOntology",
            description: "Managed",
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
          displayName: "AssetOntology",
          description: "Managed",
        },
        definition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "ontology-1",
    });
  });

  it("plans update when the definition differs", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("?recursive=false")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "ontology-1",
                  displayName: "AssetOntology",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify(definitionResponse("Changed")),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "ontology-1",
            displayName: "AssetOntology",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      createAdapter(fetchImpl).plan(
        "workspace",
        {
          displayName: "AssetOntology",
          description: "Managed",
        },
        definition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
    });
  });

  it("blocks planning when a sensitivity label prevents definition retrieval", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL) => {
        const url = String(input);
        if (url.includes("?recursive=false")) {
          return new Response(
            JSON.stringify({
              value: [
                {
                  id: "ontology-1",
                  displayName: "AssetOntology",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/getDefinition")) {
          return new Response(
            JSON.stringify({
              errorCode: "ItemHasSensitivityLabelBlockingOperation",
              message: "Definition is unavailable.",
            }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "ontology-1",
            displayName: "AssetOntology",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );

    await expect(
      createAdapter(fetchImpl).plan(
        "workspace",
        {
          displayName: "AssetOntology",
          description: "Managed",
        },
        definition(),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      physicalId: "ontology-1",
      reason: expect.stringContaining("encrypted sensitivity label"),
    });
  });

  it("creates without an invalid definition format field and verifies read-back", async () => {
    let createBody: unknown;
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (
          init?.method === "POST" &&
          url.endsWith("/workspaces/workspace/ontologies")
        ) {
          createBody = JSON.parse(String(init.body));
          return new Response(
            JSON.stringify({
              id: "ontology-1",
              displayName: "AssetOntology",
              description: "Managed",
            }),
            { status: 201 },
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
            id: "ontology-1",
            displayName: "AssetOntology",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );
    const onMutationAccepted = vi.fn();

    const created = await createAdapter(fetchImpl).create(
      "workspace",
      {
        displayName: "AssetOntology",
        description: "Managed",
      },
      definition(),
      onMutationAccepted,
    );

    expect(created.id).toBe("ontology-1");
    expect(createBody).toMatchObject({
      displayName: "AssetOntology",
      description: "Managed",
      definition: {
        parts: expect.any(Array),
      },
    });
    expect(
      (createBody as { definition: Record<string, unknown> })
        .definition,
    ).not.toHaveProperty("format");
    expect(onMutationAccepted).toHaveBeenCalledWith("ontology-1");
  });

  it("checkpoints metadata and waits for definition update completion", async () => {
    const requests: string[] = [];
    let definitionReads = 0;
    const desired = definition();
    const fetchImpl = vi.fn(
      async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/getDefinition")) {
          definitionReads += 1;
          return new Response(
            JSON.stringify(
              definitionReads === 1
                ? definitionResponse("Before")
                : definitionResponse(),
            ),
            { status: 200 },
          );
        }
        if (init?.method === "PATCH") {
          return new Response(
            JSON.stringify({
              id: "ontology-1",
              displayName: "AssetOntology",
              description: "Managed",
            }),
            { status: 200 },
          );
        }
        if (url.includes("/updateDefinition?updateMetadata=true")) {
          return new Response(undefined, {
            status: 202,
            headers: {
              "x-ms-operation-id": "operation-1",
            },
          });
        }
        if (url.endsWith("/v1/operations/operation-1")) {
          return new Response(
            JSON.stringify({ status: "Succeeded" }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            id: "ontology-1",
            displayName: "AssetOntology",
            description: "Managed",
          }),
          { status: 200 },
        );
      },
    );
    const checkpoints: unknown[] = [];

    await createAdapter(fetchImpl).update(
      "workspace",
      "ontology-1",
      {
        displayName: "AssetOntology",
        description: "Managed",
      },
      desired,
      undefined,
      (state) => checkpoints.push(state),
    );

    expect(checkpoints).toEqual([
      expect.objectContaining({ phase: "metadata-submitting" }),
      expect.objectContaining({ phase: "metadata-updated" }),
      expect.objectContaining({ phase: "definition-staged" }),
    ]);
    const operationIndex = requests.findIndex((entry) =>
      entry.endsWith("/v1/operations/operation-1"),
    );
    const finalDefinitionRead = requests.reduce(
      (latest, entry, index) =>
        entry.endsWith("/getDefinition")
          ? index
          : latest,
      -1,
    );
    expect(operationIndex).toBeGreaterThan(-1);
    expect(finalDefinitionRead).toBeGreaterThan(operationIndex);
  });
});
