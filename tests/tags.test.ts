import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  FabricTagAdapter,
  hashObservedTags,
  type DesiredFabricTag,
  type FabricTag,
} from "../src/fabric/tags";

const tokenProvider = {
  getToken: async () => "token",
};

const TAG_A = "11111111-1111-1111-1111-111111111111";
const TAG_B = "22222222-2222-2222-2222-222222222222";
const TAG_C = "33333333-3333-3333-3333-333333333333";
const DOMAIN_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DOMAIN_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const WORKSPACE = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ITEM = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function tenantTag(overrides: Partial<FabricTag> = {}): FabricTag {
  return {
    id: TAG_A,
    displayName: "Confidential",
    scope: { type: "Tenant" },
    ...overrides,
  };
}

function domainTag(
  domainId: string,
  overrides: Partial<FabricTag> = {},
): FabricTag {
  return {
    id: TAG_B,
    displayName: "Confidential",
    scope: { type: "Domain", domainId },
    ...overrides,
  };
}

function createAdapter(fetchImpl: FetchLike): FabricTagAdapter {
  return new FabricTagAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const tenantDesired: DesiredFabricTag = {
  displayName: "Confidential",
  scope: { type: "Tenant" },
};

const domainADesired: DesiredFabricTag = {
  displayName: "Confidential",
  scope: { type: "Domain", domainId: DOMAIN_A },
};

describe("Fabric tag adapter", () => {
  it("lists all tags across pagination", async () => {
    const requested: string[] = [];
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("continuationToken=next")) {
          return jsonResponse({ value: [domainTag(DOMAIN_A)] });
        }
        return jsonResponse({
          value: [tenantTag()],
          continuationToken: "next",
        });
      }),
    );

    await expect(adapter.list()).resolves.toEqual([
      tenantTag(),
      domainTag(DOMAIN_A),
    ]);
    expect(requested.every((url) => url.includes("/v1/tags"))).toBe(true);
  });

  it("plans an exact tenant no-op with the physical ID", async () => {
    const adapter = createAdapter(
      vi.fn(async () => jsonResponse({ value: [tenantTag()] })),
    );
    await expect(adapter.plan(tenantDesired)).resolves.toMatchObject({
      action: "no-op",
      physicalId: TAG_A,
    });
  });

  it("plans a create when no tag matches the scope", async () => {
    const adapter = createAdapter(
      vi.fn(async () => jsonResponse({ value: [] })),
    );
    const result = await adapter.plan(tenantDesired);
    expect(result.action).toBe("create");
    expect(result.physicalId).toBeUndefined();
    expect(result.observedStateHash).toBe(hashObservedTags([]));
  });

  it("allows the same name in a different domain (create)", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ value: [domainTag(DOMAIN_B)] }),
      ),
    );
    await expect(adapter.plan(domainADesired)).resolves.toMatchObject({
      action: "create",
    });
  });

  it("plans a domain no-op when the same domain already has the tag", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ value: [domainTag(DOMAIN_A)] }),
      ),
    );
    await expect(adapter.plan(domainADesired)).resolves.toMatchObject({
      action: "no-op",
      physicalId: TAG_B,
    });
  });

  it("blocks multiple exact candidates in the same scope", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          value: [tenantTag(), tenantTag({ id: TAG_B })],
        }),
      ),
    );
    await expect(adapter.plan(tenantDesired)).resolves.toMatchObject({
      action: "blocked",
    });
  });

  it("blocks a case-insensitive conflict in the same tenant scope", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          value: [tenantTag({ displayName: "confidential" })],
        }),
      ),
    );
    const result = await adapter.plan(tenantDesired);
    expect(result.action).toBe("blocked");
    expect(result.physicalId).toBe(TAG_A);
  });

  it("blocks a tenant tag that conflicts with a domain tag of the same name", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ value: [domainTag(DOMAIN_A)] }),
      ),
    );
    await expect(adapter.plan(tenantDesired)).resolves.toMatchObject({
      action: "blocked",
    });
  });

  it("blocks a domain tag that conflicts with a tenant tag of the same name", async () => {
    const adapter = createAdapter(
      vi.fn(async () => jsonResponse({ value: [tenantTag()] })),
    );
    await expect(adapter.plan(domainADesired)).resolves.toMatchObject({
      action: "blocked",
    });
  });

  it("creates a tag via a single bulkCreateTags request and validates the response", async () => {
    let request: unknown;
    let requestUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requestUrl = String(input);
        request = JSON.parse(String(init?.body));
        return jsonResponse({ tags: [tenantTag()] }, 201);
      }),
    );

    await expect(adapter.create(tenantDesired)).resolves.toEqual(tenantTag());
    expect(requestUrl).toContain("/v1/admin/tags/bulkCreateTags");
    expect(request).toEqual({
      scope: { type: "Tenant" },
      createTagsRequest: [{ displayName: "Confidential" }],
    });
  });

  it("rejects a bulkCreateTags response that does not return exactly one tag", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ tags: [tenantTag(), tenantTag({ id: TAG_B })] }, 201),
      ),
    );
    await expect(adapter.create(tenantDesired)).rejects.toThrow(
      "expected exactly one",
    );
  });

  it("rejects a created tag whose scope drifts from the request", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ tags: [domainTag(DOMAIN_A)] }, 201),
      ),
    );
    await expect(adapter.create(tenantDesired)).rejects.toThrow(
      "mismatched scope",
    );
  });

  it("verifies a tag from the catalog by exact id, name, and scope", async () => {
    const adapter = createAdapter(
      vi.fn(async () => jsonResponse({ value: [tenantTag()] })),
    );
    await expect(adapter.verify(tenantDesired, TAG_A)).resolves.toEqual(
      tenantTag(),
    );
  });

  it("fails verification when the catalog tag name differs", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ value: [tenantTag({ displayName: "Public" })] }),
      ),
    );
    await expect(adapter.verify(tenantDesired, TAG_A)).rejects.toThrow(
      "verification failed",
    );
  });

  it("treats a missing tags array on an item as an empty assignment (update)", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ id: ITEM, displayName: "Report" }),
      ),
    );
    const plan = await adapter.planItemAssignment(WORKSPACE, ITEM, [TAG_A]);
    expect(plan.action).toBe("update");
    expect(plan.observedTagIds).toEqual([]);
    expect(plan.missingTagIds).toEqual([TAG_A]);
  });

  it("plans an additive no-op when all desired tags are already applied", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          tags: [
            { id: TAG_A, displayName: "Confidential" },
            { id: TAG_C, displayName: "Unrelated" },
          ],
        }),
      ),
    );
    const plan = await adapter.planItemAssignment(WORKSPACE, ITEM, [TAG_A]);
    expect(plan.action).toBe("no-op");
    expect(plan.missingTagIds).toEqual([]);
    expect(plan.observedTagIds).toEqual([TAG_A, TAG_C].sort());
  });

  it("plans an additive update ignoring unrelated existing tags", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          tags: [{ id: TAG_C, displayName: "Unrelated" }],
        }),
      ),
    );
    const plan = await adapter.planItemAssignment(WORKSPACE, ITEM, [
      TAG_B,
      TAG_A,
    ]);
    expect(plan.action).toBe("update");
    expect(plan.desiredTagIds).toEqual([TAG_A, TAG_B]);
    expect(plan.missingTagIds).toEqual([TAG_A, TAG_B]);
  });

  it("posts a canonical sorted unique applyTags body", async () => {
    let request: unknown;
    let requestUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        requestUrl = String(input);
        request = JSON.parse(String(init?.body));
        return new Response(null, { status: 200 });
      }),
    );

    await adapter.applyItemTags(WORKSPACE, ITEM, [
      TAG_B,
      TAG_A,
      TAG_A.toUpperCase(),
    ]);
    expect(requestUrl).toContain(
      `/v1/workspaces/${WORKSPACE}/items/${ITEM}/applyTags`,
    );
    expect(request).toEqual({ tags: [TAG_A, TAG_B] });
  });

  it("verifies an item assignment when the desired subset is present", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({
          tags: [
            { id: TAG_A, displayName: "Confidential" },
            { id: TAG_C, displayName: "Unrelated" },
          ],
        }),
      ),
    );
    await expect(
      adapter.verifyItemAssignment(WORKSPACE, ITEM, [TAG_A]),
    ).resolves.toEqual([TAG_A, TAG_C].sort());
  });

  it("throws item verification when a desired tag is missing", async () => {
    const adapter = createAdapter(
      vi.fn(async () =>
        jsonResponse({ tags: [{ id: TAG_C, displayName: "Unrelated" }] }),
      ),
    );
    await expect(
      adapter.verifyItemAssignment(WORKSPACE, ITEM, [TAG_A]),
    ).rejects.toThrow("verification failed");
  });

  it("produces deterministic hashes independent of tag ordering", () => {
    const ordered = hashObservedTags([tenantTag(), domainTag(DOMAIN_A)]);
    const reversed = hashObservedTags([domainTag(DOMAIN_A), tenantTag()]);
    expect(ordered).toBe(reversed);
    expect(hashObservedTags([tenantTag()])).not.toBe(ordered);
  });

  it("rejects non-UUID desired tag IDs and over-long names", async () => {
    const adapter = createAdapter(vi.fn());
    await expect(
      adapter.planItemAssignment(WORKSPACE, ITEM, ["not-a-guid"]),
    ).rejects.toThrow("must be a GUID");
    await expect(
      adapter.plan({
        displayName: "x".repeat(41),
        scope: { type: "Tenant" },
      }),
    ).rejects.toThrow("at most 40 characters");
  });

  it("does not expose delete or update behavior", () => {
    const adapter = createAdapter(vi.fn());
    expect("delete" in adapter).toBe(false);
    expect("update" in adapter).toBe(false);
  });
});
