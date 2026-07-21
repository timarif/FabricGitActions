/**
 * Tests for CopyJobAdapter — plan, create, update, verify.
 *
 * Tests cover:
 * - plan: create / no-op / update (description drift, definition drift)
 * - plan: blocked when folder move or jobMode drift
 * - create: 201 synchronous path
 * - update: metadata PATCH + definition stage
 * - verify: pass and fail scenarios
 * - resumeCreate: LRO recovery
 * - checkpoint callbacks
 */

import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import { CopyJobAdapter } from "../src/fabric/copy-job";
import { hashCopyJobDefinition } from "../src/fabric/copy-job-definition";
import type { FabricDefinition } from "../src/fabric/definition";

const tokenProvider = { getToken: async () => "token" };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function batchDefinition(mode: "Batch" | "CDC" = "Batch"): FabricDefinition {
  return {
    parts: [
      {
        path: "copyjob-content.json",
        payload: Buffer.from(
          JSON.stringify({ properties: { jobMode: mode } }),
        ).toString("base64"),
        payloadType: "InlineBase64",
      },
    ],
  };
}

function batchDefinitionResponse(mode: "Batch" | "CDC" = "Batch"): object {
  return {
    definition: batchDefinition(mode),
  };
}

function copyJobResponse(
  id = "copy-job-id",
  displayName = "MyCopyJob",
  description?: string,
  folderId?: string,
): object {
  return {
    id,
    displayName,
    ...(description !== undefined ? { description } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
    type: "CopyJob",
    workspaceId: "workspace",
  };
}

function createAdapter(fetchImpl: FetchLike): CopyJobAdapter {
  return new CopyJobAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      operationPollIntervalMs: 1,
    }),
  );
}

// A fetch mock that returns the given responses in sequence
function sequentialFetch(
  ...responses: { status: number; body: unknown }[]
): FetchLike {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1]!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.plan", () => {
  it("plans create when no matching Copy Job exists", async () => {
    const adapter = createAdapter(
      sequentialFetch({ status: 200, body: { value: [] } }),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      batchDefinition(),
    );
    expect(result.action).toBe("create");
    expect(result.physicalId).toBeUndefined();
  });

  it("plans no-op for exact match", async () => {
    const def = batchDefinition();
    const defHash = hashCopyJobDefinition(def, false);
    const adapter = createAdapter(
      sequentialFetch(
        // list
        {
          status: 200,
          body: { value: [copyJobResponse("id1", "MyCopyJob")] },
        },
        // get
        { status: 200, body: copyJobResponse("id1", "MyCopyJob") },
        // getDefinition (POST)
        { status: 200, body: batchDefinitionResponse() },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      def,
    );
    expect(result.action).toBe("no-op");
    expect(result.physicalId).toBe("id1");
    expect(result.stagedDefinitionHash).toBe(defHash);
  });

  it("plans update when description differs", async () => {
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        { status: 200, body: copyJobResponse("id1", "MyCopyJob", "old-desc") },
        { status: 200, body: batchDefinitionResponse() },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob", description: "new-desc" },
      batchDefinition(),
    );
    expect(result.action).toBe("update");
    expect(result.physicalId).toBe("id1");
  });

  it("plans blocked when folder differs", async () => {
    // The item exists in the target folder (same folder as desired) but
    // the discoverByDisplayName found it there — the defensive folder-guard
    // in plan() will fire because item.folderId ("old-folder") != desired.folderId ("new-folder").
    const adapter = createAdapter(
      sequentialFetch(
        // generic /items?type=CopyJob — item in old-folder
        {
          status: 200,
          body: {
            value: [
              copyJobResponse("id1", "MyCopyJob", undefined, "old-folder"),
            ],
          },
        },
        // get
        {
          status: 200,
          body: copyJobResponse("id1", "MyCopyJob", undefined, "old-folder"),
        },
        // getDefinition
        { status: 200, body: batchDefinitionResponse() },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob", folderId: "new-folder" },
      batchDefinition(),
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/folder/i);
    // The plan-level defensive guard names both folders
    expect(result.reason).toMatch(/old-folder/);
    expect(result.reason).toMatch(/new-folder/);
  });

  it("plans blocked when same-name Copy Job exists in a different folder", async () => {
    // discoverByDisplayName finds the item in "other-folder" rather than the
    // desired root; should return conflict → blocked before any GET is issued.
    const adapter = createAdapter(
      sequentialFetch(
        // generic /items?type=CopyJob — item in different folder
        {
          status: 200,
          body: {
            value: [
              copyJobResponse("id2", "MyCopyJob", undefined, "other-folder"),
            ],
          },
        },
        // NO subsequent GET/getDefinition calls expected
      ),
    );
    const result = await adapter.plan(
      "workspace",
      // desired: workspace root (no folderId)
      { displayName: "MyCopyJob" },
      batchDefinition(),
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/same display name/i);
    expect(result.reason).toMatch(/other-folder/);
  });

  it("plans blocked when jobMode differs", async () => {
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        { status: 200, body: copyJobResponse("id1", "MyCopyJob") },
        { status: 200, body: batchDefinitionResponse("Batch") },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      batchDefinition("CDC"), // desired CDC but live is Batch
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/jobMode/i);
    expect(result.reason).toMatch(/immutable/i);
  });

  it("plans blocked when desired .platform differs from service state", async () => {
    // .platform definition drift must be blocked — updateDefinition is never
    // called for existing Copy Jobs.  Even though jobMode is stable, a
    // differing .platform produces blocked, not update.
    const servicePlatform = {
      metadata: { type: "CopyJob", displayName: "MyCopyJob" },
      config: { version: "2.0" },
    };
    const desiredPlatform = {
      metadata: { type: "CopyJob", displayName: "MyCopyJob", description: "changed" },
      config: { version: "2.0" },
    };
    const serviceDefinitionWithPlatform: FabricDefinition = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: Buffer.from(
            JSON.stringify({ properties: { jobMode: "Batch" } }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(JSON.stringify(servicePlatform)).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };
    const desiredDefinitionWithPlatform: FabricDefinition = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: Buffer.from(
            JSON.stringify({ properties: { jobMode: "Batch" } }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(JSON.stringify(desiredPlatform)).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        { status: 200, body: copyJobResponse("id1", "MyCopyJob") },
        { status: 200, body: { definition: serviceDefinitionWithPlatform } },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      desiredDefinitionWithPlatform,
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/\.platform definition differs/i);
    expect(result.reason).toMatch(/updateDefinition/i);
    expect(result.reason).toMatch(/recreate/i);
  });

  it("throws when multiple Copy Jobs share the same display name", async () => {
    const adapter = createAdapter(
      sequentialFetch({
        status: 200,
        body: {
          value: [
            copyJobResponse("id1", "MyCopyJob"),
            copyJobResponse("id2", "MyCopyJob"),
          ],
        },
      }),
    );
    await expect(
      adapter.plan("workspace", { displayName: "MyCopyJob" }, batchDefinition()),
    ).rejects.toThrow("Multiple Copy Jobs");
  });
});

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.create", () => {
  it("creates a Copy Job with 201 synchronous response", async () => {
    const created = copyJobResponse("new-id", "MyCopyJob");
    const adapter = createAdapter(
      sequentialFetch(
        { status: 201, body: created },
        // verify: GET + getDefinition (POST)
        { status: 200, body: created },
        { status: 200, body: batchDefinitionResponse() },
      ),
    );

    const onMutationAccepted = vi.fn();
    const onCreateSubmitting = vi.fn();

    const result = await adapter.create(
      "workspace",
      { displayName: "MyCopyJob" },
      batchDefinition(),
      onMutationAccepted,
      undefined,
      onCreateSubmitting,
    );

    expect(result.id).toBe("new-id");
    expect(onCreateSubmitting).toHaveBeenCalledOnce();
    expect(onMutationAccepted).toHaveBeenCalledWith("new-id");
  });

  it("passes folderId in the create body when specified", async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      requests.push(JSON.stringify({ url: String(input), body: init?.body }));
      const created = copyJobResponse("new-id", "MyCopyJob", undefined, "folder-1");
      if (String(input).includes("/copyJobs") && init?.method === "POST" && !String(input).includes("/getDefinition")) {
        return new Response(JSON.stringify(created), { status: 201 });
      }
      if (String(input).includes("new-id") && init?.method === "GET") {
        return new Response(JSON.stringify(created), { status: 200 });
      }
      return new Response(JSON.stringify(batchDefinitionResponse()), { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    await adapter.create(
      "workspace",
      { displayName: "MyCopyJob", folderId: "folder-1" },
      batchDefinition(),
    );

    const createCall = requests.find((r) => r.includes("/copyJobs") && r.includes("folderId"));
    expect(createCall).toBeDefined();
    expect(createCall).toContain("folder-1");
  });

  it("calls onCreateRejected on 400 response", async () => {
    const adapter = createAdapter(
      vi.fn(async () => new Response(JSON.stringify({ errorCode: "BadRequest" }), { status: 400 })),
    );
    const onCreateRejected = vi.fn();
    await expect(
      adapter.create(
        "workspace",
        { displayName: "MyCopyJob" },
        batchDefinition(),
        undefined,
        undefined,
        undefined,
        onCreateRejected,
      ),
    ).rejects.toThrow();
    expect(onCreateRejected).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// resumeCreate
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.resumeCreate", () => {
  it("polls the operation and verifies on success", async () => {
    const created = copyJobResponse("resumed-id", "MyCopyJob");
    let callCount = 0;
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = String(input);
      callCount++;
      // 1st call: poll operation status
      if (url.includes("/v1/operations/op-123") && !url.includes("/result")) {
        return new Response(JSON.stringify({ status: "Succeeded" }), {
          status: 200,
        });
      }
      // 2nd call: fetch operation result
      if (url.includes("/v1/operations/op-123/result")) {
        return new Response(JSON.stringify(created), { status: 200 });
      }
      // 3rd call: verify GET
      if (url.includes("resumed-id") && !url.includes("getDefinition")) {
        return new Response(JSON.stringify(created), { status: 200 });
      }
      // 4th call: verify getDefinition (POST)
      return new Response(
        JSON.stringify(batchDefinitionResponse()),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const onMutationAccepted = vi.fn();
    const result = await adapter.resumeCreate(
      "workspace",
      { displayName: "MyCopyJob" },
      batchDefinition(),
      { operationId: "op-123" },
      onMutationAccepted,
    );

    expect(result.id).toBe("resumed-id");
    expect(onMutationAccepted).toHaveBeenCalledWith("resumed-id");
    expect(callCount).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.update", () => {
  it("PATCHes metadata only — never calls updateDefinition (no .platform)", async () => {
    const updated = copyJobResponse("id1", "MyCopyJob", "new-desc");
    const fetchRequests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchRequests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      return new Response(JSON.stringify(batchDefinitionResponse()), { status: 200 });
    });
    const adapter = createAdapter(fetchImpl);

    const checkpoints: unknown[] = [];
    const result = await adapter.update(
      "workspace",
      "id1",
      { displayName: "MyCopyJob", description: "new-desc" },
      batchDefinition(),
      undefined,
      (state) => checkpoints.push(state),
    );

    expect(result.id).toBe("id1");
    expect(fetchRequests.some((r) => r.startsWith("PATCH"))).toBe(true);
    expect(fetchRequests.some((r) => r.includes("updateDefinition"))).toBe(false);
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    // bare checkpoint — no phase emitted
    expect(checkpoints[0]).toBeUndefined();
  });

  it("PATCHes metadata only — never calls updateDefinition even when desired includes .platform", async () => {
    // .platform drift is blocked at plan() time; update() is only reached for
    // metadata drift.  Even when the desired definition carries a .platform
    // part, update() must NOT call updateDefinition.
    const platformDef: FabricDefinition = {
      parts: [
        {
          path: "copyjob-content.json",
          payload: Buffer.from(
            JSON.stringify({ properties: { jobMode: "Batch" } }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
        {
          path: ".platform",
          payload: Buffer.from(
            JSON.stringify({
              metadata: { type: "CopyJob", displayName: "MyCopyJob" },
              config: { version: "2.0" },
            }),
          ).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    };

    const updated = copyJobResponse("id1", "MyCopyJob", "new-desc");
    const fetchRequests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchRequests.push(`${init?.method ?? "GET"} ${url}`);
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify(updated), { status: 200 });
      }
      // getDefinition POST — return definition matching desired so verify passes
      return new Response(
        JSON.stringify({ definition: platformDef }),
        { status: 200 },
      );
    });
    const adapter = createAdapter(fetchImpl);

    const result = await adapter.update(
      "workspace",
      "id1",
      { displayName: "MyCopyJob", description: "new-desc" },
      platformDef,
    );

    expect(result.id).toBe("id1");
    expect(fetchRequests.some((r) => r.startsWith("PATCH"))).toBe(true);
    expect(fetchRequests.some((r) => r.includes("updateDefinition"))).toBe(false);
    // NO prior getDefinition call (no hash fetch before PATCH)
    const postRequests = fetchRequests.filter((r) => r.startsWith("POST"));
    // Only POST allowed is getDefinition during verify — not updateDefinition
    expect(
      postRequests.every((r) => r.includes("getDefinition")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.verify", () => {
  it("returns the item when displayName, description, and definition match", async () => {
    const def = batchDefinition();
    const defHash = hashCopyJobDefinition(def, false);
    const item = copyJobResponse("id1", "MyCopyJob", "Desc");
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: item },
        { status: 200, body: batchDefinitionResponse() },
      ),
    );
    const result = await adapter.verify("workspace", "id1", { displayName: "MyCopyJob", description: "Desc" }, def);
    expect(result.id).toBe("id1");
    void defHash;
  });

  it("throws when displayName does not match", async () => {
    const item = copyJobResponse("id1", "WrongName");
    const adapter = createAdapter(
      sequentialFetch({ status: 200, body: item }),
    );
    await expect(
      adapter.verify("workspace", "id1", { displayName: "MyCopyJob" }, batchDefinition()),
    ).rejects.toThrow("displayName");
  });

  it("throws when description does not match", async () => {
    const item = copyJobResponse("id1", "MyCopyJob", "old-desc");
    const adapter = createAdapter(
      sequentialFetch({ status: 200, body: item }),
    );
    await expect(
      adapter.verify(
        "workspace",
        "id1",
        { displayName: "MyCopyJob", description: "expected-desc" },
        batchDefinition(),
      ),
    ).rejects.toThrow("description");
  });
});

// ---------------------------------------------------------------------------
// portal-managed fields in server readback (configured Copy Jobs)
//
// Authoritative schema: microsoft/fabric-rest-api-specs:copyJob/swagger.json
// + MS Learn Copy Job definition article.
//
// A fully-configured server definition includes:
//   - top-level "activities" (always present; portal-managed)
//   - properties.source / properties.destination — connector endpoints
//   - properties.policy — timeout/retry
// These must NOT affect plan()/verify() hash comparisons; the adapter projects
// them away and operates only on the managed surface (jobMode + .platform).
// ---------------------------------------------------------------------------

/** Realistic server response: Lakehouse → Lakehouse Batch Copy Job */
function configuredBatchDefinitionResponse(mode: "Batch" | "CDC" = "Batch"): object {
  const content = {
    properties: {
      jobMode: mode,
      source: {
        type: "LakehouseTable",
        connectionSettings: {
          type: "Lakehouse",
          typeProperties: {
            workspaceId: "00000000-0000-0000-0000-000000000000",
            artifactId: "aaaaaaaa-6666-7777-8888-bbbbbbbbbbbb",
            rootFolder: "Tables",
          },
        },
      },
      destination: {
        type: "LakehouseTable",
        connectionSettings: {
          type: "Lakehouse",
          typeProperties: {
            workspaceId: "00000000-0000-0000-0000-000000000000",
            artifactId: "aaaaaaaa-0000-1111-2222-bbbbbbbbbbbb",
            rootFolder: "Tables",
          },
        },
      },
      policy: { timeout: "0.12:00:00" },
    },
    activities: [
      {
        id: "eeeeeeee-4444-5555-6666-ffffffffffff",
        properties: {
          source: {
            datasetSettings: { table: "publicholidays", firstRowAsHeader: true },
          },
          destination: {
            writeBehavior: "Append",
            datasetSettings: { table: "publicholidays", firstRowAsHeader: false },
          },
          translator: { type: "TabularTranslator" },
          typeConversionSettings: {
            typeConversion: { allowDataTruncation: true, treatBooleanAsNumber: false },
          },
        },
      },
    ],
  };
  return {
    definition: {
      parts: [
        {
          path: "copyjob-content.json",
          payload: Buffer.from(JSON.stringify(content)).toString("base64"),
          payloadType: "InlineBase64",
        },
      ],
    },
  };
}

describe("CopyJobAdapter — configured server definitions (portal-managed fields)", () => {
  it("plans no-op when server definition has portal-managed activities and source/destination/policy", async () => {
    // The desired manifest only specifies jobMode; the server returns a fully
    // configured definition.  Plan must be no-op, not blocked.
    const desired = batchDefinition(); // minimal: { properties: { jobMode: "Batch" } }
    const adapter = createAdapter(
      sequentialFetch(
        // list via /items?type=CopyJob
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        // get metadata
        { status: 200, body: copyJobResponse("id1", "MyCopyJob") },
        // getDefinition — fully configured server response
        { status: 200, body: configuredBatchDefinitionResponse("Batch") },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      desired,
    );
    expect(result.action).toBe("no-op");
    expect(result.physicalId).toBe("id1");
  });

  it("plans update (metadata drift) when server definition has portal-managed fields", async () => {
    // Metadata drift (description change) is still detected even when the
    // server definition contains portal-managed activities and connections.
    const desired = batchDefinition();
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        { status: 200, body: copyJobResponse("id1", "MyCopyJob", "old-description") },
        { status: 200, body: configuredBatchDefinitionResponse("Batch") },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob", description: "new-description" },
      desired,
    );
    expect(result.action).toBe("update");
    expect(result.physicalId).toBe("id1");
  });

  it("plans blocked (jobMode drift) when server definition has portal-managed fields", async () => {
    // jobMode immutability is still enforced even for a fully configured job.
    const desired = batchDefinition("CDC"); // desired CDC
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: { value: [copyJobResponse("id1", "MyCopyJob")] } },
        { status: 200, body: copyJobResponse("id1", "MyCopyJob") },
        // server returns fully configured Batch job
        { status: 200, body: configuredBatchDefinitionResponse("Batch") },
      ),
    );
    const result = await adapter.plan(
      "workspace",
      { displayName: "MyCopyJob" },
      desired,
    );
    expect(result.action).toBe("blocked");
    expect(result.reason).toMatch(/jobMode/i);
    expect(result.reason).toMatch(/immutable/i);
  });

  it("verify succeeds when server returns a fully configured definition matching desired jobMode", async () => {
    // After create/update, verify must accept the server's full definition.
    // Only the managed surface (jobMode) is compared — portal-managed fields
    // (activities, source, destination, policy) are projected away.
    const desired = batchDefinition();
    const item = copyJobResponse("id1", "MyCopyJob");
    const adapter = createAdapter(
      sequentialFetch(
        // GET metadata
        { status: 200, body: item },
        // getDefinition — fully configured server response
        { status: 200, body: configuredBatchDefinitionResponse("Batch") },
      ),
    );
    const result = await adapter.verify(
      "workspace",
      "id1",
      { displayName: "MyCopyJob" },
      desired,
    );
    expect(result.id).toBe("id1");
  });

  it("getDefinition returns the raw server definition without throwing for portal-managed fields", async () => {
    // Regression test: getDefinition must not call the strict desired-
    // definition validator; it must tolerate portal-managed extra fields.
    const adapter = createAdapter(
      sequentialFetch(
        { status: 200, body: configuredBatchDefinitionResponse("Batch") },
      ),
    );
    const def = await adapter.getDefinition("workspace", "id1");
    expect(def.parts).toHaveLength(1);
    // The raw part is returned as-is (projection happens only at hash time)
    const content = JSON.parse(
      Buffer.from(def.parts[0]!.payload, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    // source/destination/policy present in raw readback
    const props = content.properties as Record<string, unknown>;
    expect(props.source).toBeDefined();
    expect(props.destination).toBeDefined();
    expect(props.policy).toBeDefined();
    // activities present at top level
    expect(Array.isArray(content.activities)).toBe(true);
  });
});
