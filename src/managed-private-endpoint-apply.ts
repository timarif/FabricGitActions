import { writeCheckpoint } from "./checkpoint";
import { FabricApiError } from "./fabric/client";
import {
  hashManagedPrivateEndpointDesiredIdentity,
  hashManagedPrivateEndpointOperation,
  hashManagedPrivateEndpointObservedIdentity,
  managedPrivateEndpointCheckpointKey,
  ManagedPrivateEndpointAdapter,
  normalizeManagedPrivateEndpoints,
  planManagedPrivateEndpoints,
  type CanonicalManagedPrivateEndpoint,
  type LiveManagedPrivateEndpoint,
} from "./fabric/managed-private-endpoints";
import { compareCanonicalStrings, stableJson } from "./hash";
import type {
  ApplyCheckpoint,
  ApplyCheckpointManagedPrivateEndpoint,
  ApplyManagedPrivateEndpointResult,
  DeploymentPlan,
  NetworkProtectionManifest,
  PlannedManagedPrivateEndpoint,
} from "./types";

const RECREATE_DELAY_MS = 15 * 60 * 1000;

export interface ApplyManagedPrivateEndpointOptions {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  desired: NetworkProtectionManifest | undefined;
  adapter?: Pick<
    ManagedPrivateEndpointAdapter,
    | "listManagedPrivateEndpoints"
    | "getManagedPrivateEndpoint"
    | "createManagedPrivateEndpoint"
    | "deleteManagedPrivateEndpoint"
    | "waitForProvisioningSucceeded"
  >;
  checkpoint: ApplyCheckpoint;
  checkpointFile: string;
  allowManagedPrivateEndpointCreate: boolean;
  allowManagedPrivateEndpointDelete: boolean;
  now?: () => number;
}

export function preflightManagedPrivateEndpoints(options: {
  approvedPlan: DeploymentPlan;
  currentPlan: DeploymentPlan;
  checkpoint: ApplyCheckpoint;
  allowManagedPrivateEndpointCreate: boolean;
  allowManagedPrivateEndpointDelete: boolean;
}): void {
  const planned =
    options.approvedPlan.networkProtection?.managedPrivateEndpoints;
  const current =
    options.currentPlan.networkProtection?.managedPrivateEndpoints;
  const checkpointStates =
    options.checkpoint.networkProtection?.managedPrivateEndpoints;
  if (!planned) {
    if (
      checkpointStates &&
      Object.keys(checkpointStates).length > 0
    ) {
      throw new Error(
        "Checkpoint contains managed private endpoint state, but the approved plan does not configure managedPrivateEndpoints.",
      );
    }
    return;
  }
  if (!current) {
    throw new Error(
      "Current network protection plan is missing managed private endpoints. Generate a new plan.",
    );
  }
  if (
    planned.some(
      (endpoint) =>
        endpoint.action === "blocked" || endpoint.action === "unknown",
    )
  ) {
    throw new Error(
      "Managed private endpoints cannot be applied while an endpoint action is 'blocked' or 'unknown'.",
    );
  }
  assertManagedPrivateEndpointPlansNotDrifted(
    planned,
    current,
    checkpointStates,
  );
  for (const endpoint of planned) {
    const state = getCheckpointState(
      checkpointStates,
      checkpointKey(endpoint.name),
    );
    if (
      endpoint.action === "create" &&
      state?.phase !== "present-verified" &&
      !options.allowManagedPrivateEndpointCreate
    ) {
      throw new Error(
        "The approved plan requires a managed private endpoint create, but allow-managed-private-endpoint-create is false.",
      );
    }
    if (
      endpoint.action === "delete" &&
      state?.phase !== "absent-verified" &&
      !options.allowManagedPrivateEndpointDelete
    ) {
      throw new Error(
        "The approved plan requires a managed private endpoint delete, but allow-managed-private-endpoint-delete is false.",
      );
    }
  }
}

export function preflightStartedManagedPrivateEndpoints(
  options: Pick<
    ApplyManagedPrivateEndpointOptions,
    | "approvedPlan"
    | "checkpoint"
    | "allowManagedPrivateEndpointCreate"
    | "allowManagedPrivateEndpointDelete"
  >,
): void {
  const planned =
    options.approvedPlan.networkProtection?.managedPrivateEndpoints;
  const states =
    options.checkpoint.networkProtection?.managedPrivateEndpoints;
  if (!states) {
    return;
  }
  const plannedByName = new Map(
    (planned ?? []).map((endpoint) => [
      checkpointKey(endpoint.name),
      endpoint,
    ]),
  );
  for (const [key, state] of Object.entries(states)) {
    if (!isInFlight(state)) {
      continue;
    }
    const endpoint = plannedByName.get(key);
    if (!endpoint || endpoint.operationHash !== state.operationHash) {
      throw new Error(
        `Managed private endpoint checkpoint '${state.name}' does not match the approved plan.`,
      );
    }
    if (
      state.action === "create" &&
      !options.allowManagedPrivateEndpointCreate
    ) {
      throw new Error(
        "A managed private endpoint create was previously started, but allow-managed-private-endpoint-create is false.",
      );
    }
    if (
      state.action === "delete" &&
      !options.allowManagedPrivateEndpointDelete
    ) {
      throw new Error(
        "A managed private endpoint delete was previously started, but allow-managed-private-endpoint-delete is false.",
      );
    }
  }
}

export async function recoverInterruptedManagedPrivateEndpoints(
  options: ApplyManagedPrivateEndpointOptions,
): Promise<void> {
  const states =
    options.checkpoint.networkProtection?.managedPrivateEndpoints;
  const inFlight = Object.values(states ?? {})
    .filter(isInFlight)
    .sort((left, right) => compareNames(left.name, right.name));
  if (inFlight.length === 0) {
    return;
  }
  preflightStartedManagedPrivateEndpoints(options);
  const { plannedByName, desiredByName, workspaceId } =
    requireManagedPrivateEndpointContext(options);
  for (const state of inFlight) {
    const key = checkpointKey(state.name);
    const planned = plannedByName.get(key);
    const desired = desiredByName.get(key);
    if (!planned || !desired) {
      throw new Error(
        `Managed private endpoint recovery state '${state.name}' is not present in the approved plan and manifest.`,
      );
    }
    await applyManagedPrivateEndpoint(
      options,
      workspaceId,
      planned,
      desired,
      true,
    );
  }
}

export async function applyManagedPrivateEndpoints(
  options: ApplyManagedPrivateEndpointOptions,
  desiredState: "present" | "absent",
): Promise<ApplyManagedPrivateEndpointResult[] | undefined> {
  const planned =
    options.approvedPlan.networkProtection?.managedPrivateEndpoints;
  if (!planned) {
    return undefined;
  }
  const { desiredByName, workspaceId } =
    requireManagedPrivateEndpointContext(options);
  const results: ApplyManagedPrivateEndpointResult[] = [];
  for (const endpoint of planned
    .filter((entry) => entry.desiredState === desiredState)
    .sort((left, right) => compareNames(left.name, right.name))) {
    if (
      endpoint.action === "blocked" ||
      endpoint.action === "unknown"
    ) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' cannot be applied because its action is '${endpoint.action}'.`,
      );
    }
    const desired = desiredByName.get(checkpointKey(endpoint.name));
    if (!desired) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' is missing from the manifest.`,
      );
    }
    results.push(
      await applyManagedPrivateEndpoint(
        options,
        workspaceId,
        endpoint,
        desired,
        false,
      ),
    );
  }
  return results;
}

export function assertManagedPrivateEndpointDesiredConfigurationMatchesPlan(
  planned: PlannedManagedPrivateEndpoint[] | undefined,
  desired: CanonicalManagedPrivateEndpoint[] | undefined,
): void {
  if (!planned && !desired) {
    return;
  }
  if (!planned || !desired || planned.length !== desired.length) {
    throw new Error(
      "The networkProtection managedPrivateEndpoints manifest no longer matches the approved plan.",
    );
  }
  const desiredByName = new Map(
    desired.map((endpoint) => [
      checkpointKey(endpoint.name),
      endpoint,
    ]),
  );
  for (const endpoint of planned) {
    const canonical = desiredByName.get(checkpointKey(endpoint.name));
    if (
      !canonical ||
      endpoint.operationHash !==
        hashManagedPrivateEndpointOperation(canonical) ||
      endpoint.desiredIdentityHash !==
        hashManagedPrivateEndpointDesiredIdentity(canonical)
    ) {
      throw new Error(
        `The managed private endpoint '${endpoint.name}' manifest no longer matches the approved plan.`,
      );
    }
  }
}

export function managedPrivateEndpointsRequireRecovery(
  checkpoint: ApplyCheckpoint["networkProtection"],
): boolean {
  return Object.values(
    checkpoint?.managedPrivateEndpoints ?? {},
  ).some(isInFlight);
}

function requireManagedPrivateEndpointContext(
  options: ApplyManagedPrivateEndpointOptions,
): {
  plannedByName: Map<string, PlannedManagedPrivateEndpoint>;
  desiredByName: Map<string, CanonicalManagedPrivateEndpoint>;
  workspaceId: string;
} {
  const networkPlan = options.approvedPlan.networkProtection;
  const planned = networkPlan?.managedPrivateEndpoints;
  if (!planned) {
    throw new Error(
      "The approved plan does not configure managed private endpoints.",
    );
  }
  if (!networkPlan.workspaceId) {
    throw new Error(
      "Managed private endpoint apply requires a resolved network protection workspace ID.",
    );
  }
  if (!options.desired?.managedPrivateEndpoints) {
    throw new Error(
      "The managedPrivateEndpoints manifest definition is missing.",
    );
  }
  if (!options.adapter) {
    throw new Error(
      "Managed private endpoint apply requires a managed private endpoint adapter.",
    );
  }
  const desired = normalizeManagedPrivateEndpoints(
    options.desired.managedPrivateEndpoints,
  );
  assertManagedPrivateEndpointDesiredConfigurationMatchesPlan(
    planned,
    desired,
  );
  return {
    plannedByName: new Map(
      planned.map((endpoint) => [
        checkpointKey(endpoint.name),
        endpoint,
      ]),
    ),
    desiredByName: new Map(
      desired.map((endpoint) => [
        checkpointKey(endpoint.name),
        endpoint,
      ]),
    ),
    workspaceId: networkPlan.workspaceId,
  };
}

async function applyManagedPrivateEndpoint(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  desired: CanonicalManagedPrivateEndpoint,
  recoveryOnly: boolean,
): Promise<ApplyManagedPrivateEndpointResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  ensureNetworkCheckpoint(options, workspaceId, now);
  const key = checkpointKey(planned.name);
  const existing = getCheckpointState(
    options.checkpoint.networkProtection?.managedPrivateEndpoints,
    key,
  );
  if (existing) {
    assertCheckpointMatchesEndpoint(existing, planned);
  }

  if (planned.desiredState === "present") {
    return applyPresentManagedPrivateEndpoint(
      options,
      workspaceId,
      planned,
      desired,
      existing,
      recoveryOnly,
      startedAt,
      now,
    );
  }
  return applyAbsentManagedPrivateEndpoint(
    options,
    workspaceId,
    planned,
    desired,
    existing,
    recoveryOnly,
    startedAt,
    now,
  );
}

async function applyPresentManagedPrivateEndpoint(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  desired: CanonicalManagedPrivateEndpoint,
  existing: ApplyCheckpointManagedPrivateEndpoint | undefined,
  recoveryOnly: boolean,
  startedAt: number,
  now: () => number,
): Promise<ApplyManagedPrivateEndpointResult> {
  if (existing?.phase === "present-verified") {
    const outcome = await verifyAndWaitForPresent(
      options,
      workspaceId,
      planned,
      desired,
      existing.physicalId,
      existing.observedIdentityHash,
    );
    return buildPresentResult(
      planned,
      "resumed",
      outcome,
      now() - startedAt,
    );
  }
  if (existing?.phase === "create-submitting") {
    const adopted = await adoptExactlyOneLiveMatch(
      options,
      workspaceId,
      desired,
    );
    recordProvisioningState(
      options,
      planned,
      adopted,
      existing.submittedAt ?? new Date(now()).toISOString(),
      now,
    );
    const outcome = await waitForPresent(
      options,
      workspaceId,
      desired,
      adopted.id,
      hashManagedPrivateEndpointObservedIdentity(adopted),
    );
    recordPresentVerified(options, planned, outcome, now);
    return buildPresentResult(
      planned,
      "resumed",
      outcome,
      now() - startedAt,
    );
  }
  if (existing?.phase === "provisioning") {
    if (!existing.physicalId || !existing.observedIdentityHash) {
      throw new Error(
        `Managed private endpoint '${planned.name}' provisioning checkpoint is missing its physical identity proof.`,
      );
    }
    const outcome = await waitForPresent(
      options,
      workspaceId,
      desired,
      existing.physicalId,
      existing.observedIdentityHash,
    );
    recordPresentVerified(options, planned, outcome, now);
    return buildPresentResult(
      planned,
      "resumed",
      outcome,
      now() - startedAt,
    );
  }
  if (existing) {
    throw new Error(
      `Managed private endpoint '${planned.name}' checkpoint phase '${existing.phase}' is incompatible with desiredState 'present'.`,
    );
  }
  if (recoveryOnly) {
    throw new Error(
      `Managed private endpoint '${planned.name}' has not started and will not be dispatched during early recovery.`,
    );
  }

  if (planned.action === "no-op") {
    const outcome = await verifyAndWaitForPresent(
      options,
      workspaceId,
      planned,
      desired,
      planned.physicalId,
      planned.observedIdentityHash,
    );
    recordPresentVerified(options, planned, outcome, now);
    return buildPresentResult(
      planned,
      "verified",
      outcome,
      now() - startedAt,
    );
  }
  if (planned.action !== "create") {
    throw new Error(
      `Managed private endpoint '${planned.name}' has invalid present action '${planned.action}'.`,
    );
  }
  if (!options.allowManagedPrivateEndpointCreate) {
    throw new Error(
      "The approved plan requires a managed private endpoint create, but allow-managed-private-endpoint-create is false.",
    );
  }
  await assertFreshCreateStillSafe(options, workspaceId, desired);
  const submittedAt = new Date(now()).toISOString();
  let created: LiveManagedPrivateEndpoint;
  try {
    created = await options.adapter!.createManagedPrivateEndpoint(
      workspaceId,
      desired,
      {
        onDispatch: () =>
          recordCreateSubmitting(
            options,
            planned,
            submittedAt,
            now,
          ),
      },
    );
  } catch (error) {
    if (isDefinitiveRejection(error)) {
      clearManagedPrivateEndpointState(options, planned.name, now);
      throw error;
    }
    created = await adoptExactlyOneLiveMatch(
      options,
      workspaceId,
      desired,
      error,
    );
  }
  recordProvisioningState(
    options,
    planned,
    created,
    submittedAt,
    now,
  );
  const outcome = await waitForPresent(
    options,
    workspaceId,
    desired,
    created.id,
    hashManagedPrivateEndpointObservedIdentity(created),
  );
  recordPresentVerified(options, planned, outcome, now);
  return buildPresentResult(
    planned,
    "created",
    outcome,
    now() - startedAt,
  );
}

async function applyAbsentManagedPrivateEndpoint(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  desired: CanonicalManagedPrivateEndpoint,
  existing: ApplyCheckpointManagedPrivateEndpoint | undefined,
  recoveryOnly: boolean,
  startedAt: number,
  now: () => number,
): Promise<ApplyManagedPrivateEndpointResult> {
  if (existing?.phase === "absent-verified") {
    await assertNoReplacementByName(
      options,
      workspaceId,
      planned,
      existing.physicalId,
    );
    return {
      name: planned.name,
      action: planned.action,
      status: "resumed",
      ...(existing.physicalId
        ? { physicalId: existing.physicalId }
        : {}),
      ...(existing.deletedAt
        ? { deletedAt: existing.deletedAt }
        : {}),
      ...(existing.recreateNotBefore
        ? { recreateNotBefore: existing.recreateNotBefore }
        : {}),
      durationMs: now() - startedAt,
    };
  }
  if (existing?.phase === "delete-submitting") {
    if (!existing.physicalId) {
      throw new Error(
        `Managed private endpoint '${planned.name}' delete checkpoint is missing its physical ID.`,
      );
    }
    const deletion = await inspectDeletionOutcome(
      options,
      workspaceId,
      planned,
      existing.physicalId,
      true,
    );
    if (deletion === "present") {
      throw new Error(
        `Managed private endpoint '${planned.name}' remains after an ambiguous delete. The delete will not be redispatched automatically.`,
      );
    }
    const timestamps = recordAbsentVerified(
      options,
      planned,
      existing.physicalId,
      true,
      now,
    );
    return {
      name: planned.name,
      action: planned.action,
      status: "resumed",
      physicalId: existing.physicalId,
      ...timestamps,
      durationMs: now() - startedAt,
    };
  }
  if (existing) {
    throw new Error(
      `Managed private endpoint '${planned.name}' checkpoint phase '${existing.phase}' is incompatible with desiredState 'absent'.`,
    );
  }
  if (recoveryOnly) {
    throw new Error(
      `Managed private endpoint '${planned.name}' has not started and will not be dispatched during early recovery.`,
    );
  }

  if (planned.action === "no-op") {
    await assertFreshAbsentStillSafe(options, workspaceId, desired);
    recordAbsentVerified(options, planned, undefined, false, now);
    return {
      name: planned.name,
      action: planned.action,
      status: "verified",
      durationMs: now() - startedAt,
    };
  }
  if (planned.action !== "delete") {
    throw new Error(
      `Managed private endpoint '${planned.name}' has invalid absent action '${planned.action}'.`,
    );
  }
  if (!options.allowManagedPrivateEndpointDelete) {
    throw new Error(
      "The approved plan requires a managed private endpoint delete, but allow-managed-private-endpoint-delete is false.",
    );
  }
  if (!planned.physicalId || !planned.observedIdentityHash) {
    throw new Error(
      `Managed private endpoint '${planned.name}' delete plan is missing its exact physical identity proof.`,
    );
  }
  await assertFreshDeleteStillSafe(
    options,
    workspaceId,
    planned,
    desired,
  );
  const submittedAt = new Date(now()).toISOString();
  try {
    await options.adapter!.deleteManagedPrivateEndpoint(
      workspaceId,
      planned.physicalId,
      {
        onDispatch: () =>
          recordDeleteSubmitting(
            options,
            planned,
            submittedAt,
            now,
          ),
      },
    );
  } catch (error) {
    const definitiveRejection = isDefinitiveRejection(error);
    if (definitiveRejection) {
      clearManagedPrivateEndpointState(
        options,
        planned.name,
        now,
      );
    }
    const outcome = await inspectDeletionOutcome(
      options,
      workspaceId,
      planned,
      planned.physicalId,
      !definitiveRejection,
    );
    if (outcome === "absent") {
      const timestamps = recordAbsentVerified(
        options,
        planned,
        planned.physicalId,
        true,
        now,
      );
      return {
        name: planned.name,
        action: planned.action,
        status: "deleted",
        physicalId: planned.physicalId,
        ...timestamps,
        durationMs: now() - startedAt,
      };
    }
    throw error;
  }
  const outcome = await inspectDeletionOutcome(
    options,
    workspaceId,
    planned,
    planned.physicalId,
    false,
  );
  if (outcome !== "absent") {
    throw new Error(
      `Managed private endpoint '${planned.name}' delete returned success but the exact physical ID still exists.`,
    );
  }
  const timestamps = recordAbsentVerified(
    options,
    planned,
    planned.physicalId,
    true,
    now,
  );
  return {
    name: planned.name,
    action: planned.action,
    status: "deleted",
    physicalId: planned.physicalId,
    ...timestamps,
    durationMs: now() - startedAt,
  };
}

async function assertFreshCreateStillSafe(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  desired: CanonicalManagedPrivateEndpoint,
): Promise<void> {
  const live = await options.adapter!.listManagedPrivateEndpoints(
    workspaceId,
  );
  const fresh = planManagedPrivateEndpoints([desired], live)[0];
  if (!fresh || fresh.action !== "create") {
    throw new Error(
      `Managed private endpoint '${desired.name}' state drifted after approval; create will not be dispatched.`,
    );
  }
}

async function assertFreshAbsentStillSafe(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  desired: CanonicalManagedPrivateEndpoint,
): Promise<void> {
  const live = await options.adapter!.listManagedPrivateEndpoints(
    workspaceId,
  );
  const fresh = planManagedPrivateEndpoints([desired], live)[0];
  if (!fresh || fresh.action !== "no-op") {
    throw new Error(
      `Managed private endpoint '${desired.name}' state drifted after approval; absence cannot be verified.`,
    );
  }
}

async function assertFreshDeleteStillSafe(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  desired: CanonicalManagedPrivateEndpoint,
): Promise<void> {
  const live = await options.adapter!.getManagedPrivateEndpoint(
    workspaceId,
    planned.physicalId!,
  );
  if (
    !live ||
    live.name !== planned.name ||
    hashManagedPrivateEndpointObservedIdentity(live) !==
      planned.observedIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint '${planned.name}' physical identity drifted after approval; delete will not be dispatched.`,
    );
  }
  const fresh = planManagedPrivateEndpoints([desired], [live])[0];
  if (
    !fresh ||
    fresh.action !== "delete" ||
    fresh.physicalId !== planned.physicalId ||
    fresh.observedIdentityHash !== planned.observedIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint '${planned.name}' target or state drifted after approval; delete will not be dispatched.`,
    );
  }
}

async function verifyAndWaitForPresent(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  desired: CanonicalManagedPrivateEndpoint,
  physicalId: string | undefined,
  expectedObservedIdentityHash: string | undefined,
) {
  if (
    !physicalId ||
    (planned.physicalId !== undefined &&
      physicalId !== planned.physicalId) ||
    !expectedObservedIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint '${planned.name}' present plan is missing its exact physical ID.`,
    );
  }
  const live = await options.adapter!.getManagedPrivateEndpoint(
    workspaceId,
    physicalId,
  );
  if (
    !live ||
    live.name !== planned.name ||
    hashManagedPrivateEndpointObservedIdentity(live) !==
      expectedObservedIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint '${planned.name}' physical identity drifted after approval.`,
    );
  }
  return waitForPresent(
    options,
    workspaceId,
    desired,
    physicalId,
    expectedObservedIdentityHash,
  );
}

async function waitForPresent(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  desired: CanonicalManagedPrivateEndpoint,
  physicalId: string,
  expectedObservedIdentityHash?: string,
) {
  const outcome = await options.adapter!.waitForProvisioningSucceeded(
    workspaceId,
    physicalId,
    desired,
  );
  if (
    expectedObservedIdentityHash !== undefined &&
    hashManagedPrivateEndpointObservedIdentity(outcome.endpoint) !==
      expectedObservedIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint '${desired.name}' physical identity changed while provisioning.`,
    );
  }
  return outcome;
}

async function adoptExactlyOneLiveMatch(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  desired: CanonicalManagedPrivateEndpoint,
  originalError?: unknown,
): Promise<LiveManagedPrivateEndpoint> {
  let live: LiveManagedPrivateEndpoint[];
  try {
    live = await options.adapter!.listManagedPrivateEndpoints(
      workspaceId,
    );
  } catch (verificationError) {
    if (originalError !== undefined) {
      throw new AggregateError(
        [originalError, verificationError],
        `Managed private endpoint '${desired.name}' create outcome is ambiguous and exact-match discovery also failed.`,
      );
    }
    throw verificationError;
  }
  const matches = live.filter(
    (endpoint) =>
      endpoint.name === desired.name &&
      planManagedPrivateEndpoints([desired], [endpoint])[0]?.action ===
        "no-op",
  );
  const collisions = live.filter(
    (endpoint) =>
      endpoint.name.toLowerCase() === desired.name.toLowerCase(),
  );
  if (matches.length !== 1 || collisions.length !== 1) {
    const ambiguity = new Error(
      `Managed private endpoint '${desired.name}' create outcome is ambiguous. Exactly one exact live name and target identity is required for adoption; the POST will not be redispatched automatically.`,
    );
    if (originalError !== undefined) {
      throw new AggregateError([originalError, ambiguity], ambiguity.message);
    }
    throw ambiguity;
  }
  return matches[0]!;
}

async function inspectDeletionOutcome(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  physicalId: string,
  ambiguous: boolean,
): Promise<"present" | "absent"> {
  const original = await options.adapter!.getManagedPrivateEndpoint(
    workspaceId,
    physicalId,
  );
  if (original) {
    if (
      original.name !== planned.name ||
      hashManagedPrivateEndpointObservedIdentity(original) !==
        planned.observedIdentityHash
    ) {
      throw new Error(
        `Managed private endpoint '${planned.name}' physical ID now resolves to a replacement name or target identity.`,
      );
    }
    return "present";
  }
  await assertNoReplacementByName(
    options,
    workspaceId,
    planned,
    physicalId,
  );
  return "absent";
}

async function assertNoReplacementByName(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  planned: PlannedManagedPrivateEndpoint,
  deletedPhysicalId: string | undefined,
): Promise<void> {
  const live = await options.adapter!.listManagedPrivateEndpoints(
    workspaceId,
  );
  const replacements = live.filter(
    (endpoint) =>
      endpoint.name.toLowerCase() === planned.name.toLowerCase(),
  );
  if (replacements.length > 0) {
    const ids = replacements.map((endpoint) => endpoint.id);
    throw new Error(
      `Managed private endpoint '${planned.name}' was replaced or collided after deletion${
        deletedPhysicalId ? ` of physical ID '${deletedPhysicalId}'` : ""
      }; observed physical IDs: ${ids.join(", ")}.`,
    );
  }
}

function buildPresentResult(
  planned: PlannedManagedPrivateEndpoint,
  status: "created" | "verified" | "resumed",
  outcome: Awaited<
    ReturnType<
      ManagedPrivateEndpointAdapter["waitForProvisioningSucceeded"]
    >
  >,
  durationMs: number,
): ApplyManagedPrivateEndpointResult {
  return {
    name: planned.name,
    action: planned.action,
    status,
    physicalId: outcome.endpoint.id,
    provisioningState: outcome.endpoint.provisioningState,
    ...(outcome.endpoint.connectionStatus
      ? { connectionStatus: outcome.endpoint.connectionStatus }
      : {}),
    ...(outcome.approvalRequired ? { approvalRequired: true } : {}),
    durationMs,
  };
}

function recordCreateSubmitting(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  submittedAt: string,
  now: () => number,
): void {
  recordState(options, planned, {
    phase: "create-submitting",
    submittedAt,
  }, now);
}

function recordProvisioningState(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  endpoint: LiveManagedPrivateEndpoint,
  submittedAt: string,
  now: () => number,
): void {
  recordState(
    options,
    planned,
    {
      phase: "provisioning",
      physicalId: endpoint.id,
      observedIdentityHash:
        hashManagedPrivateEndpointObservedIdentity(endpoint),
      observedProvisioningState: endpoint.provisioningState,
      ...(endpoint.connectionStatus
        ? { observedConnectionStatus: endpoint.connectionStatus }
        : {}),
      submittedAt,
    },
    now,
  );
}

function recordPresentVerified(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  outcome: Awaited<
    ReturnType<
      ManagedPrivateEndpointAdapter["waitForProvisioningSucceeded"]
    >
  >,
  now: () => number,
): void {
  recordState(
    options,
    planned,
    {
      phase: "present-verified",
      physicalId: outcome.endpoint.id,
      observedIdentityHash:
        hashManagedPrivateEndpointObservedIdentity(outcome.endpoint),
      observedProvisioningState:
        outcome.endpoint.provisioningState,
      ...(outcome.endpoint.connectionStatus
        ? {
            observedConnectionStatus:
              outcome.endpoint.connectionStatus,
          }
        : {}),
      ...(outcome.approvalRequired
        ? { approvalRequired: true }
        : {}),
      verifiedAt: new Date(now()).toISOString(),
    },
    now,
  );
}

function recordDeleteSubmitting(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  submittedAt: string,
  now: () => number,
): void {
  recordState(
    options,
    planned,
    {
      phase: "delete-submitting",
      physicalId: planned.physicalId,
      observedIdentityHash: planned.observedIdentityHash,
      observedProvisioningState:
        planned.observedProvisioningState,
      ...(planned.observedConnectionStatus
        ? {
            observedConnectionStatus:
              planned.observedConnectionStatus,
          }
        : {}),
      submittedAt,
    },
    now,
  );
}

function recordAbsentVerified(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  physicalId: string | undefined,
  deleted: boolean,
  now: () => number,
): { deletedAt?: string; recreateNotBefore?: string } {
  const completed = now();
  const deletedAt = deleted
    ? new Date(completed).toISOString()
    : undefined;
  const recreateNotBefore = deleted
    ? new Date(completed + RECREATE_DELAY_MS).toISOString()
    : undefined;
  recordState(
    options,
    planned,
    {
      phase: "absent-verified",
      ...(physicalId ? { physicalId } : {}),
      ...(planned.observedIdentityHash
        ? {
            observedIdentityHash:
              planned.observedIdentityHash,
          }
        : {}),
      verifiedAt: new Date(completed).toISOString(),
      ...(deletedAt ? { deletedAt } : {}),
      ...(recreateNotBefore ? { recreateNotBefore } : {}),
    },
    () => completed,
  );
  return {
    ...(deletedAt ? { deletedAt } : {}),
    ...(recreateNotBefore ? { recreateNotBefore } : {}),
  };
}

function recordState(
  options: ApplyManagedPrivateEndpointOptions,
  planned: PlannedManagedPrivateEndpoint,
  state: Pick<
    ApplyCheckpointManagedPrivateEndpoint,
    | "phase"
    | "physicalId"
    | "observedIdentityHash"
    | "observedProvisioningState"
    | "observedConnectionStatus"
    | "approvalRequired"
    | "submittedAt"
    | "verifiedAt"
    | "deletedAt"
    | "recreateNotBefore"
  >,
  now: () => number,
): void {
  const network = options.checkpoint.networkProtection;
  if (!network?.managedPrivateEndpoints) {
    throw new Error(
      "Managed private endpoint checkpoint was not initialized.",
    );
  }
  const updatedAt = new Date(now()).toISOString();
  network.managedPrivateEndpoints[checkpointKey(planned.name)] = {
    name: planned.name,
    desiredState: planned.desiredState,
    action: planned.action as "create" | "delete" | "no-op",
    operationHash: planned.operationHash,
    desiredIdentityHash: planned.desiredIdentityHash,
    phase: state.phase,
    ...(state.physicalId ? { physicalId: state.physicalId } : {}),
    ...(state.observedIdentityHash
      ? { observedIdentityHash: state.observedIdentityHash }
      : {}),
    ...(state.observedProvisioningState
      ? {
          observedProvisioningState:
            state.observedProvisioningState,
        }
      : {}),
    ...(state.observedConnectionStatus
      ? {
          observedConnectionStatus:
            state.observedConnectionStatus,
        }
      : {}),
    ...(state.approvalRequired
      ? { approvalRequired: true }
      : {}),
    ...(state.submittedAt ? { submittedAt: state.submittedAt } : {}),
    ...(state.verifiedAt ? { verifiedAt: state.verifiedAt } : {}),
    ...(state.deletedAt ? { deletedAt: state.deletedAt } : {}),
    ...(state.recreateNotBefore
      ? { recreateNotBefore: state.recreateNotBefore }
      : {}),
    updatedAt,
  };
  network.managedPrivateEndpoints = Object.fromEntries(
    Object.entries(network.managedPrivateEndpoints).sort(
      ([left], [right]) =>
        compareCanonicalStrings(left, right),
    ),
  );
  network.updatedAt = updatedAt;
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function clearManagedPrivateEndpointState(
  options: ApplyManagedPrivateEndpointOptions,
  name: string,
  now: () => number,
): void {
  const network = options.checkpoint.networkProtection;
  if (!network?.managedPrivateEndpoints) {
    return;
  }
  delete network.managedPrivateEndpoints[checkpointKey(name)];
  network.updatedAt = new Date(now()).toISOString();
  writeCheckpoint(options.checkpointFile, options.checkpoint);
}

function ensureNetworkCheckpoint(
  options: ApplyManagedPrivateEndpointOptions,
  workspaceId: string,
  now: () => number,
): void {
  const updatedAt = new Date(now()).toISOString();
  if (!options.checkpoint.networkProtection) {
    options.checkpoint.networkProtection = {
      workspaceId,
      managedPrivateEndpoints: {},
      updatedAt,
    };
    writeCheckpoint(options.checkpointFile, options.checkpoint);
    return;
  }
  if (options.checkpoint.networkProtection.workspaceId !== workspaceId) {
    throw new Error(
      "Managed private endpoint checkpoint workspace ID does not match the approved plan.",
    );
  }
  options.checkpoint.networkProtection.managedPrivateEndpoints ??= {};
}

function assertCheckpointMatchesEndpoint(
  checkpoint: ApplyCheckpointManagedPrivateEndpoint,
  planned: PlannedManagedPrivateEndpoint,
): void {
  if (
    checkpoint.name !== planned.name ||
    checkpoint.desiredState !== planned.desiredState ||
    checkpoint.action !== planned.action ||
    checkpoint.operationHash !== planned.operationHash ||
    checkpoint.desiredIdentityHash !== planned.desiredIdentityHash
  ) {
    throw new Error(
      `Managed private endpoint checkpoint '${checkpoint.name}' does not match the approved plan.`,
    );
  }
}

function assertManagedPrivateEndpointPlansNotDrifted(
  planned: PlannedManagedPrivateEndpoint[],
  current: PlannedManagedPrivateEndpoint[],
  checkpoint:
    | Record<string, ApplyCheckpointManagedPrivateEndpoint>
    | undefined,
): void {
  const currentByName = new Map(
    current.map((endpoint) => [
      checkpointKey(endpoint.name),
      endpoint,
    ]),
  );
  if (planned.length !== current.length) {
    throw new Error(
      "Managed private endpoint plan shape drifted after approval. Generate a new plan.",
    );
  }
  for (const endpoint of planned) {
    const key = checkpointKey(endpoint.name);
    const fresh = currentByName.get(key);
    if (
      !fresh ||
      fresh.operationHash !== endpoint.operationHash ||
      fresh.desiredIdentityHash !== endpoint.desiredIdentityHash
    ) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' desired configuration drifted after approval. Generate a new plan.`,
      );
    }
    const state = getCheckpointState(checkpoint, key);
    if (!state && stableJson(fresh) !== stableJson(endpoint)) {
      throw new Error(
        `Managed private endpoint '${endpoint.name}' observed state drifted after approval. Generate a new plan.`,
      );
    }
  }
}

function isInFlight(
  state: ApplyCheckpointManagedPrivateEndpoint,
): boolean {
  return (
    state.phase === "create-submitting" ||
    state.phase === "provisioning" ||
    state.phase === "delete-submitting"
  );
}

function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    !error.priorAttemptAmbiguous
  );
}

function checkpointKey(name: string): string {
  return managedPrivateEndpointCheckpointKey(name);
}

function getCheckpointState(
  states:
    | Record<string, ApplyCheckpointManagedPrivateEndpoint>
    | undefined,
  key: string,
): ApplyCheckpointManagedPrivateEndpoint | undefined {
  return states &&
    Object.prototype.hasOwnProperty.call(states, key)
    ? states[key]
    : undefined;
}

function compareNames(left: string, right: string): number {
  return compareCanonicalStrings(left.toLowerCase(), right.toLowerCase());
}
