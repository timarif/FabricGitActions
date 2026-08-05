import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import {
  ApacheAirflowAdapter,
} from "../src/fabric/apache-airflow";
import {
  APACHE_AIRFLOW_DEFINITION_PATH,
  APACHE_AIRFLOW_OWNERSHIP_PATH,
  apacheAirflowIncludesPlatformPart,
  hashApacheAirflowDefinition,
  type ApacheAirflowSourceFile,
  type LoadedApacheAirflowBundle,
} from "../src/fabric/apache-airflow-definition";
import { FabricClient } from "../src/fabric/client";

const tokenProvider = {
  getToken: async () => "token",
};

function sourceFile(
  filePath: string,
  content: string,
): ApacheAirflowSourceFile {
  const bytes = Buffer.from(content, "utf8");
  return {
    filePath,
    payload: bytes.toString("base64"),
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
  };
}

function bundle(content = "print('hello')\n"): LoadedApacheAirflowBundle {
  return {
    definition: {
      parts: [
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              metadata: {
                type: "ApacheAirflowJob",
                displayName: "HelloAirflow",
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: APACHE_AIRFLOW_DEFINITION_PATH,
          payload: Buffer.from(
            JSON.stringify({
              properties: {
                type: "Airflow",
                typeProperties: {
                  airflowProperties: {
                    airflowConfigurationOverrides: {},
                    airflowEnvironment: "FabricAirflowJob-1.0.0",
                    airflowEnvironmentVariables: {},
                    airflowRequirements: [],
                    airflowVersion: "2.10.5",
                    enableAADIntegration: true,
                    enableTriggerers: false,
                    packageProviderPath: "plugins",
                    pythonVersion: "3.12",
                  },
                  computeProperties: {
                    computePool: "StarterPool",
                    computeSize: "Small",
                    enableAutoscale: false,
                    enableAvailabilityZones: true,
                    extraNodes: 0,
                    poolId:
                      "00000000-0000-0000-0000-000000000000",
                    poolName: "Starter Pool (Auto Pausing)",
                    vnetEnabled: false,
                  },
                },
              },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    },
    files: [sourceFile("dags/hello.py", content)],
  };
}

function shellDefinition(): LoadedApacheAirflowBundle["definition"] {
  const desired = bundle().definition;
  const platform = desired.parts.find(
    (part) => part.path === ".platform",
  )!;
  return {
    parts: [
      platform,
      {
        path: APACHE_AIRFLOW_DEFINITION_PATH,
        payload: Buffer.from(
          JSON.stringify({
            properties: {
              type: "Airflow",
              typeProperties: {
                airflowProperties: {
                  airflowConfigurationOverrides: {},
                  airflowEnvironment: "FabricAirflowJob-1.0.0",
                  airflowEnvironmentVariables: {},
                  airflowRequirements: [],
                  airflowVersion: "2.10.5",
                  enableAADIntegration: true,
                  enableTriggerers: false,
                  pythonVersion: "3.12",
                },
                computeProperties: {
                  computePool: "StarterPool",
                  computeSize: "Small",
                  enableAutoscale: false,
                  enableAvailabilityZones: true,
                  extraNodes: 0,
                  poolId:
                    "00000000-0000-0000-0000-000000000000",
                  poolName: "Starter Pool (Auto Pausing)",
                  vnetEnabled: false,
                },
              },
            },
          }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function ownership(files: ApacheAirflowSourceFile[]): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: "1",
      managedBy: "fabric-deploy",
      files: files.map((file) => ({
        filePath: file.filePath,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
      })),
    }),
    "utf8",
  );
}

function createStatefulAdapter(options?: {
  exists?: boolean;
  remoteFile?: string;
  ownedFile?: ApacheAirflowSourceFile;
}) {
  let exists = options?.exists ?? true;
  let currentDefinition = bundle().definition;
  const files = new Map<string, Uint8Array>();
  if (options?.remoteFile !== undefined) {
    files.set(
      "dags/hello.py",
      Buffer.from(options.remoteFile, "utf8"),
    );
  }
  if (options?.ownedFile) {
    files.set(
      APACHE_AIRFLOW_OWNERSHIP_PATH,
      ownership([options.ownedFile]),
    );
  }
  const requests: Array<{
    method: string;
    url: string;
    contentType: string | null;
    body?: string;
  }> = [];
  const fetchImpl: FetchLike = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url: url.toString(),
        contentType: new Headers(init?.headers).get("content-type"),
        ...(typeof init?.body === "string"
          ? { body: init.body }
          : {}),
      });
      if (
        method === "GET" &&
        url.pathname.endsWith("/apacheAirflowJobs") &&
        url.searchParams.get("recursive") === "false"
      ) {
        return new Response(
          JSON.stringify({
            value: exists
              ? [
                  {
                    id: "airflow-1",
                    type: "ApacheAirflowJob",
                    displayName: "HelloAirflow",
                  },
                ]
              : [],
          }),
          { status: 200 },
        );
      }
      if (
        method === "POST" &&
        url.pathname.endsWith("/apacheAirflowJobs")
      ) {
        exists = true;
        currentDefinition = shellDefinition();
        return new Response(
          JSON.stringify({
            id: "airflow-1",
            type: "ApacheAirflowJob",
            displayName: "HelloAirflow",
          }),
          { status: 201 },
        );
      }
      if (url.pathname.endsWith("/getDefinition")) {
        const fileParts = [...files.entries()].map(
          ([filePath, content]) => ({
            path: filePath,
            payload: Buffer.from(content).toString("base64"),
            payloadType: "InlineBase64" as const,
          }),
        );
        return new Response(
          JSON.stringify({
            definition: {
              ...currentDefinition,
              parts: [...currentDefinition.parts, ...fileParts],
            },
          }),
          { status: 200 },
        );
      }
      if (url.pathname.endsWith("/updateDefinition")) {
        const request = JSON.parse(String(init?.body)) as {
          definition: LoadedApacheAirflowBundle["definition"];
        };
        const platform = currentDefinition.parts.find(
          (part) => part.path === ".platform",
        );
        currentDefinition = {
          parts: [
            ...(platform ? [platform] : []),
            ...request.definition.parts,
          ],
        };
        return new Response(undefined, { status: 200 });
      }
      if (
        method === "GET" &&
        url.pathname.endsWith("/files") &&
        url.searchParams.get("beta") === "true"
      ) {
        const rootPath = url.searchParams.get("rootPath");
        return new Response(
          JSON.stringify({
            value: [...files.entries()]
              .filter(
                ([filePath]) =>
                  rootPath === null ||
                  filePath.slice(0, filePath.lastIndexOf("/")) ===
                    rootPath,
              )
              .map(([filePath, content]) => ({
                filePath,
                sizeInBytes: content.byteLength,
              })),
          }),
          { status: 200 },
        );
      }
      const marker = "/files/";
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex >= 0) {
        const filePath = url.pathname
          .slice(markerIndex + marker.length)
          .split("/")
          .map((segment) => decodeURIComponent(segment))
          .join("/");
        if (method === "GET") {
          const content = files.get(filePath);
          return content
            ? new Response(
                Uint8Array.from(content).buffer,
                { status: 200 },
              )
            : new Response(
                JSON.stringify({
                  errorCode: "ItemNotFound",
                  message: "Not found.",
                }),
                { status: 404 },
              );
        }
        if (method === "PUT") {
          files.set(
            filePath,
            new Uint8Array(
              await new Response(init?.body).arrayBuffer(),
            ),
          );
          return new Response(undefined, { status: 200 });
        }
        if (method === "DELETE") {
          files.delete(filePath);
          return new Response(undefined, { status: 200 });
        }
      }
      if (method === "PATCH") {
        return new Response(
          JSON.stringify({
            id: "airflow-1",
            type: "ApacheAirflowJob",
            displayName: "HelloAirflow",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          id: "airflow-1",
          type: "ApacheAirflowJob",
          displayName: "HelloAirflow",
        }),
        { status: 200 },
      );
    },
  );
  return {
    adapter: new ApacheAirflowAdapter(
      new FabricClient({
        endpoint: "https://api.fabric.microsoft.com",
        scope: "scope",
        tokenProvider,
        fetchImpl,
      }),
    ),
    files,
    requests,
  };
}

describe("Apache Airflow adapter", () => {
  it("plans creation when the job is absent", async () => {
    const { adapter } = createStatefulAdapter({ exists: false });

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "HelloAirflow" },
        bundle(),
      ),
    ).resolves.toMatchObject({
      action: "create",
      observedStateHash: expect.any(String),
    });
  });

  it("plans no-op when the definition, owned DAG, and metadata match", async () => {
    const desired = bundle();
    const { adapter } = createStatefulAdapter({
      remoteFile: "print('hello')\n",
      ownedFile: desired.files[0],
    });

    await expect(
      adapter.plan(
        "workspace",
        { displayName: "HelloAirflow" },
        desired,
      ),
    ).resolves.toMatchObject({
      action: "no-op",
      apacheAirflowFiles: {
        operations: [
          expect.objectContaining({
            filePath: "dags/hello.py",
            action: "no-op",
          }),
        ],
      },
    });
  });

  it("plans an owned DAG update and blocks an unowned collision", async () => {
    const old = bundle("print('old')\n");
    const desired = bundle("print('new')\n");
    const owned = createStatefulAdapter({
      remoteFile: "print('old')\n",
      ownedFile: old.files[0],
    });
    await expect(
      owned.adapter.plan(
        "workspace",
        { displayName: "HelloAirflow" },
        desired,
      ),
    ).resolves.toMatchObject({
      action: "update",
      apacheAirflowFiles: {
        operations: [
          expect.objectContaining({ action: "update" }),
        ],
      },
    });

    const unowned = createStatefulAdapter({
      remoteFile: "print('manual')\n",
    });
    await expect(
      unowned.adapter.plan(
        "workspace",
        { displayName: "HelloAirflow" },
        desired,
      ),
    ).resolves.toMatchObject({
      action: "blocked",
      reason: expect.stringContaining("not owned by Fabric Deploy"),
    });
  });

  it("creates the job, uploads raw DAG bytes, and writes ownership state", async () => {
    const desired = bundle();
    const { adapter, files, requests } = createStatefulAdapter({
      exists: false,
    });
    const accepted = vi.fn();
    const completed = vi.fn();

    await adapter.create(
      "workspace",
      { displayName: "HelloAirflow" },
      desired,
      completed,
      accepted,
    );

    expect(
      Buffer.from(files.get("dags/hello.py") ?? []),
    ).toEqual(Buffer.from("print('hello')\n"));
    expect(files.has(APACHE_AIRFLOW_OWNERSHIP_PATH)).toBe(true);
    const createRequest = requests.find(
      (request) =>
        request.method === "POST" &&
        new URL(request.url).pathname.endsWith(
          "/apacheAirflowJobs",
        ),
    );
    expect(JSON.parse(createRequest?.body ?? "{}")).not.toHaveProperty(
      "definition",
    );
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.url.includes(
            "/updateDefinition?updateMetadata=false",
          ),
      ),
    ).toBe(true);
    expect(
      requests.find(
        (request) =>
          request.method === "PUT" &&
          request.url.includes("/files/dags/hello.py"),
      )?.contentType,
    ).toBe("application/octet-stream");
    expect(accepted).toHaveBeenCalledWith(
      expect.objectContaining({
        physicalId: "airflow-1",
        shellDefinitionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(completed).toHaveBeenCalledWith("airflow-1");
  });

  it("resumes after definition staging without dispatching it twice", async () => {
    const desired = bundle();
    const { adapter, requests } = createStatefulAdapter({
      exists: false,
    });
    await adapter.create(
      "workspace",
      { displayName: "HelloAirflow" },
      desired,
      undefined,
      undefined,
    );

    const shellHash = hashApacheAirflowDefinition(
      shellDefinition(),
      apacheAirflowIncludesPlatformPart(desired.definition),
    );
    await adapter.resumeCreate(
      "workspace",
      { displayName: "HelloAirflow" },
      desired,
      {
        physicalId: "airflow-1",
        shellDefinitionHash: shellHash,
      },
    );

    expect(
      requests.filter((request) =>
        request.url.includes("/updateDefinition"),
      ),
    ).toHaveLength(1);
  });
});
