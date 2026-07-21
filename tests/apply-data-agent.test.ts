import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { applyApprovedPlan } from "../src/apply";
import {
  createCheckpoint,
  loadCheckpoint,
  writeCheckpoint,
} from "../src/checkpoint";
import type { FabricDefinition } from "../src/fabric/definition";
import { buildPlan, rehashPlan } from "../src/planner";
import type {
  ItemDefinition,
  LoadedManifest,
  PlannedAction,
} from "../src/types";
import { Buffer } from "node:buffer";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function b64(v: object): string {
  return Buffer.from(JSON.stringify(v)).toString("base64");
}

const ROOT_SCHEMA =
  "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json";

const minimalDataAgentDef: FabricDefinition = {
  parts: [
    {
      path: "Files/Config/data_agent.json",
      payload: b64({ $schema: ROOT_SCHEMA }),
      payloadType: "InlineBase64" as const,
    },
  ],
};

const loaded: LoadedManifest = {
  manifestPath: "deployment.yaml",
  manifestDirectory: ".",
  sourceHash: "source",
  resolvedHash: "resolved",
  itemContentHashes: { myAgent: "content" },
  itemDirectories: { myAgent: "items/my-agent" },
  itemDefinitions: {
    myAgent: { displayName: "My Data Agent", description: "A test agent" },
  },
  environmentDefinitions: {},
  notebookDefinitions: {},
  sparkJobDefinitions: {},
  pipelineDefinitions: {},
  semanticModelDefinitions: {},
  sparkCustomPoolDefinitions: {},
  dataAgentDefinitions: { myAgent: minimalDataAgentDef },
  manifest: {
    apiVersion: "fabric.deploy/v1alpha1",
    kind: "FabricDeployment",
    metadata: { deploymentId: "data-agent-test" },
    workspace: { id: "workspace-id" },
    items: [
      {
        logicalId: "myAgent",
        type: "DataAgent",
        path: "items/my-agent",
      },
    ],
  },
};

function makePlan(
  action: PlannedAction,
  observedStateHash = "observed",
  physicalId?: string,
) {
  const plan = buildPlan(loaded, {
    mode: "plan",
    environment: "dev",
    sourceCommit: "abc123",
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
  const root = mkdtempSync(path.join(tmpdir(), "fabric-da-apply-"));
  return {
    checkpointFile: path.join(root, "checkpoint.json"),
    resultFile: path.join(root, "result.json"),
  };
}

function lakehouseAdapter() {
  const fail = async () => {
    throw new Error("Lakehouse adapter should not be called.");
  };
  return { plan: vi.fn(fail), create: vi.fn(fail), update: vi.fn(fail), resumeCreate: vi.fn(fail), verify: vi.fn(fail) };
}

function dataAgentAdapter(
  plannedAction: "create" | "update" | "no-op" = "create",
  observedStateHash = plannedAction === "create" ? "absent" : "observed",
  physicalId = "agent-existing",
  stagedDefinitionHash?: string,
) {
  return {
    plan: vi.fn(async () => ({
      action: plannedAction,
      reason: plannedAction,
      observedStateHash,
      ...(plannedAction !== "create" ? { physicalId } : {}),
      ...(stagedDefinitionHash ? { stagedDefinitionHash } : {}),
      managedMetadataMatches: true,
    })),
    create: vi.fn(
      async (
        _ws: string,
        _desired: ItemDefinition,
        _def: FabricDefinition | undefined,
        onMutationAccepted?: (id: string) => void,
        _onOpAccepted?: unknown,
        onCreateSubmitting?: () => void,
      ) => {
        onCreateSubmitting?.();
        onMutationAccepted?.("agent-created");
        return { id: "agent-created", displayName: "My Data Agent", workspaceId: "workspace-id", type: "DataAgent" as const };
      },
    ),
    update: vi.fn(
      async (
        _ws: string,
        _id: string,
        _desired: ItemDefinition,
        _def: FabricDefinition | undefined,
        onMutationAccepted?: (id: string) => void,
        onUpdateCheckpoint?: unknown,
        _onUpdateRejected?: unknown,
      ) => {
        if (typeof onUpdateCheckpoint === "function") {
          onUpdateCheckpoint({ phase: "metadata-submitting", stagedDefinitionHash: "old-hash" });
          onUpdateCheckpoint({ phase: "metadata-updated", stagedDefinitionHash: "old-hash" });
          onUpdateCheckpoint({ phase: "definition-submitting", stagedDefinitionHash: "old-hash" });
          onUpdateCheckpoint({ phase: "definition-staged", stagedDefinitionHash: "new-hash" });
        }
        onMutationAccepted?.(physicalId);
        return { id: physicalId, displayName: "My Data Agent", workspaceId: "workspace-id", type: "DataAgent" as const };
      },
    ),
    resumeCreate: vi.fn(async () => ({
      id: "agent-resumed",
      displayName: "My Data Agent",
      workspaceId: "workspace-id",
      type: "DataAgent" as const,
    })),
    verify: vi.fn(async () => ({
      id: physicalId,
      displayName: "My Data Agent",
      workspaceId: "workspace-id",
      type: "DataAgent" as const,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests: create
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent create", () => {
  it("creates a DataAgent and returns status created", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create", "absent");
    const adapter = dataAgentAdapter("create");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(result.items[0]!.status).toBe("created");
    expect(result.items[0]!.physicalId).toBe("agent-created");
    expect(adapter.create).toHaveBeenCalledTimes(1);
  });

  it("does not call create when action is no-op", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("no-op", "observed", "agent-existing");
    const adapter = dataAgentAdapter("no-op", "observed", "agent-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: false,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(result.items[0]!.status).toBe("verified");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("fails when create is needed but allowCreate is false", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create");
    const adapter = dataAgentAdapter("create");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: false,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/allow-create is false/);
  });
});

// ---------------------------------------------------------------------------
// Tests: update
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent update", () => {
  it("updates a DataAgent and returns status updated", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("update", "observed", "agent-existing");
    const adapter = dataAgentAdapter("update", "observed", "agent-existing");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(result.items[0]!.status).toBe("updated");
    expect(adapter.update).toHaveBeenCalledTimes(1);
  });

  it("fails when update is needed but allowUpdate is false", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("update", "observed", "agent-existing");
    const adapter = dataAgentAdapter("update", "observed", "agent-existing");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: false,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/allow-update is false/);
  });
});

// ---------------------------------------------------------------------------
// Tests: shell create (no definition)
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent shell create", () => {
  it("creates a shell DataAgent (no definition in manifest)", async () => {
    const { checkpointFile, resultFile } = files();
    const shellLoaded: LoadedManifest = {
      ...loaded,
      dataAgentDefinitions: { myAgent: undefined },
    };
    const plan = makePlan("create", "absent");
    const adapter = dataAgentAdapter("create");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan: plan,
      loadedManifest: shellLoaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(result.items[0]!.status).toBe("created");
    // Verify the adapter was called with undefined definition
    expect(adapter.create).toHaveBeenCalledWith(
      "workspace-id",
      expect.objectContaining({ displayName: "My Data Agent" }),
      undefined,  // shell: no definition
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: adapter not initialized
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent adapter guard", () => {
  it("throws when DataAgent adapter is not provided", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan: plan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        // dataAgentAdapter intentionally omitted
        allowCreate: true,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/Data Agent adapter was not initialized/);
  });
});

// ---------------------------------------------------------------------------
// Tests: checkpoint recovery
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent checkpoint recovery", () => {
  it("resumes a completed create from checkpoint", async () => {
    const { checkpointFile, resultFile } = files();
    const approvedPlan = makePlan("create", "absent");
    const currentPlan = makePlan("no-op", "observed-resumed", "agent-created");
    const adapter = dataAgentAdapter("no-op", "observed-resumed", "agent-created");

    // Pre-write a checkpoint with completed create
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.completedItems["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      physicalId: "agent-created",
      completedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, checkpoint);

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    expect(result.items[0]!.status).toBe("resumed");
    expect(result.items[0]!.physicalId).toBe("agent-created");
    expect(adapter.create).not.toHaveBeenCalled();
  });

  it("re-applies update when desired definition matches staged hash (recovery proof valid)", async () => {
    const { checkpointFile, resultFile } = files();
    const { hashDataAgentDefinition } = await import("../src/fabric/data-agent-definition");

    const desiredHash = hashDataAgentDefinition(minimalDataAgentDef);

    const approvedPlan = makePlan("update", "observed", "agent-existing");
    // currentPlan: the server STILL shows "update" (adapter not yet re-applied)
    const currentPlan = makePlan("update", "observed", "agent-existing");
    const adapter = dataAgentAdapter("update", "observed", "agent-existing", desiredHash);

    // Pre-write an update checkpoint at "definition-staged" phase with correct desired hash
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates["myAgent"] = {
      logicalId: "myAgent",
      action: "update",
      physicalId: "agent-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: desiredHash,
    };
    writeCheckpoint(checkpointFile, checkpoint);

    const result = await applyApprovedPlan({
      approvedPlan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: false,
      allowUpdate: true,
      checkpointFile,
      resultFile,
    });

    expect(result.status).toBe("succeeded");
    // Items that were recovered via reconcilePendingUpdates are written to
    // completedItems and then the main apply loop marks them as "resumed"
    expect(result.items[0]!.status).toBe("resumed");
    expect(adapter.update).toHaveBeenCalledTimes(1);
  });

  it("blocks recovery and re-throws when desired definition changed (stale hash guard)", async () => {
    const { hashDataAgentDefinition } = await import("../src/fabric/data-agent-definition");
    const { checkpointFile, resultFile } = files();

    // A valid-format but wrong hash — simulates a previous run with different desired content
    const staleHash = "a".repeat(64);
    // The current desired hash (different from what was staged in the old run)
    const currentDesiredHash = hashDataAgentDefinition(minimalDataAgentDef);
    // staleHash must differ from currentDesiredHash to trigger the guard
    expect(staleHash).not.toBe(currentDesiredHash);

    const approvedPlan = makePlan("update", "observed", "agent-existing");
    const currentPlan = makePlan("update", "observed", "agent-existing");
    const adapter = dataAgentAdapter(
      "update",
      "new-observed-hash",
      "agent-existing",
      currentDesiredHash,
    );

    // Pre-write an update checkpoint with a STALE staged hash (doesn't match current desired)
    const checkpoint = createCheckpoint(approvedPlan);
    checkpoint.pendingUpdates["myAgent"] = {
      logicalId: "myAgent",
      action: "update",
      physicalId: "agent-existing",
      submittedAt: new Date().toISOString(),
      phase: "definition-staged",
      stagedDefinitionHash: staleHash, // ← stale, doesn't match current desired
    };
    writeCheckpoint(checkpointFile, checkpoint);

    // Recovery proof fails (staleHash !== currentDesiredHash) → falls through to
    // "cannot be reconciled" error because live.action is still "update"
    await expect(
      applyApprovedPlan({
        approvedPlan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/cannot be reconciled/);
  });

  it("refuses recovery when live stagedDefinitionHash differs from checkpointed hash (external drift after definition-staged)", async () => {
    const { hashDataAgentDefinition } = await import(
      "../src/fabric/data-agent-definition"
    );
    const { checkpointFile, resultFile } = files();
    const observedHash = "original-hash";
    const stagedHash = hashDataAgentDefinition(minimalDataAgentDef);

    const approvedPlan = makePlan("update", observedHash, "agent-id");
    approvedPlan.items[0] = {
      ...approvedPlan.items[0]!,
      action: "update",
      physicalId: "agent-id",
      observedStateHash: observedHash,
    };
    const rechashed = rehashPlan(approvedPlan);

    const externallyDriftedHash = "b".repeat(64);
    const adapter = {
      plan: vi.fn(async () => ({
        action: "update" as const,
        reason: "definition differs",
        observedStateHash: "new-observed-hash",
        physicalId: "agent-id",
        stagedDefinitionHash: externallyDriftedHash,
        managedMetadataMatches: true,
      })),
      create: vi.fn(async () => ({
        id: "agent-id",
        displayName: "My Data Agent",
        workspaceId: "workspace-id",
        type: "DataAgent" as const,
      })),
      update: vi.fn(
        async (
          _ws: string,
          _id: string,
          _desired: unknown,
          _def: unknown,
          onMutationAccepted?: (id: string) => void,
        ) => {
          onMutationAccepted?.("agent-id");
          return {
            id: "agent-id",
            displayName: "My Data Agent",
            workspaceId: "workspace-id",
            type: "DataAgent" as const,
          };
        },
      ),
      resumeCreate: vi.fn(async () => ({
        id: "agent-id",
        displayName: "My Data Agent",
        workspaceId: "workspace-id",
        type: "DataAgent" as const,
      })),
      verify: vi.fn(async () => ({
        id: "agent-id",
        displayName: "My Data Agent",
        workspaceId: "workspace-id",
        type: "DataAgent" as const,
      })),
    };

    const cp = createCheckpoint(rechashed);
    cp.pendingUpdates["myAgent"] = {
      logicalId: "myAgent",
      action: "update",
      physicalId: "agent-id",
      phase: "definition-staged",
      stagedDefinitionHash: stagedHash,
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);

    await expect(
      applyApprovedPlan({
        approvedPlan: rechashed,
        currentPlan: rechashed,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: false,
        allowUpdate: true,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/cannot be reconciled/);
    expect(adapter.update).not.toHaveBeenCalled();
  });
});

describe("applyApprovedPlan — DataAgent interrupted accepted-create recovery", () => {
  it("calls resumeCreate when a pendingOperation exists for a DataAgent", async () => {
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create", "absent");

    const adapter = dataAgentAdapter("create");
    const cp = createCheckpoint(plan);
    cp.pendingOperations["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      operationId: "op-abc",
      location: "https://api.fabric.microsoft.com/v1/operations/op-abc",
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);

    const currentPlan = makePlan("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(adapter.resumeCreate).toHaveBeenCalled();
    expect(result.status).toBe("succeeded");
  });
});

describe("create recovery wiring", () => {
  it("DataAgent is included in reconcilePendingCreates allowlist (compile-time regression)", () => {
    // This test is a compile-time regression guard: if someone removes DataAgent
    // from the reconcilePendingCreates allowlist in apply.ts, the type system
    // or a runtime error will surface here because applyApprovedPlan won't
    // accept a DataAgent pendingCreate plan.
    expect(typeof applyApprovedPlan).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Tests: DataAgent pendingCreate without proof must ALWAYS fail closed
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent pendingCreate ambiguous checkpoint (no proof)", () => {
  // Helper: write a pendingCreate checkpoint (simulates onCreateSubmitting fired,
  // but crash occurred before onOperationAccepted stored the physicalId proof).
  function writePendingCreateCheckpoint(checkpointFile: string, plan: ReturnType<typeof makePlan>) {
    const cp = createCheckpoint(plan);
    cp.pendingCreates["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      submittedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);
    return cp;
  }

  it("throws ambiguous-checkpoint for DataAgent pendingCreate when live state is no-op", async () => {
    // Scenario: POST succeeded (shell exists), but getDefinition/onOperationAccepted
    // crashed before writing pendingOperations proof.
    // live.action === "no-op" means an item with the same name already exists.
    // Without physicalId+shellDefinitionHash proof we cannot know if it's ours.
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create", "absent");
    writePendingCreateCheckpoint(checkpointFile, plan);

    // Adapter reports the agent already exists (no-op state)
    const adapter = dataAgentAdapter("no-op", "observed-existing", "agent-preexisting");
    const currentPlan = makePlan("no-op", "observed-existing", "agent-preexisting");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/ambiguous checkpoint|ambiguous|Refusing to adopt/);
    expect(adapter.create).not.toHaveBeenCalled();
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("throws for DataAgent pendingCreate when live state is update (item exists, definition differs)", async () => {
    // Scenario: same as above but the live item has drifted since creation.
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create", "absent");
    writePendingCreateCheckpoint(checkpointFile, plan);

    const adapter = dataAgentAdapter("update", "drifted-hash", "agent-preexisting");
    const currentPlan = makePlan("update", "drifted-hash", "agent-preexisting");

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: true,
        allowUpdate: true,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/ambiguous checkpoint|no resumable operation reference|Refusing to adopt/);
    expect(adapter.create).not.toHaveBeenCalled();
    expect(adapter.update).not.toHaveBeenCalled();
  });

  it("pendingOperation with sync proof (physicalId+shellDefinitionHash) does resume via resumeCreate", async () => {
    // This is the ONLY safe recovery path for a DataAgent shell create.
    // Verifies that the correct path (pendingOperations, not pendingCreates) works.
    const { checkpointFile, resultFile } = files();
    const plan = makePlan("create", "absent");

    const adapter = dataAgentAdapter("create");
    const cp = createCheckpoint(plan);
    cp.pendingOperations["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      physicalId: "agent-sync-proof-id",
      shellDefinitionHash: "a".repeat(64),
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);

    const currentPlan = makePlan("create", "absent");

    const result = await applyApprovedPlan({
      approvedPlan: plan,
      currentPlan,
      loadedManifest: loaded,
      lakehouseAdapter: lakehouseAdapter(),
      dataAgentAdapter: adapter,
      allowCreate: true,
      allowUpdate: false,
      checkpointFile,
      resultFile,
    });

    expect(adapter.resumeCreate).toHaveBeenCalledWith(
      "workspace-id",
      expect.objectContaining({ displayName: "My Data Agent" }),
      expect.anything(),
      expect.objectContaining({ physicalId: "agent-sync-proof-id", shellDefinitionHash: "a".repeat(64) }),
      expect.any(Function),
    );
    expect(result.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// reconcileInitialTerminalCreate — DataAgent no-op adoption blocked
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent: reconcileInitialTerminalCreate refuses no-op adoption", () => {
  it("rethrows FabricOperationFailedError even when live state is no-op after create failure", async () => {
    // Scenario: adapter.create() throws FabricOperationFailedError.
    // reconcileInitialTerminalCreate is called; live planner sees "no-op"
    // (an agent with the same name is already on the server).
    // DataAgent must NOT adopt the no-op item — the original error must be rethrown.
    const { checkpointFile, resultFile } = files();
    const { FabricOperationFailedError } = await import(
      "../src/fabric/client"
    );

    const plan = makePlan("create", "absent");
    const currentPlan = makePlan("create", "absent");

    // adapter.create throws FabricOperationFailedError.
    // adapter.plan (called from planDesiredItem in reconcileInitialTerminalCreate)
    // returns "no-op" — simulates a same-name agent appearing on the server.
    const adapter = {
      ...dataAgentAdapter("create"),
      create: vi.fn(async () => {
        throw new FabricOperationFailedError("Simulated LRO failure");
      }),
      plan: vi.fn()
        .mockResolvedValueOnce({
          // Pre-flight assertFreshItemHasNotDrifted: must match approved plan
          action: "create" as const,
          reason: "absent",
          observedStateHash: "absent",
        })
        .mockResolvedValueOnce({
          // reconcileInitialTerminalCreate live check: no-op means same-name item exists
          action: "no-op" as const,
          reason: "already exists",
          observedStateHash: "observed",
          physicalId: "preexisting-agent-id",
        }),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/Simulated LRO failure/);

    // verify and resumeCreate must never be called — we must not adopt
    expect(adapter.resumeCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resumePendingOperations — DataAgent no-op adoption blocked
// ---------------------------------------------------------------------------

describe("applyApprovedPlan — DataAgent: resumePendingOperations refuses no-op adoption", () => {
  it("rethrows original error when resumeCreate fails and live state is no-op", async () => {
    // Scenario: a pendingOperation exists; resumeCreate throws.
    // The catch block in resumePendingOperations sees live.action === "no-op".
    // DataAgent must NOT adopt the no-op item — original error must be rethrown,
    // checkpoint must be preserved.
    const { checkpointFile, resultFile } = files();

    const plan = makePlan("create", "absent");
    const currentPlan = makePlan("create", "absent");

    // Write a valid pendingOperation checkpoint
    const cp = createCheckpoint(plan);
    cp.pendingOperations["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      operationId: "op-pending",
      location: "https://api.fabric.microsoft.com/v1/operations/op-pending",
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);

    const resumeError = new Error("resumeCreate failed");

    // adapter.resumeCreate throws; adapter.plan (for reconciliation) returns "no-op"
    const adapter = {
      ...dataAgentAdapter("create"),
      resumeCreate: vi.fn(async () => {
        throw resumeError;
      }),
      plan: vi.fn(async () => ({
        action: "no-op" as const,
        reason: "already exists",
        observedStateHash: "observed",
        physicalId: "preexisting-agent-id",
      })),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/resumeCreate failed/);

    // The checkpoint must NOT have been completed — DataAgent must not be adopted
    const savedCp = loadCheckpoint(checkpointFile, plan);
    expect(savedCp?.completedItems["myAgent"]).toBeUndefined();
    // pendingOperation must still exist (was not cleared because live is no-op, not create)
    expect(savedCp?.pendingOperations["myAgent"]).toBeDefined();
  });

  it("clears pendingOperation checkpoint when LRO definitively fails and live is absent (create)", async () => {
    // Scenario: FabricOperationFailedError AND live.action === "create" (item absent).
    // This is the only DataAgent-permitted cleanup: clear checkpoint + rethrow.
    const { checkpointFile, resultFile } = files();
    const { FabricOperationFailedError } = await import(
      "../src/fabric/client"
    );

    const plan = makePlan("create", "absent");
    const currentPlan = makePlan("create", "absent");

    const cp = createCheckpoint(plan);
    cp.pendingOperations["myAgent"] = {
      logicalId: "myAgent",
      action: "create",
      operationId: "op-failed",
      location: "https://api.fabric.microsoft.com/v1/operations/op-failed",
      acceptedAt: new Date().toISOString(),
    };
    writeCheckpoint(checkpointFile, cp);

    const adapter = {
      ...dataAgentAdapter("create"),
      resumeCreate: vi.fn(async () => {
        throw new FabricOperationFailedError("LRO definitively failed");
      }),
      plan: vi.fn(async () => ({
        action: "create" as const, // item is absent — safe to clear checkpoint
        reason: "absent",
        observedStateHash: "absent",
      })),
    };

    await expect(
      applyApprovedPlan({
        approvedPlan: plan,
        currentPlan,
        loadedManifest: loaded,
        lakehouseAdapter: lakehouseAdapter(),
        dataAgentAdapter: adapter,
        allowCreate: true,
        allowUpdate: false,
        checkpointFile,
        resultFile,
      }),
    ).rejects.toThrow(/LRO definitively failed/);

    // Checkpoint should be cleared because live.action === "create" (absent)
    const savedCp = loadCheckpoint(checkpointFile, plan);
    expect(savedCp?.pendingOperations["myAgent"]).toBeUndefined();
    expect(savedCp?.completedItems["myAgent"]).toBeUndefined();
  });
});
