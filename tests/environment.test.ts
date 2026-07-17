import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
  getFabricDeploymentMarker,
  type FabricDefinition,
  withFabricDeploymentMarkerRemoval,
} from "../src/fabric/definition";
import { EnvironmentAdapter } from "../src/fabric/environment";

const tokenProvider = {
  getToken: async () => "token",
};

function createDefinition(
  content = "dependencies: []\n",
): FabricDefinition {
  return {
    parts: [
      {
        path: "Libraries/PublicLibraries/environment.yml",
        payload: Buffer.from(content).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function createSparkDefinition(): FabricDefinition {
  return {
    parts: [
      ...createDefinition().parts,
      {
        path: "Setting/Sparkcompute.yml",
        payload: Buffer.from(`
enable_native_execution_engine: false
driver_cores: 8
driver_memory: 56g
executor_cores: 8
executor_memory: 56g
dynamic_executor_allocation:
  enabled: true
  min_executors: 1
  max_executors: 8
runtime_version: 1.3
`).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function definitionResponse(content = "dependencies: []\n"): object {
  return {
    definition: {
      parts: [
        {
          path: "Libraries/PublicLibraries/environment.yml",
          payload: Buffer.from(content.replace(/\n/g, "\r\n")).toString(
            "base64",
          ),
          payloadType: "InlineBase64",
        },
        {
          path: "Setting/Sparkcompute.yml",
          payload: Buffer.from("runtime_version: 1.3\r\n").toString("base64"),
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

function createAdapter(
  fetchImpl: FetchLike,
  options: {
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): EnvironmentAdapter {
  return new EnvironmentAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: options.sleep,
      now: options.now,
      operationPollIntervalMs: 1,
    }),
    {
      publishPollIntervalMs: 1,
      publishTimeoutMs: 100,
      sleep: options.sleep,
      now: options.now,
    },
  );
}

describe("Environment adapter", () => {
  it("plans creation when the Environment is absent", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        new Response(JSON.stringify({ value: [] }), { status: 200 }),
      ),
    );

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans no-op when metadata, definition, and publish state match", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "environment-1",
                displayName: "Phase 3",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      if (url.endsWith("/libraries/exportExternalLibraries")) {
        return new Response(
          JSON.stringify({ errorCode: "EnvironmentPublicLibrariesNotFound" }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: { publishDetails: { state: "Success" } },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "environment-1",
    });
  });

  it("does not treat an unrelated published-library 404 as an empty environment", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "environment-1", displayName: "Phase 3" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      if (url.endsWith("/libraries/exportExternalLibraries")) {
        return new Response(
          JSON.stringify({ errorCode: "ItemNotFound" }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: { publishDetails: { state: "Success" } },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).rejects.toThrow("unexpected 404 error 'ItemNotFound'");
  });

  it("accepts a header-only no-libraries response for an empty Environment", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "environment-1", displayName: "Phase 3" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      if (url.endsWith("/libraries/exportExternalLibraries")) {
        return new Response(undefined, {
          status: 404,
          headers: {
            "x-ms-public-api-error-code":
              "EnvironmentLibrariesNotFound",
          },
        });
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: { publishDetails: { state: "Success" } },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      physicalId: "environment-1",
    });
  });

  it("plans update when the public definition differs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "environment-1", displayName: "Phase 3" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(
          JSON.stringify(definitionResponse("dependencies:\n  - pandas\n")),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: { publishDetails: { state: "Success" } },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("definition differs"),
    });
  });

  it("blocks planning while an Environment publish is running", async () => {
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "environment-1", displayName: "Phase 3" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: { publishDetails: { state: "Running" } },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        createDefinition(),
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("Running"),
    });
  });

  it("plans update when the desired staging definition is not the published version", async () => {
    const desiredDefinition = createSparkDefinition();
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "environment-1", displayName: "Phase 3" }],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ definition: desiredDefinition }),
          { status: 200 },
        );
      }
      if (url.endsWith("/sparkcompute?beta=false")) {
        return new Response(
          JSON.stringify({
            sparkProperties: [
              {
                key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
                value: "previous-definition",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: "previous-version",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "Phase 3" },
        desiredDefinition,
      ),
    ).resolves.toMatchObject({
      action: "update",
      reason: expect.stringContaining("not published"),
    });
    expect(getFabricDeploymentMarker(desiredDefinition)).not.toBe(
      "previous-definition",
    );
  });

  it("creates an Environment with definition and publishes it", async () => {
    let now = 0;
    let createBody: unknown;
    let publishRequested = false;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (
        init?.method === "POST" &&
        url.endsWith("/workspaces/workspace/environments")
      ) {
        createBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            id: "environment-1",
            displayName: "Phase 3",
          }),
          { status: 201 },
        );
      }
      if (url.includes("/staging/publish?beta=false")) {
        publishRequested = true;
        return new Response(
          JSON.stringify({
            publishDetails: {
              state: "Running",
              targetVersion: "version-2",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      if (url.endsWith("/libraries/exportExternalLibraries")) {
        return new Response(
          JSON.stringify({ errorCode: "EnvironmentPublicLibrariesNotFound" }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: publishRequested ? "version-2" : "version-1",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const onMutationAccepted = vi.fn();
    const onCreateSubmitting = vi.fn();

    const created = await adapter.create(
      "workspace",
      { displayName: "Phase 3" },
      createDefinition(),
      onMutationAccepted,
      undefined,
      onCreateSubmitting,
    );

    expect(created.id).toBe("environment-1");
    expect(createBody).toMatchObject({
      displayName: "Phase 3",
      definition: {
        parts: [
          {
            path: "Libraries/PublicLibraries/environment.yml",
            payloadType: "InlineBase64",
          },
        ],
      },
    });
    expect(
      methods.some((entry) => entry.includes("/staging/publish?beta=false")),
    ).toBe(true);
    expect(onCreateSubmitting).toHaveBeenCalledOnce();
    expect(onMutationAccepted).toHaveBeenCalledWith(
      "environment-1",
      "version-2",
    );
  });

  it("does not republish a resumed create whose marker cleanup already completed", async () => {
    const definition = createSparkDefinition();
    const cleanedDefinition =
      withFabricDeploymentMarkerRemoval(definition);
    const expectedMarker = getFabricDeploymentMarker(definition);
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/v1/operations/operation-1")) {
        return new Response(JSON.stringify({ status: "Succeeded" }), {
          status: 200,
        });
      }
      if (url.endsWith("/v1/operations/operation-1/result")) {
        return new Response(
          JSON.stringify({
            id: "environment-1",
            displayName: "Phase 3",
          }),
          { status: 200 },
        );
      }
      if (url.includes("?recursive=false")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "environment-1",
                displayName: "Phase 3",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(
          JSON.stringify({ definition: cleanedDefinition }),
          { status: 200 },
        );
      }
      if (url.endsWith("/sparkcompute?beta=false")) {
        return new Response(
          JSON.stringify({
            sparkProperties: [
              {
                key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
                value: expectedMarker,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: "version-2",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const resumed = await adapter.resumeCreate(
      "workspace",
      { displayName: "Phase 3" },
      definition,
      { operationId: "operation-1" },
    );

    expect(resumed.id).toBe("environment-1");
    expect(
      methods.some((entry) =>
        entry.includes("/staging/publish?beta=false"),
      ),
    ).toBe(false);
  });

  it("waits for update-definition completion before publishing", async () => {
    let now = 0;
    let publishRequested = false;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "environment-1", displayName: "Phase 3" }),
          { status: 200 },
        );
      }
      if (url.includes("/updateDefinition")) {
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
      if (url.includes("/staging/publish?beta=false")) {
        publishRequested = true;
        return new Response(
          JSON.stringify({
            publishDetails: {
              state: "Running",
              targetVersion: "version-2",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        return new Response(JSON.stringify(definitionResponse()), {
          status: 200,
        });
      }
      if (url.endsWith("/libraries/exportExternalLibraries")) {
        return new Response(
          JSON.stringify({ errorCode: "EnvironmentPublicLibrariesNotFound" }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: publishRequested ? "version-2" : "version-1",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });
    const definition = createDefinition();
    definition.parts.push({
      path: ".platform",
      payload: Buffer.from("{}").toString("base64"),
      payloadType: "InlineBase64",
    });

    await adapter.update(
      "workspace",
      "environment-1",
      { displayName: "Phase 3" },
      definition,
    );

    const operationIndex = methods.findIndex((entry) =>
      entry.endsWith("/v1/operations/operation-1"),
    );
    const publishIndex = methods.findIndex((entry) =>
      entry.includes("/staging/publish?beta=false"),
    );
    expect(operationIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeGreaterThan(operationIndex);
    expect(
      methods.some((entry) =>
        entry.includes("/updateDefinition?updateMetadata=true"),
      ),
    ).toBe(true);
  });

  it("removes the deployment marker from staging after a verified publish", async () => {
    let publishRequested = false;
    const definition = createSparkDefinition();
    const expectedMarker = getFabricDeploymentMarker(definition);
    const updateBodies: Array<{
      definition?: FabricDefinition;
    }> = [];
    let markerCleanupBody: unknown;
    let markerCleanupRequested = false;
    const recoveryPhases: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        init?.method === "PATCH" &&
        url.endsWith("/staging/sparkcompute?beta=false")
      ) {
        markerCleanupRequested = true;
        markerCleanupBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ sparkProperties: [] }),
          { status: 200 },
        );
      }
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "environment-1", displayName: "Phase 3" }),
          { status: 200 },
        );
      }
      if (url.includes("/updateDefinition")) {
        updateBodies.push(JSON.parse(String(init?.body)));
        return new Response(undefined, { status: 200 });
      }
      if (url.includes("/staging/publish?beta=false")) {
        publishRequested = true;
        return new Response(
          JSON.stringify({
            publishDetails: {
              state: "Running",
              targetVersion: "version-2",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        const stagedDefinition =
          updateBodies.at(-1)?.definition ?? definition;
        return new Response(
          JSON.stringify({
            definition: markerCleanupRequested
              ? withFabricDeploymentMarkerRemoval(stagedDefinition)
              : stagedDefinition,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/sparkcompute?beta=false")) {
        return new Response(
          JSON.stringify({
            sparkProperties: [
              {
                key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
                value: expectedMarker,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: publishRequested ? "version-2" : "version-1",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await adapter.update(
      "workspace",
      "environment-1",
      { displayName: "Phase 3" },
      definition,
      undefined,
      (state) => {
        if (state) {
          recoveryPhases.push(state.phase);
        }
      },
    );

    expect(updateBodies).toHaveLength(1);
    const stagedSpark = updateBodies[0]?.definition?.parts.find(
      (part) => part.path === "Setting/Sparkcompute.yml",
    );
    expect(
      Buffer.from(stagedSpark?.payload ?? "", "base64").toString("utf8"),
    ).toContain(FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY);
    expect(markerCleanupBody).toEqual({
      sparkProperties: [
        {
          key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
          value: null,
        },
      ],
    });
    expect(recoveryPhases).toEqual([
      "metadata-submitting",
      "metadata-updated",
      "definition-staged",
      "published",
      "marker-cleaned",
    ]);
  });

  it("does not overwrite staging drift while cleaning the deployment marker", async () => {
    let publishRequested = false;
    const definition = createSparkDefinition();
    const expectedMarker = getFabricDeploymentMarker(definition);
    const updateBodies: Array<{
      definition?: FabricDefinition;
    }> = [];
    let markerCleanupRequested = false;
    const driftedDefinition = createSparkDefinition();
    driftedDefinition.parts[0] = {
      ...driftedDefinition.parts[0]!,
      payload: Buffer.from(
        "dependencies:\n  - pip:\n      - pandas\n",
      ).toString("base64"),
    };
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        init?.method === "PATCH" &&
        url.endsWith("/staging/sparkcompute?beta=false")
      ) {
        markerCleanupRequested = true;
        return new Response(
          JSON.stringify({ sparkProperties: [] }),
          { status: 200 },
        );
      }
      if (init?.method === "PATCH") {
        return new Response(
          JSON.stringify({ id: "environment-1", displayName: "Phase 3" }),
          { status: 200 },
        );
      }
      if (url.includes("/updateDefinition")) {
        updateBodies.push(JSON.parse(String(init?.body)));
        return new Response(undefined, { status: 200 });
      }
      if (url.includes("/staging/publish?beta=false")) {
        publishRequested = true;
        return new Response(
          JSON.stringify({
            publishDetails: {
              state: "Running",
              targetVersion: "version-2",
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/getDefinition")) {
        const staged = updateBodies[0]?.definition ?? definition;
        const cleaned = withFabricDeploymentMarkerRemoval(staged);
        return new Response(
          JSON.stringify({
            definition: markerCleanupRequested
              ? {
                  ...cleaned,
                  parts: cleaned.parts.map((part) =>
                    part.path ===
                    "Libraries/PublicLibraries/environment.yml"
                      ? driftedDefinition.parts[0]!
                      : part,
                  ),
                }
              : staged,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/sparkcompute?beta=false")) {
        return new Response(
          JSON.stringify({
            sparkProperties: [
              {
                key: FABRIC_DEPLOYMENT_HASH_SPARK_PROPERTY,
                value: expectedMarker,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: publishRequested ? "version-2" : "version-1",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.update(
        "workspace",
        "environment-1",
        { displayName: "Phase 3" },
        definition,
      ),
    ).rejects.toThrow("definition content");

    expect(updateBodies).toHaveLength(1);
    expect(markerCleanupRequested).toBe(true);
  });

  it("does not accept a publish response that reuses the previous target version", async () => {
    let now = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/staging/publish?beta=false")) {
        return new Response(
          JSON.stringify({
            publishDetails: {
              state: "Running",
              targetVersion: "version-1",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "environment-1",
          displayName: "Phase 3",
          properties: {
            publishDetails: {
              state: "Success",
              targetVersion: "version-1",
            },
          },
        }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      adapter.publish("workspace", "environment-1"),
    ).rejects.toThrow("publish timed out");
  });
});
