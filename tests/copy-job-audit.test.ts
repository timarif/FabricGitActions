/**
 * Integration self-audit tests for the Copy Job adapter.
 *
 * Covers audit points identified in the post-implementation review:
 * 1. main.ts adapter guard — copyJobAdapter in "adapters not initialized" check
 * 2. Duplicate desired-identity registration in manifest loading
 * 3. apply.ts pending-create/update/operation allowlists include CopyJob
 * 4. Schema/example round-trip via loadManifest
 * 5. dist contains CopyJobAdapter symbols
 * 6. onDispatch timing in create (via create callback sequence)
 * 7. Copy Job support coexists with Data Pipeline execution
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import type { FetchLike } from "../src/fabric/auth";
import { FabricClient } from "../src/fabric/client";
import { CopyJobAdapter } from "../src/fabric/copy-job";
import { loadManifest } from "../src/manifest";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  DeploymentPlan,
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const EXAMPLES_ROOT = path.join(process.cwd(), "examples");
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

function base64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const copyJobDefinition = {
  parts: [
    {
      path: "copyjob-content.json",
      payload: base64({ properties: { jobMode: "Batch" } }),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { job: "content" },
  itemDirectories: { job: "items/copy-jobs/job" },
  itemDefinitions: { job: { displayName: "Job", description: "desc" } },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  copyJobDefinitions: { job: copyJobDefinition },
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "audit" },
    workspace: { id: WORKSPACE_ID },
    items: [{ logicalId: "job", type: "CopyJob", path: "items/copy-jobs/job" }],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
): DeploymentPlan {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "sha1",
  });
  plan.items[0] = {
    ...plan.items[0]!,
    action,
    reason: action,
    observedStateHash,
    ...(physicalId ? { physicalId } : {}),
  };
  return rehashPlan(plan);
}

function files() {
  const root = mkdtempSync(path.join(tmpdir(), "copyjob-audit-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function makeLakehouseAdapter() {
  const fail = async () => { throw new Error("Lakehouse adapter must not be called."); };
  return { plan: vi.fn(fail), create: vi.fn(fail), update: vi.fn(fail), resumeCreate: vi.fn(fail), verify: vi.fn(fail) };
}

function makeCopyJobAdapterMock(
  action: "create" | "update" | "no-op" = "create",
  observedStateHash = action === "create" ? "absent" : "observed",
  physicalId = "job-id",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action,
      reason: action,
      observedStateHash,
      ...(action === "create" ? {} : { physicalId }),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(async (
      _w: string, _d: ItemDefinition, _def: unknown,
      onMutationAccepted?: (id: string) => void,
      _onOp?: unknown,
      onCreateSubmitting?: () => void,
    ) => {
      onCreateSubmitting?.();
      onMutationAccepted?.("job-created");
      return { id: "job-created", displayName: "Job" };
    }),
    update: vi.fn(async (
      _w: string, id: string, _d: ItemDefinition, _def: unknown,
      onMutationAccepted?: (id: string) => void,
      onCheckpoint?: (state?: { phase: string; stagedDefinitionHash: string }) => void,
    ) => {
      onCheckpoint?.({ phase: "metadata-submitting", stagedDefinitionHash: "a".repeat(64) });
      onCheckpoint?.({ phase: "definition-staged", stagedDefinitionHash: "b".repeat(64) });
      onMutationAccepted?.(id);
      return { id, displayName: "Job" };
    }),
    resumeCreate: vi.fn(async (
      _w: string, _d: ItemDefinition, _def: unknown, _op: unknown,
      onMutationAccepted?: (id: string) => void,
    ) => {
      onMutationAccepted?.("job-created");
      return { id: "job-created", displayName: "Job" };
    }),
    verify: vi.fn(async (_w: string, id: string) => ({ id, displayName: "Job" })),
  };
}

function makeTempItemDir(
  logicalId: string,
  displayName: string,
  root: string,
  folderDir = "items/copy-jobs",
): string {
  const relPath = `${folderDir}/${logicalId}`;
  const absDir = path.join(root, relPath);
  mkdirSync(path.join(absDir, "definition"), { recursive: true });
  writeFileSync(path.join(absDir, "item.yaml"), `displayName: ${displayName}\n`, "utf8");
  writeFileSync(
    path.join(absDir, "definition", "copyjob-content.json"),
    JSON.stringify({ properties: { jobMode: "Batch" } }),
    "utf8",
  );
  return relPath;
}

// ---------------------------------------------------------------------------
// 1. main.ts adapter guard — copyJobAdapter included in "not initialized" check
// ---------------------------------------------------------------------------

describe("main.ts adapter guard (audit)", () => {
  it("main.ts source includes copyJobAdapter in the plan-guard check", () => {
    const mainSrc = readFileSync(
      path.join(process.cwd(), "src/main.ts"),
      "utf8",
    );
    // Find the "Fabric adapters were not initialized for authenticated planning" block
    const planGuardMatch = mainSrc.match(
      /!pipelineAdapter[^}]+Fabric adapters were not initialized for authenticated planning/s,
    );
    expect(planGuardMatch).not.toBeNull();
    expect(planGuardMatch![0]).toContain("!copyJobAdapter");
  });

  it("main.ts source includes copyJobAdapter in the apply-guard check", () => {
    const mainSrc = readFileSync(
      path.join(process.cwd(), "src/main.ts"),
      "utf8",
    );
    // Find the "Fabric adapters were not initialized for apply mode" block
    const applyGuardMatch = mainSrc.match(
      /!pipelineAdapter[^}]+Fabric adapters were not initialized for apply mode/s,
    );
    expect(applyGuardMatch).not.toBeNull();
    expect(applyGuardMatch![0]).toContain("!copyJobAdapter");
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate desired-identity registration
// ---------------------------------------------------------------------------

describe("duplicate CopyJob desired-identity detection (audit)", () => {
  it("rejects two CopyJob items with the same displayName in workspace root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "copyjob-dup-"));
    const path1 = makeTempItemDir("job-a", "SharedJob", root);
    const path2 = makeTempItemDir("job-b", "SharedJob", root);
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(manifestPath, `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: dup-test
workspace:
  id: ${WORKSPACE_ID}
items:
  - logicalId: job-a
    type: CopyJob
    path: ${path1}
  - logicalId: job-b
    type: CopyJob
    path: ${path2}
`, "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(
      "CopyJob items 'job-a' and 'job-b' resolve to the same folder and displayName",
    );
  });

  it("allows two CopyJob items with the same displayName in different folders", () => {
    const root = mkdtempSync(path.join(tmpdir(), "copyjob-dup2-"));
    const folderADir = "items/copy-jobs/folder-a";
    const folderBDir = "items/copy-jobs/folder-b";
    // Create items manually with folderId set
    for (const [relDir, folderId] of [[folderADir, "folder-a-id"], [folderBDir, "folder-b-id"]] as const) {
      const absDir = path.join(root, relDir);
      mkdirSync(path.join(absDir, "definition"), { recursive: true });
      writeFileSync(path.join(absDir, "item.yaml"),
        `displayName: SharedJob\nfolderId: ${folderId}\n`, "utf8");
      writeFileSync(path.join(absDir, "definition", "copyjob-content.json"),
        JSON.stringify({ properties: { jobMode: "Batch" } }), "utf8");
    }
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(manifestPath, `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: diff-folders
workspace:
  id: ${WORKSPACE_ID}
items:
  - logicalId: job-a
    type: CopyJob
    path: ${folderADir}
  - logicalId: job-b
    type: CopyJob
    path: ${folderBDir}
`, "utf8");
    expect(() => loadManifest(manifestPath)).not.toThrow();
  });

  it("rejects two CopyJob items with the same displayName and same folderId", () => {
    const root = mkdtempSync(path.join(tmpdir(), "copyjob-dup3-"));
    for (const logId of ["job-c", "job-d"]) {
      const absDir = path.join(root, "items/copy-jobs", logId);
      mkdirSync(path.join(absDir, "definition"), { recursive: true });
      writeFileSync(path.join(absDir, "item.yaml"),
        "displayName: SharedJob\nfolderId: same-folder\n", "utf8");
      writeFileSync(path.join(absDir, "definition", "copyjob-content.json"),
        JSON.stringify({ properties: { jobMode: "Batch" } }), "utf8");
    }
    const manifestPath = path.join(root, "deployment.yaml");
    writeFileSync(manifestPath, `
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: same-folder-test
workspace:
  id: ${WORKSPACE_ID}
items:
  - logicalId: job-c
    type: CopyJob
    path: items/copy-jobs/job-c
  - logicalId: job-d
    type: CopyJob
    path: items/copy-jobs/job-d
`, "utf8");
    expect(() => loadManifest(manifestPath)).toThrow(
      "CopyJob items 'job-c' and 'job-d' resolve to the same folder and displayName",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. apply.ts pending-create and pending-update allowlists
// ---------------------------------------------------------------------------

describe("pending-create checkpoint recovery for CopyJob (audit)", () => {
  it("throws when pending-create has no operation reference and item still absent", async () => {
    // A pending-create with no operationReference means the create request was
    // dispatched but the 202 LRO response was never checkpointed. The adapter
    // correctly throws rather than attempting a blind re-create.
    const plan = makePlan("create", "absent");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingCreates.job = {
      logicalId: "job",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    const adapter = makeCopyJobAdapterMock("create", "absent");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: makeLakehouseAdapter(),
        copyJobAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        ...output,
      }),
    ).rejects.toThrow("has no resumable operation reference");
  });

  it("completes a pending-create CopyJob when live state is already no-op (item appeared)", async () => {
    // This is the happy-path recovery: item was created during the operation but
    // we crashed before writing the completion checkpoint. The live state is now
    // no-op because the item exists with the correct hash.
    const plan = makePlan("create", "absent");
    const output = files();
    const checkpoint = createCheckpoint(plan);
    checkpoint.pendingCreates.job = {
      logicalId: "job",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    const adapter = makeCopyJobAdapterMock("no-op", "observed", "job-id");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: makeLakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(result.items[0]?.physicalId).toBe("job-id");
  });
});

describe("pending-update checkpoint recovery for CopyJob (audit)", () => {
  it("recovers a pending-update CopyJob via hasCopyJobRecoveryProof", async () => {
    const approvedPlan = makePlan("update", "before", "job-id");
    const stagedHash = "c".repeat(64);
    const currentPlan = makePlan("update", "before", "job-id");
    const output = files();
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates.job = {
      logicalId: "job",
      action: "update",
      physicalId: "job-id",
      submittedAt: new Date().toISOString(),
      phase: "metadata-updated",
      stagedDefinitionHash: stagedHash,
    };
    writeCheckpoint(output.checkpointFile, checkpoint);

    const adapter = makeCopyJobAdapterMock(
      "update",
      "before",
      "job-id",
      stagedHash,
    );

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: makeLakehouseAdapter(),
      copyJobAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      ...output,
    });

    expect(result.items[0]?.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 4. Schema and example round-trip
// ---------------------------------------------------------------------------

describe("schema and example round-trip (audit)", () => {
  it("deployment schema enum includes CopyJob", () => {
    const schema = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "schemas/deployment-v1alpha1.schema.json"),
        "utf8",
      ),
    ) as { properties: { items: { items: { properties: { type: { enum: string[] } } } } } };
    const types = schema.properties.items.items.properties.type.enum;
    expect(types).toContain("CopyJob");
  });

  it("loadManifest loads the copy-job example with one CopyJob item", () => {
    const loaded = loadManifest(
      path.join(EXAMPLES_ROOT, "copy-job/fabric/deployment.yaml"),
      { variables: { FABRIC_WORKSPACE_ID: WORKSPACE_ID } },
    );
    expect(loaded.manifest.items).toHaveLength(1);
    expect(loaded.manifest.items[0]?.type).toBe("CopyJob");
    expect(loaded.copyJobDefinitions).toBeDefined();
    expect(Object.keys(loaded.copyJobDefinitions ?? {})).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5. dist contains CopyJobAdapter symbols
// ---------------------------------------------------------------------------

describe("dist build contains CopyJob symbols (audit)", () => {
  it("dist/index.js contains copyjob-content string", () => {
    const dist = readFileSync(
      path.join(process.cwd(), "dist/index.js"),
      "utf8",
    );
    expect(dist).toContain("copyjob-content.json");
  });

  it("dist/index.js contains CopyJob type string", () => {
    const dist = readFileSync(
      path.join(process.cwd(), "dist/index.js"),
      "utf8",
    );
    expect(dist).toContain("CopyJob");
  });

  it("dist/index.js contains copyJobs API path string", () => {
    const dist = readFileSync(
      path.join(process.cwd(), "dist/index.js"),
      "utf8",
    );
    expect(dist).toContain("/copyJobs");
  });
});

// ---------------------------------------------------------------------------
// 6. onDispatch timing — onCreateSubmitting fires before the HTTP response
// ---------------------------------------------------------------------------

describe("CopyJobAdapter.create onDispatch timing (audit)", () => {
  it("calls onCreateSubmitting before receiving the server response", async () => {
    const callOrder: string[] = [];
    const fetchImpl: FetchLike = vi.fn(async () => {
      callOrder.push("fetch");
      const body = { id: "new-id", displayName: "Job" };
      return new Response(JSON.stringify(body), { status: 201 });
    });
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider: { getToken: async () => "token" },
      fetchImpl,
      operationPollIntervalMs: 1,
    });
    const adapter = new CopyJobAdapter(client);

    const onCreateSubmitting = vi.fn(() => {
      callOrder.push("onCreateSubmitting");
    });

    // Intercept verify calls (GET + getDefinition POST) after create
    let callCount = 0;
    (fetchImpl as ReturnType<typeof vi.fn>).mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      callCount++;
      if (callCount === 1) {
        // First call is the POST /copyJobs
        callOrder.push("fetch");
        return new Response(
          JSON.stringify({ id: "new-id", displayName: "Job" }),
          { status: 201 },
        );
      }
      if (url.includes("new-id") && init?.method !== "POST") {
        // GET verify
        return new Response(
          JSON.stringify({ id: "new-id", displayName: "Job" }),
          { status: 200 },
        );
      }
      // POST getDefinition
      return new Response(
        JSON.stringify({
          definition: {
            parts: [{
              path: "copyjob-content.json",
              payload: base64({ properties: { jobMode: "Batch" } }),
              payloadType: "InlineBase64",
            }],
          },
        }),
        { status: 200 },
      );
    });

    await adapter.create(
      "workspace",
      { displayName: "Job" },
      copyJobDefinition,
      undefined,
      undefined,
      onCreateSubmitting,
    );

    // onCreateSubmitting must fire before the fetch response arrives
    const submittingIdx = callOrder.indexOf("onCreateSubmitting");
    const fetchIdx = callOrder.indexOf("fetch");
    expect(submittingIdx).toBeGreaterThanOrEqual(0);
    // onCreateSubmitting is called as onDispatch which fires just before the actual fetch
    // It should appear before OR at the same position as fetch
    expect(submittingIdx).toBeLessThanOrEqual(fetchIdx);
  });
});

// ---------------------------------------------------------------------------
// 7. Copy Job support coexists with Data Pipeline execution
// ---------------------------------------------------------------------------

describe("shared integration coexistence (audit)", () => {
  it("src/main.ts retains run-pipeline mode with Copy Job support", () => {
    const mainSrc = readFileSync(
      path.join(process.cwd(), "src/main.ts"),
      "utf8",
    );
    expect(mainSrc).toContain("run-pipeline");
    expect(mainSrc).toContain("PipelineJobAdapter");
    expect(mainSrc).toContain("runPipeline");
    expect(mainSrc).toContain("CopyJobAdapter");
  });

  it("action.yml retains run-pipeline inputs", () => {
    const actionYaml = readFileSync(
      path.join(process.cwd(), "action.yml"),
      "utf8",
    );
    expect(actionYaml).toContain("run-pipeline");
    expect(actionYaml).toContain("allow-pipeline-run");
    expect(actionYaml).toContain("pipeline-logical-id");
  });
});

// ---------------------------------------------------------------------------
// 8. CopyJobAdapter can be instantiated from the adapter export
// ---------------------------------------------------------------------------

describe("CopyJobAdapter instantiation (audit)", () => {
  it("CopyJobAdapter can be constructed with a FabricClient", () => {
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider: { getToken: async () => "token" },
      fetchImpl: vi.fn(),
      operationPollIntervalMs: 1,
    });
    expect(() => new CopyJobAdapter(client)).not.toThrow();
  });

  it("CopyJobAdapter exposes plan, create, resumeCreate, update, verify", () => {
    const client = new FabricClient({
      endpoint: "https://api.fabric.microsoft.com",
      scope: "scope",
      tokenProvider: { getToken: async () => "token" },
      fetchImpl: vi.fn(),
      operationPollIntervalMs: 1,
    });
    const adapter = new CopyJobAdapter(client);
    expect(typeof adapter.plan).toBe("function");
    expect(typeof adapter.create).toBe("function");
    expect(typeof adapter.resumeCreate).toBe("function");
    expect(typeof adapter.update).toBe("function");
    expect(typeof adapter.verify).toBe("function");
  });
});
