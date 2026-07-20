import { describe, expect, it, vi } from "vitest";

import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import {
  hashObservedDeletionItem,
  isDeletableFabricItemType,
  ItemDeletionAdapter,
} from "../src/fabric/item-deletion";

const tokenProvider = {
  getToken: async () => "token",
};

function createAdapter(fetchImpl: FetchLike): ItemDeletionAdapter {
  return new ItemDeletionAdapter(
    new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider,
      fetchImpl,
      sleep: async () => undefined,
    }),
  );
}

describe("generic Fabric item deletion adapter", () => {
  it("treats Semantic Model as a generic soft-deletable item type", () => {
    expect(isDeletableFabricItemType("SemanticModel")).toBe(
      true,
    );
  });

  it("does not permit name-based Report deletion", () => {
    expect(isDeletableFabricItemType("Report")).toBe(false);
  });

  it("plans an already-absent item as a no-op in its exact folder", async () => {
    let requestedUrl = "";
    const adapter = createAdapter(
      vi.fn(async (input: string | URL) => {
        requestedUrl = String(input);
        return new Response(JSON.stringify({ value: [] }), {
          status: 200,
        });
      }),
    );

    const result = await adapter.plan(
      "workspace",
      "Notebook",
      {
        displayName: "Old Notebook",
        folderId: "folder-1",
        desiredState: "absent",
      },
    );

    expect(result.action).toBe("no-op");
    expect(result).not.toHaveProperty("physicalId");
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe("/v1/workspaces/workspace/items");
    expect(url.searchParams.get("type")).toBe("Notebook");
    expect(url.searchParams.get("recursive")).toBe("false");
    expect(url.searchParams.get("rootFolderId")).toBe("folder-1");
  });

  it("binds deletion approval to the exact item ID and metadata hash", async () => {
    const item = {
      id: "item-1",
      workspaceId: "workspace",
      type: "DataPipeline",
      displayName: "Old Pipeline",
      description: "Retire me",
      folderId: "folder-1",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [item] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(item), { status: 200 }),
      );
    const adapter = createAdapter(fetchImpl);

    await expect(
      adapter.plan("workspace", "DataPipeline", {
        displayName: "Old Pipeline",
        folderId: "folder-1",
        desiredState: "absent",
      }),
    ).resolves.toEqual({
      action: "delete",
      reason:
        "Data Pipeline 'Old Pipeline' exists and is approved for soft deletion.",
      physicalId: "item-1",
      observedStateHash: hashObservedDeletionItem(item),
    });
  });

  it("rejects ambiguous deletion targets", async () => {
    const duplicate = {
      id: "item-1",
      type: "Notebook",
      displayName: "Duplicate",
    };
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              value: [
                duplicate,
                { ...duplicate, id: "item-2" },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      adapter.plan("workspace", "Notebook", {
        displayName: "Duplicate",
        desiredState: "absent",
      }),
    ).rejects.toThrow("Multiple Notebook items");
  });

  it("soft-deletes only the approved generic item path", async () => {
    let method = "";
    let requestedUrl = "";
    const onDispatch = vi.fn();
    const adapter = createAdapter(
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        method = init?.method ?? "";
        requestedUrl = String(input);
        return new Response(null, { status: 200 });
      }),
    );

    await adapter.delete("workspace", "item-1", onDispatch);

    expect(method).toBe("DELETE");
    expect(new URL(requestedUrl).pathname).toBe(
      "/v1/workspaces/workspace/items/item-1",
    );
    expect(new URL(requestedUrl).searchParams.has("hardDelete")).toBe(false);
    expect(onDispatch).toHaveBeenCalledOnce();
  });

  it("fails closed when the approved item identity changes", async () => {
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: "item-1",
              workspaceId: "workspace",
              type: "Notebook",
              displayName: "Repurposed Notebook",
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      adapter.verifyApprovedIdentity(
        "workspace",
        "item-1",
        "Notebook",
        {
          displayName: "Old Notebook",
          desiredState: "absent",
        },
        "a".repeat(64),
      ),
    ).rejects.toThrow("no longer has the approved deletion identity");
  });

  it("treats an exact-ID 404 as confirmed absence", async () => {
    const adapter = createAdapter(
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              errorCode: "ItemNotFound",
              message: "Missing",
            }),
            { status: 404 },
          ),
      ),
    );

    await expect(
      adapter.verifyApprovedIdentity(
        "workspace",
        "item-1",
        "SparkJobDefinition",
        {
          displayName: "Old Job",
          desiredState: "absent",
        },
        "a".repeat(64),
      ),
    ).resolves.toBe("absent");
  });
});
