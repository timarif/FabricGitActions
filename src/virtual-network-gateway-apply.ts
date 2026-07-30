import { writeCheckpoint } from "./checkpoint";
import {
  hashDesiredVirtualNetworkGateway,
  hashObservedVirtualNetworkGateway,
  normalizeVirtualNetworkGatewayDefinitions,
  type VirtualNetworkGatewayAdapter,
  type VirtualNetworkGatewayPlanResult,
  type VirtualNetworkGatewayRecoveryState,
} from "./fabric/virtual-network-gateway";
import type {
  ApplyCheckpoint,
  ApplyCheckpointVirtualNetworkGateway,
  ApplyVirtualNetworkGatewayResult,
  DeploymentPlan,
  PlannedVirtualNetworkGateway,
  VirtualNetworkGatewayDefinition,
} from "./types";

type GatewayAdapter = Pick<
  VirtualNetworkGatewayAdapter,
  | "plan"
  | "create"
  | "resumeCreate"
  | "update"
  | "resumeUpdate"
  | "delete"
  | "resumeDelete"
  | "verifyPresent"
  | "verifyAbsent"
>;

export interface ApplyVirtualNetworkGatewaysOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  desired: VirtualNetworkGatewayDefinition[] | undefined;
  adapter?: GatewayAdapter;
  checkpoint: ApplyCheckpoint;
  checkpointFile: string;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
  now?: () => number;
}

export function virtualNetworkGatewaysRequireRecovery(
  checkpoint: ApplyCheckpoint,
): boolean {
  return Object.values(checkpoint.virtualNetworkGateways ?? {}).some(
    (state) => state.phase !== "verified",
  );
}

export function preflightVirtualNetworkGateways(
  options: ApplyVirtualNetworkGatewaysOptions,
): void {
  const approved = options.approvedPlan.virtualNetworkGateways;
  const current = options.currentPlan.virtualNetworkGateways;
  const checkpoint = options.checkpoint.virtualNetworkGateways ?? {};

  if (!approved) {
    if (options.desired !== undefined) {
      throw new Error(
        "The manifest configures virtualNetworkGateways, but the approved plan does not.",
      );
    }
    if (current !== undefined) {
      throw new Error(
        "The current plan configures virtualNetworkGateways, but the approved plan does not. Generate a new plan.",
      );
    }
    if (Object.keys(checkpoint).length > 0) {
      throw new Error(
        "Checkpoint contains virtual network gateway state, but the approved plan does not manage virtualNetworkGateways.",
      );
    }
    return;
  }
  if (!options.desired) {
    throw new Error(
      "The virtualNetworkGateways manifest definition is missing.",
    );
  }
  if (!options.adapter) {
    throw new Error(
      "Virtual network gateway apply requires a virtual network gateway adapter.",
    );
  }
  if (!current) {
    throw new Error(
      "Current virtual network gateway plans are missing. Generate a new plan.",
    );
  }

  const desiredByLogicalId = desiredDefinitionsByLogicalId(options.desired);
  const currentByLogicalId = plansByLogicalId(
    current,
    "current virtual network gateway plan",
  );
  assertSameLogicalIds(
    approved,
    desiredByLogicalId,
    currentByLogicalId,
  );

  for (const planned of approved) {
    assertApplicableAction(planned);
    const desired = desiredByLogicalId.get(planned.logicalId)!;
    if (
      hashDesiredVirtualNetworkGateway(desired) !==
      planned.desiredHash
    ) {
      throw new Error(
        `Virtual network gateway '${planned.logicalId}' no longer matches the approved desired configuration.`,
      );
    }
    const state = checkpoint[planned.logicalId];
    assertCurrentPlanHasNotDrifted(
      planned,
      currentByLogicalId.get(planned.logicalId)!,
      state,
    );
    if (state?.phase !== "verified") {
      assertActionAuthorized(planned, options);
    }
  }
}

export async function recoverInterruptedVirtualNetworkGateways(
  options: ApplyVirtualNetworkGatewaysOptions,
): Promise<void> {
  if (!virtualNetworkGatewaysRequireRecovery(options.checkpoint)) {
    return;
  }
  const approved = options.approvedPlan.virtualNetworkGateways;
  if (!approved || !options.desired || !options.adapter) {
    throw new Error(
      "Virtual network gateway recovery is missing its approved plan, manifest definition, or adapter.",
    );
  }
  const desiredByLogicalId = desiredDefinitionsByLogicalId(options.desired);
  for (const planned of approved) {
    const state =
      options.checkpoint.virtualNetworkGateways?.[planned.logicalId];
    if (!state || state.phase === "verified") {
      continue;
    }
    await applyOne(
      options,
      planned,
      desiredByLogicalId.get(planned.logicalId)!,
      true,
    );
  }
}

export async function applyVirtualNetworkGateways(
  options: ApplyVirtualNetworkGatewaysOptions,
  desiredState?: "present" | "absent",
): Promise<ApplyVirtualNetworkGatewayResult[] | undefined> {
  const approved = options.approvedPlan.virtualNetworkGateways;
  if (!approved) {
    return undefined;
  }
  if (!options.desired || !options.adapter) {
    throw new Error(
      "Virtual network gateway apply is missing its manifest definition or adapter.",
    );
  }
  const desiredByLogicalId = desiredDefinitionsByLogicalId(options.desired);
  const results: ApplyVirtualNetworkGatewayResult[] = [];
  for (const planned of approved.filter(
    (gateway) =>
      desiredState === undefined ||
      gateway.desiredState === desiredState,
  )) {
    results.push(
      await applyOne(
        options,
        planned,
        desiredByLogicalId.get(planned.logicalId)!,
        false,
      ),
    );
  }
  return results.length === 0 ? undefined : results;
}

async function applyOne(
  options: ApplyVirtualNetworkGatewaysOptions,
  planned: PlannedVirtualNetworkGateway,
  desired: VirtualNetworkGatewayDefinition,
  recoveryOnly: boolean,
): Promise<ApplyVirtualNetworkGatewayResult> {
  assertApplicableAction(planned);
  const adapter = options.adapter!;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const checkpoint =
    options.checkpoint.virtualNetworkGateways?.[planned.logicalId];

  if (recoveryOnly && (!checkpoint || checkpoint.phase === "verified")) {
    throw new Error(
      `Virtual network gateway '${planned.logicalId}' has no interrupted mutation to recover.`,
    );
  }

  if (checkpoint) {
    const recovered = await resumeOrVerify(
      options,
      planned,
      desired,
      checkpoint,
    );
    return {
      logicalId: planned.logicalId,
      action: planned.action,
      status: "resumed",
      ...(recovered.physicalId
        ? { physicalId: recovered.physicalId }
        : {}),
      durationMs: now() - startedAt,
    };
  }
  if (recoveryOnly) {
    throw new Error(
      `Virtual network gateway '${planned.logicalId}' recovery state disappeared before recovery.`,
    );
  }

  const fresh = await adapter.plan(desired);
  assertFreshPlanMatchesApproved(planned, fresh);

  if (planned.action === "no-op") {
    const verified = await verifyNoOp(adapter, planned, desired);
    recordVerified(
      options,
      planned,
      verified.physicalId,
      verified.observedStateHash,
    );
    return {
      logicalId: planned.logicalId,
      action: planned.action,
      status: "verified",
      ...(planned.desiredState === "present" &&
      verified.physicalId
        ? { physicalId: verified.physicalId }
        : {}),
      durationMs: now() - startedAt,
    };
  }

  if (planned.action === "create") {
    const created = await adapter.create(
      desired,
      mutationCallbacks(options, planned),
    );
    recordVerified(
      options,
      planned,
      created.id,
      hashObservedVirtualNetworkGateway(created),
    );
    return gatewayResult(planned, "created", created.id, now() - startedAt);
  }

  const physicalId = requirePhysicalId(
    planned.physicalId,
    planned.logicalId,
  );
  if (planned.action === "update") {
    const updated = await adapter.update(
      physicalId,
      desired,
      mutationCallbacks(options, planned, physicalId),
    );
    recordVerified(
      options,
      planned,
      updated.id,
      hashObservedVirtualNetworkGateway(updated),
    );
    return gatewayResult(planned, "updated", updated.id, now() - startedAt);
  }

  await adapter.delete(
    physicalId,
    desired,
    mutationCallbacks(options, planned, physicalId),
  );
  recordVerified(
    options,
    planned,
    physicalId,
    hashObservedVirtualNetworkGateway(undefined),
  );
  return gatewayResult(planned, "deleted", physicalId, now() - startedAt);
}

async function resumeOrVerify(
  options: ApplyVirtualNetworkGatewaysOptions,
  planned: PlannedVirtualNetworkGateway,
  desired: VirtualNetworkGatewayDefinition,
  checkpoint: ApplyCheckpointVirtualNetworkGateway,
): Promise<{ physicalId?: string }> {
  const adapter = options.adapter!;
  if (checkpoint.phase === "verified") {
    if (planned.desiredState === "absent") {
      await adapter.verifyAbsent(
        desired,
        checkpoint.physicalId ?? planned.physicalId,
      );
      return {};
    }
    const physicalId = requirePhysicalId(
      checkpoint.physicalId ?? planned.physicalId,
      planned.logicalId,
    );
    await adapter.verifyPresent(desired, physicalId);
    return { physicalId };
  }

  const recovery = recoveryState(checkpoint);
  if (planned.action === "create") {
    const created = await adapter.resumeCreate(
      desired,
      recovery,
      mutationCallbacks(options, planned),
    );
    recordVerified(
      options,
      planned,
      created.id,
      hashObservedVirtualNetworkGateway(created),
    );
    return { physicalId: created.id };
  }

  const physicalId = requirePhysicalId(
    checkpoint.physicalId ?? planned.physicalId,
    planned.logicalId,
  );
  if (planned.action === "update") {
    const updated = await adapter.resumeUpdate(
      physicalId,
      desired,
      recovery,
    );
    recordVerified(
      options,
      planned,
      updated.id,
      hashObservedVirtualNetworkGateway(updated),
    );
    return { physicalId: updated.id };
  }
  if (planned.action === "delete") {
    await adapter.resumeDelete(physicalId, desired, recovery);
    recordVerified(
      options,
      planned,
      physicalId,
      hashObservedVirtualNetworkGateway(undefined),
    );
    return { physicalId };
  }
  throw new Error(
    `Virtual network gateway '${planned.logicalId}' has checkpoint state for a no-op action that is not verified.`,
  );
}

async function verifyNoOp(
  adapter: GatewayAdapter,
  planned: PlannedVirtualNetworkGateway,
  desired: VirtualNetworkGatewayDefinition,
): Promise<{
  physicalId?: string;
  observedStateHash: string;
}> {
  if (planned.desiredState === "absent") {
    await adapter.verifyAbsent(desired, planned.physicalId);
    return {
      ...(planned.physicalId
        ? { physicalId: planned.physicalId }
        : {}),
      observedStateHash:
        hashObservedVirtualNetworkGateway(undefined),
    };
  }
  const physicalId = requirePhysicalId(
    planned.physicalId,
    planned.logicalId,
  );
  const gateway = await adapter.verifyPresent(desired, physicalId);
  return {
    physicalId,
    observedStateHash:
      hashObservedVirtualNetworkGateway(gateway),
  };
}

function mutationCallbacks(
  options: ApplyVirtualNetworkGatewaysOptions,
  planned: PlannedVirtualNetworkGateway,
  knownPhysicalId?: string,
) {
  return {
    onSubmitting: () =>
      recordState(options, planned, {
        phase: "submitting",
        ...(knownPhysicalId ? { physicalId: knownPhysicalId } : {}),
        observedStateHash: planned.observedStateHash,
      }),
    onRejected: () => clearState(options, planned.logicalId),
    onAccepted: (physicalId: string) =>
      recordState(options, planned, {
        phase: "accepted",
        physicalId,
        observedStateHash: planned.observedStateHash,
      }),
  };
}

function recordVerified(
  options: ApplyVirtualNetworkGatewaysOptions,
  planned: PlannedVirtualNetworkGateway,
  physicalId: string | undefined,
  observedStateHash: string,
): void {
  recordState(options, planned, {
    phase: "verified",
    ...(physicalId ? { physicalId } : {}),
    observedStateHash,
  });
}

function recordState(
  options: ApplyVirtualNetworkGatewaysOptions,
  planned: PlannedVirtualNetworkGateway,
  state: Pick<
    ApplyCheckpointVirtualNetworkGateway,
    "phase" | "physicalId" | "observedStateHash"
  >,
): void {
  const action = requireCheckpointAction(planned);
  const gateways =
    options.checkpoint.virtualNetworkGateways ??
    (options.checkpoint.virtualNetworkGateways = {});
  gateways[planned.logicalId] = {
    logicalId: planned.logicalId,
    desiredHash: planned.desiredHash,
    action,
    phase: state.phase,
    ...(state.physicalId
      ? { physicalId: state.physicalId }
      : {}),
    ...(state.observedStateHash
      ? { observedStateHash: state.observedStateHash }
      : {}),
    updatedAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearState(
  options: ApplyVirtualNetworkGatewaysOptions,
  logicalId: string,
): void {
  if (options.checkpoint.virtualNetworkGateways) {
    delete options.checkpoint.virtualNetworkGateways[logicalId];
    writeCheckpoint(options.checkpointFile, options.checkpoint);
  }
}

function recoveryState(
  checkpoint: ApplyCheckpointVirtualNetworkGateway,
): VirtualNetworkGatewayRecoveryState {
  if (
    checkpoint.phase !== "submitting" &&
    checkpoint.phase !== "accepted"
  ) {
    throw new Error(
      `Virtual network gateway '${checkpoint.logicalId}' recovery phase is invalid.`,
    );
  }
  return {
    phase: checkpoint.phase,
    ...(checkpoint.physicalId
      ? { physicalId: checkpoint.physicalId }
      : {}),
  };
}

function assertFreshPlanMatchesApproved(
  approved: PlannedVirtualNetworkGateway,
  fresh: VirtualNetworkGatewayPlanResult,
): void {
  if (
    fresh.action !== approved.action ||
    fresh.desiredHash !== approved.desiredHash ||
    fresh.observedStateHash !== approved.observedStateHash ||
    !optionalIdsEqual(fresh.physicalId, approved.physicalId)
  ) {
    throw new Error(
      `Virtual network gateway '${approved.logicalId}' changed after approval. Generate a new plan.`,
    );
  }
}

function assertCurrentPlanHasNotDrifted(
  approved: PlannedVirtualNetworkGateway,
  current: PlannedVirtualNetworkGateway,
  checkpoint: ApplyCheckpointVirtualNetworkGateway | undefined,
): void {
  if (current.desiredHash !== approved.desiredHash) {
    throw new Error(
      `Virtual network gateway '${approved.logicalId}' desired configuration changed after approval.`,
    );
  }
  if (!checkpoint) {
    if (
      current.action !== approved.action ||
      current.observedStateHash !== approved.observedStateHash ||
      !optionalIdsEqual(current.physicalId, approved.physicalId)
    ) {
      throw new Error(
        `Virtual network gateway '${approved.logicalId}' changed after approval. Generate a new plan.`,
      );
    }
    return;
  }

  const allowedActions =
    checkpoint.phase === "verified"
      ? new Set(["no-op", approved.action])
      : approved.action === "create"
        ? new Set(["create", "no-op"])
        : approved.action === "update"
          ? new Set(["update", "no-op"])
          : approved.action === "delete"
            ? new Set(["delete", "no-op"])
            : new Set(["no-op"]);
  if (!allowedActions.has(current.action)) {
    throw new Error(
      `Virtual network gateway '${approved.logicalId}' current action '${current.action}' is inconsistent with its checkpointed '${approved.action}' operation.`,
    );
  }
  const expectedPhysicalId =
    checkpoint.physicalId ?? approved.physicalId;
  if (
    expectedPhysicalId &&
    current.physicalId &&
    !idsEqual(expectedPhysicalId, current.physicalId)
  ) {
    throw new Error(
      `Virtual network gateway '${approved.logicalId}' current physical ID does not match its checkpoint.`,
    );
  }
}

function assertActionAuthorized(
  planned: PlannedVirtualNetworkGateway,
  options: ApplyVirtualNetworkGatewaysOptions,
): void {
  if (planned.action === "create" && !options.allowCreate) {
    throw new Error(
      "The approved plan requires virtual network gateway creation, but allow-vnet-gateway-create is false.",
    );
  }
  if (planned.action === "update" && !options.allowUpdate) {
    throw new Error(
      "The approved plan requires a virtual network gateway update, but allow-vnet-gateway-update is false.",
    );
  }
  if (planned.action === "delete" && !options.allowDelete) {
    throw new Error(
      "The approved plan requires virtual network gateway deletion, but allow-vnet-gateway-delete is false.",
    );
  }
}

function assertApplicableAction(
  planned: PlannedVirtualNetworkGateway,
): asserts planned is PlannedVirtualNetworkGateway & {
  action: "create" | "update" | "delete" | "no-op";
} {
  if (
    planned.action !== "create" &&
    planned.action !== "update" &&
    planned.action !== "delete" &&
    planned.action !== "no-op"
  ) {
    throw new Error(
      `Virtual network gateway '${planned.logicalId}' cannot be applied while action is '${planned.action}': ${planned.reason}`,
    );
  }
}

function assertSameLogicalIds(
  approved: PlannedVirtualNetworkGateway[],
  desired: ReadonlyMap<string, VirtualNetworkGatewayDefinition>,
  current: ReadonlyMap<string, PlannedVirtualNetworkGateway>,
): void {
  const approvedIds = new Set(approved.map((gateway) => gateway.logicalId));
  if (
    approvedIds.size !== approved.length ||
    desired.size !== approved.length ||
    current.size !== approved.length ||
    [...desired.keys()].some((logicalId) => !approvedIds.has(logicalId)) ||
    [...current.keys()].some((logicalId) => !approvedIds.has(logicalId))
  ) {
    throw new Error(
      "Virtual network gateway logical IDs do not match across the approved plan, current plan, and manifest.",
    );
  }
}

function desiredDefinitionsByLogicalId(
  definitions: VirtualNetworkGatewayDefinition[],
): Map<string, VirtualNetworkGatewayDefinition> {
  return new Map(
    normalizeVirtualNetworkGatewayDefinitions(definitions).map(
      (definition) => [definition.logicalId, definition],
    ),
  );
}

function plansByLogicalId(
  plans: PlannedVirtualNetworkGateway[],
  label: string,
): Map<string, PlannedVirtualNetworkGateway> {
  const mapped = new Map(
    plans.map((gateway) => [gateway.logicalId, gateway]),
  );
  if (mapped.size !== plans.length) {
    throw new Error(`${label} contains duplicate logical IDs.`);
  }
  return mapped;
}

function requireCheckpointAction(
  planned: PlannedVirtualNetworkGateway,
): ApplyCheckpointVirtualNetworkGateway["action"] {
  assertApplicableAction(planned);
  return planned.action;
}

function gatewayResult(
  planned: PlannedVirtualNetworkGateway,
  status: ApplyVirtualNetworkGatewayResult["status"],
  physicalId: string,
  durationMs: number,
): ApplyVirtualNetworkGatewayResult {
  return {
    logicalId: planned.logicalId,
    action: planned.action,
    status,
    physicalId,
    durationMs,
  };
}

function requirePhysicalId(
  physicalId: string | undefined,
  logicalId: string,
): string {
  if (!physicalId) {
    throw new Error(
      `Virtual network gateway '${logicalId}' is missing its approved physical ID.`,
    );
  }
  return physicalId;
}

function optionalIdsEqual(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && idsEqual(left, right);
}

function idsEqual(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") ===
    right.toLocaleLowerCase("en-US");
}
