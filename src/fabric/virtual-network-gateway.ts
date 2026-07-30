import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  PlannedVirtualNetworkGateway,
  VirtualNetworkAzureResourceDefinition,
  VirtualNetworkGatewayDefinition,
  VirtualNetworkGatewaySleepMinutes,
} from "../types";
import {
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLEEP_MINUTES = new Set<number>([
  30, 60, 90, 120, 150, 240, 360, 480, 720, 1440,
]);

export interface VirtualNetworkGateway {
  id: string;
  type: "VirtualNetwork";
  displayName: string;
  capacityId: string;
  virtualNetworkAzureResource: VirtualNetworkAzureResourceDefinition;
  inactivityMinutesBeforeSleep: VirtualNetworkGatewaySleepMinutes;
  numberOfMemberGateways: number;
  minMemberGatewayCount?: number;
  maxMemberGatewayCount?: number;
}

interface NormalizedVirtualNetworkGatewayBase {
  logicalId: string;
  displayName: string;
  virtualNetworkAzureResource: VirtualNetworkAzureResourceDefinition;
}

export type NormalizedVirtualNetworkGatewayDefinition =
  | (NormalizedVirtualNetworkGatewayBase & {
      id?: string;
      desiredState: "present";
      capacityId: string;
      inactivityMinutesBeforeSleep: VirtualNetworkGatewaySleepMinutes;
      numberOfMemberGateways?: number;
      minMemberGatewayCount?: number;
      maxMemberGatewayCount?: number;
    })
  | (NormalizedVirtualNetworkGatewayBase & {
      id: string;
      desiredState: "absent";
      capacityId?: never;
      inactivityMinutesBeforeSleep?: never;
      numberOfMemberGateways?: never;
      minMemberGatewayCount?: never;
      maxMemberGatewayCount?: never;
    });

type NormalizedPresentVirtualNetworkGatewayDefinition = Extract<
  NormalizedVirtualNetworkGatewayDefinition,
  { desiredState: "present" }
>;

interface GatewayRecord {
  id: string;
  type: string;
  displayName?: string;
  raw: unknown;
}

export interface VirtualNetworkGatewayMutationCallbacks {
  onSubmitting?: () => void;
  onRejected?: () => void;
  onAccepted?: (physicalId: string) => void;
}

export interface VirtualNetworkGatewayRecoveryState {
  phase: "submitting" | "accepted";
  physicalId?: string;
}

export interface VirtualNetworkGatewayPlanResult {
  action: Extract<
    PlannedVirtualNetworkGateway["action"],
    "create" | "update" | "delete" | "no-op" | "blocked"
  >;
  reason: string;
  desiredHash: string;
  observedStateHash: string;
  physicalId?: string;
}

export class VirtualNetworkGatewayAdapter {
  constructor(private readonly client: FabricClient) {}

  async plan(
    definition: VirtualNetworkGatewayDefinition,
  ): Promise<VirtualNetworkGatewayPlanResult> {
    const desired = normalizeVirtualNetworkGatewayDefinition(definition);
    const discovered = await this.discover(desired);
    return this.planDiscovered(desired, discovered);
  }

  async planAll(
    definitions: VirtualNetworkGatewayDefinition[],
  ): Promise<VirtualNetworkGatewayPlanResult[]> {
    const desired = normalizeVirtualNetworkGatewayDefinitions(definitions);
    const listed = desired.some((definition) => definition.id === undefined)
      ? await this.listGatewayRecords()
      : undefined;
    const discoveries = await Promise.all(
      desired.map((definition) =>
        this.discover(definition, listed),
      ),
    );
    return desired.map((definition, index) =>
      this.planDiscovered(definition, discoveries[index]!),
    );
  }

  private planDiscovered(
    desired: NormalizedVirtualNetworkGatewayDefinition,
    discovered: {
      gateway?: VirtualNetworkGateway;
      blockedReason?: string;
      observedStateHash: string;
      physicalId?: string;
    },
  ): VirtualNetworkGatewayPlanResult {
    const desiredHash = hashDesiredVirtualNetworkGateway(desired);

    if (discovered.blockedReason) {
      return {
        action: "blocked",
        reason: discovered.blockedReason,
        desiredHash,
        observedStateHash: discovered.observedStateHash,
        ...(discovered.physicalId
          ? { physicalId: discovered.physicalId }
          : {}),
      };
    }

    const existing = discovered.gateway;
    if (desired.desiredState === "absent") {
      if (!existing) {
        return {
          action: "no-op",
          reason: `Virtual network gateway '${desired.displayName}' is already absent.`,
          desiredHash,
          observedStateHash: hashObservedVirtualNetworkGateway(undefined),
          ...(desired.id ? { physicalId: desired.id } : {}),
        };
      }
      if (!gatewayDeletionIdentityMatches(existing, desired)) {
        return {
          action: "blocked",
          reason:
            `Virtual network gateway '${desired.logicalId}' does not match the ` +
            "approved display name and virtual network placement required for deletion.",
          desiredHash,
          observedStateHash: hashObservedVirtualNetworkGateway(existing),
          physicalId: existing.id,
        };
      }
      return {
        action: "delete",
        reason: `Virtual network gateway '${desired.displayName}' is present and approved for deletion.`,
        desiredHash,
        observedStateHash: hashObservedVirtualNetworkGateway(existing),
        physicalId: existing.id,
      };
    }

    if (!existing) {
      return {
        action: "create",
        reason: `Virtual network gateway '${desired.displayName}' does not exist.`,
        desiredHash,
        observedStateHash: hashObservedVirtualNetworkGateway(undefined),
      };
    }
    if (
      !virtualNetworkResourcesEqual(
        existing.virtualNetworkAzureResource,
        desired.virtualNetworkAzureResource,
      )
    ) {
      return {
        action: "blocked",
        reason:
          `Virtual network gateway '${desired.displayName}' uses a different ` +
          "virtual network placement. Fabric does not support changing gateway placement.",
        desiredHash,
        observedStateHash: hashObservedVirtualNetworkGateway(existing),
        physicalId: existing.id,
      };
    }
    if (!gatewayMatchesDesired(existing, desired)) {
      return {
        action: "update",
        reason: `Virtual network gateway '${desired.displayName}' requires a mutable configuration update.`,
        desiredHash,
        observedStateHash: hashObservedVirtualNetworkGateway(existing),
        physicalId: existing.id,
      };
    }
    return {
      action: "no-op",
      reason: `Virtual network gateway '${desired.displayName}' matches the requested configuration.`,
      desiredHash,
      observedStateHash: hashObservedVirtualNetworkGateway(existing),
      physicalId: existing.id,
    };
  }

  async create(
    definition: VirtualNetworkGatewayDefinition,
    callbacks: VirtualNetworkGatewayMutationCallbacks = {},
  ): Promise<VirtualNetworkGateway> {
    const desired = normalizePresentDefinition(definition);
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        "/v1/gateways",
        {
          body: createRequestBody(desired),
          retryable: false,
          acceptedStatuses: [201],
          onDispatch: callbacks.onSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onRejected?.();
      }
      throw error;
    }
    const created = parseVirtualNetworkGateway(
      response.body,
      "Fabric Create Gateway response",
    );
    callbacks.onAccepted?.(created.id);
    return this.verifyPresent(desired, created.id);
  }

  async resumeCreate(
    definition: VirtualNetworkGatewayDefinition,
    recovery: VirtualNetworkGatewayRecoveryState,
    callbacks: VirtualNetworkGatewayMutationCallbacks = {},
  ): Promise<VirtualNetworkGateway> {
    const desired = normalizePresentDefinition(definition);
    assertRecoveryState(recovery, "create");
    if (recovery.phase === "accepted") {
      return this.verifyPresent(
        desired,
        requireGuid(recovery.physicalId, "accepted gateway create ID"),
      );
    }

    const matches = (await this.list()).filter(
      (gateway) =>
        namesEqual(gateway.displayName, desired.displayName) &&
        gatewayMatchesDesired(gateway, desired),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Virtual network gateway creation for '${desired.displayName}' has an ambiguous recovery state; it will not be redispatched.`,
      );
    }
    const [match] = matches;
    if (!match) {
      throw new Error("Gateway create recovery returned no match.");
    }
    callbacks.onAccepted?.(match.id);
    return this.verifyPresent(desired, match.id);
  }

  async update(
    gatewayId: string,
    definition: VirtualNetworkGatewayDefinition,
    callbacks: VirtualNetworkGatewayMutationCallbacks = {},
  ): Promise<VirtualNetworkGateway> {
    const desired = normalizePresentDefinition(definition);
    assertGuid(gatewayId, "gateway ID");
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "PATCH",
        gatewayPath(gatewayId),
        {
          body: updateRequestBody(desired),
          retryable: false,
          acceptedStatuses: [200],
          onDispatch: callbacks.onSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onRejected?.();
      }
      throw error;
    }
    const updated = parseVirtualNetworkGateway(
      response.body,
      "Fabric Update Gateway response",
    );
    if (!idsEqual(updated.id, gatewayId)) {
      throw new Error(
        `Fabric Update Gateway returned ID '${updated.id}', expected '${gatewayId}'.`,
      );
    }
    callbacks.onAccepted?.(updated.id);
    return this.verifyPresent(desired, gatewayId);
  }

  async resumeUpdate(
    gatewayId: string,
    definition: VirtualNetworkGatewayDefinition,
    recovery: VirtualNetworkGatewayRecoveryState,
  ): Promise<VirtualNetworkGateway> {
    assertRecoveryState(recovery, "update");
    const recoveredId =
      recovery.physicalId === undefined
        ? gatewayId
        : requireGuid(recovery.physicalId, "gateway update recovery ID");
    if (!idsEqual(gatewayId, recoveredId)) {
      throw new Error(
        "Virtual network gateway update recovery ID does not match the approved gateway.",
      );
    }
    const desired = normalizePresentDefinition(definition);
    const current = await this.readGateway(gatewayId);
    if (!current || current.type !== "VirtualNetwork") {
      throw new Error(
        `Virtual network gateway update for '${gatewayId}' has an ambiguous recovery state; it will not be redispatched.`,
      );
    }
    const gateway = parseVirtualNetworkGateway(
      current.raw,
      "Fabric Get Gateway response",
    );
    if (!gatewayMatchesDesired(gateway, desired)) {
      throw new Error(
        `Virtual network gateway update for '${gatewayId}' has an ambiguous recovery state; it will not be redispatched.`,
      );
    }
    return gateway;
  }

  async delete(
    gatewayId: string,
    definition: VirtualNetworkGatewayDefinition,
    callbacks: VirtualNetworkGatewayMutationCallbacks = {},
  ): Promise<void> {
    const desired = normalizeVirtualNetworkGatewayDefinition(definition);
    assertGuid(gatewayId, "gateway ID");
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "DELETE",
        gatewayPath(gatewayId),
        {
          retryable: false,
          acceptedStatuses: [200, 404],
          onDispatch: callbacks.onSubmitting,
        },
      );
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        callbacks.onRejected?.();
      }
      throw error;
    }
    callbacks.onAccepted?.(gatewayId);
    if (response.status !== 404) {
      await this.verifyAbsent(desired, gatewayId);
    }
  }

  async resumeDelete(
    gatewayId: string,
    definition: VirtualNetworkGatewayDefinition,
    recovery: VirtualNetworkGatewayRecoveryState,
  ): Promise<void> {
    assertRecoveryState(recovery, "delete");
    const recoveredId =
      recovery.physicalId === undefined
        ? gatewayId
        : requireGuid(recovery.physicalId, "gateway delete recovery ID");
    if (!idsEqual(gatewayId, recoveredId)) {
      throw new Error(
        "Virtual network gateway delete recovery ID does not match the approved gateway.",
      );
    }
    const current = await this.readGateway(gatewayId);
    if (current !== undefined) {
      throw new Error(
        `Virtual network gateway deletion for '${gatewayId}' has an ambiguous recovery state; it will not be redispatched.`,
      );
    }
    await this.verifyAbsent(definition, gatewayId);
  }

  async verifyPresent(
    definition: VirtualNetworkGatewayDefinition,
    gatewayId: string,
  ): Promise<VirtualNetworkGateway> {
    const desired = normalizePresentDefinition(definition);
    const current = await this.readGateway(gatewayId);
    if (!current) {
      throw new Error(
        `Virtual network gateway verification failed: gateway '${gatewayId}' was not found.`,
      );
    }
    if (current.type !== "VirtualNetwork") {
      throw new Error(
        `Virtual network gateway verification failed: gateway '${gatewayId}' has type '${current.type}'.`,
      );
    }
    const gateway = parseVirtualNetworkGateway(
      current.raw,
      "Fabric Get Gateway response",
    );
    if (!gatewayMatchesDesired(gateway, desired)) {
      throw new Error(
        `Virtual network gateway verification failed for '${gatewayId}': the canonical read-back does not match the approved configuration.`,
      );
    }
    return gateway;
  }

  async verifyAbsent(
    definition: VirtualNetworkGatewayDefinition,
    gatewayId?: string,
  ): Promise<void> {
    const desired = normalizeVirtualNetworkGatewayDefinition(definition);
    if (gatewayId ?? desired.id) {
      const current = await this.readGateway(
        requireGuid(gatewayId ?? desired.id, "gateway absence verification ID"),
      );
      if (current !== undefined) {
        throw new Error(
          `Virtual network gateway absence verification failed: gateway '${current.id}' still exists.`,
        );
      }
      return;
    }
    const matches = (await this.list()).filter((gateway) =>
      namesEqual(gateway.displayName, desired.displayName),
    );
    if (matches.length > 0) {
      throw new Error(
        `Virtual network gateway absence verification failed: '${desired.displayName}' still exists.`,
      );
    }
  }

  async list(): Promise<VirtualNetworkGateway[]> {
    const records = await this.listGatewayRecords();
    return records.flatMap((record, index) =>
      record.type === "VirtualNetwork"
        ? [
            parseVirtualNetworkGateway(
              record.raw,
              `Fabric gateway at index ${index}`,
            ),
          ]
        : [],
    );
  }

  private async listGatewayRecords(): Promise<GatewayRecord[]> {
    const records = await this.client.listAll<unknown>("/v1/gateways");
    return records.map((record, index) =>
      parseGatewayRecord(
        record,
        `Fabric gateway at index ${index}`,
      ),
    );
  }

  private async discover(
    desired: NormalizedVirtualNetworkGatewayDefinition,
    listed?: GatewayRecord[],
  ): Promise<{
    gateway?: VirtualNetworkGateway;
    blockedReason?: string;
    observedStateHash: string;
    physicalId?: string;
  }> {
    if (desired.id) {
      const record = await this.readGateway(desired.id);
      if (!record) {
        return desired.desiredState === "absent"
          ? {
              observedStateHash:
                hashObservedVirtualNetworkGateway(undefined),
              physicalId: desired.id,
            }
          : {
              blockedReason:
                `Explicit virtual network gateway ID '${desired.id}' was not found; ` +
                "the adapter will not recreate it by name.",
              observedStateHash:
                hashObservedVirtualNetworkGateway(undefined),
              physicalId: desired.id,
            };
      }
      if (record.type !== "VirtualNetwork") {
        return {
          blockedReason:
            `Gateway '${desired.id}' has type '${record.type}', not VirtualNetwork.`,
          observedStateHash: sha256(stableJson(record.raw)),
          physicalId: record.id,
        };
      }
      const gateway = parseVirtualNetworkGateway(
        record.raw,
        "Fabric Get Gateway response",
      );
      return {
        gateway,
        observedStateHash: hashObservedVirtualNetworkGateway(gateway),
        physicalId: gateway.id,
      };
    }

    const matches = (
      listed ?? (await this.listGatewayRecords())
    ).filter(
      (gateway) =>
        gateway.displayName !== undefined &&
        namesEqual(gateway.displayName, desired.displayName),
    );
    if (matches.length > 1) {
      return {
        blockedReason: `Multiple virtual network gateways match display name '${desired.displayName}'.`,
        observedStateHash: sha256(
          stableJson(
            matches
              .map((gateway) => ({
                id: gateway.id,
                type: gateway.type,
                displayName: gateway.displayName,
              }))
              .sort((left, right) =>
                compareCanonicalStrings(left.id, right.id),
              ),
          ),
        ),
      };
    }
    const [record] = matches;
    if (record && record.type !== "VirtualNetwork") {
      return {
        blockedReason:
          `Gateway '${record.displayName}' already exists with type ` +
          `'${record.type}', not VirtualNetwork.`,
        observedStateHash: sha256(stableJson(record.raw)),
        physicalId: record.id,
      };
    }
    const gateway = record
      ? parseVirtualNetworkGateway(
          record.raw,
          "Fabric gateway list response",
        )
      : undefined;
    return {
      ...(gateway ? { gateway, physicalId: gateway.id } : {}),
      observedStateHash: hashObservedVirtualNetworkGateway(gateway),
    };
  }

  private async readGateway(
    gatewayId: string,
  ): Promise<GatewayRecord | undefined> {
    assertGuid(gatewayId, "gateway ID");
    const response = await this.client.request<unknown>(
      "GET",
      gatewayPath(gatewayId),
      { acceptedStatuses: [200, 404] },
    );
    return response.status === 404
      ? undefined
      : parseGatewayRecord(response.body, "Fabric Get Gateway response");
  }
}

export function normalizeVirtualNetworkGatewayDefinitions(
  definitions: VirtualNetworkGatewayDefinition[] | undefined,
): NormalizedVirtualNetworkGatewayDefinition[] {
  if (definitions === undefined) {
    return [];
  }
  if (!Array.isArray(definitions)) {
    throw new Error("virtualNetworkGateways must be an array.");
  }
  const normalized = definitions.map(
    normalizeVirtualNetworkGatewayDefinition,
  );
  const logicalIds = new Set<string>();
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const definition of normalized) {
    const logicalId = definition.logicalId.toLocaleLowerCase("en-US");
    const name = definition.displayName.toLocaleLowerCase("en-US");
    if (logicalIds.has(logicalId)) {
      throw new Error(
        `Virtual network gateways contain duplicate logicalId '${definition.logicalId}'.`,
      );
    }
    if (names.has(name)) {
      throw new Error(
        `Virtual network gateways contain duplicate displayName '${definition.displayName}'.`,
      );
    }
    logicalIds.add(logicalId);
    names.add(name);
    if (definition.id) {
      if (ids.has(definition.id)) {
        throw new Error(
          `Virtual network gateways contain duplicate ID '${definition.id}'.`,
        );
      }
      ids.add(definition.id);
    }
  }
  return normalized.sort((left, right) =>
    compareCanonicalStrings(left.logicalId, right.logicalId),
  );
}

export function normalizeVirtualNetworkGatewayDefinition(
  definition: VirtualNetworkGatewayDefinition,
): NormalizedVirtualNetworkGatewayDefinition {
  if (!isRecord(definition)) {
    throw new Error("Virtual network gateway definition must be an object.");
  }
  const logicalId = requireNonBlank(definition.logicalId, "gateway logicalId");
  const displayName = requireNonBlank(
    definition.displayName,
    `virtual network gateway '${logicalId}' displayName`,
  );
  if (displayName.length > 200) {
    throw new Error(
      `Virtual network gateway '${logicalId}' displayName exceeds 200 characters.`,
    );
  }
  const virtualNetworkAzureResource = normalizeVirtualNetworkResource(
    definition.virtualNetworkAzureResource,
    logicalId,
  );
  const desiredState = definition.desiredState ?? "present";
  const id =
    definition.id === undefined
      ? undefined
      : canonicalGuid(
          definition.id,
          `virtual network gateway '${logicalId}' id`,
        );
  if (desiredState === "absent") {
    if (!id) {
      throw new Error(
        `Virtual network gateway '${logicalId}' requires id when desiredState is absent.`,
      );
    }
    return {
      logicalId,
      id,
      desiredState,
      displayName,
      virtualNetworkAzureResource,
    };
  }
  const capacityId = canonicalGuid(
    definition.capacityId,
    `virtual network gateway '${logicalId}' capacityId`,
  );
  const inactivityMinutesBeforeSleep =
    definition.inactivityMinutesBeforeSleep;
  if (
    inactivityMinutesBeforeSleep === undefined ||
    !SLEEP_MINUTES.has(inactivityMinutesBeforeSleep)
  ) {
    throw new Error(
      `Virtual network gateway '${logicalId}' inactivityMinutesBeforeSleep is unsupported.`,
    );
  }
  const fixed = definition.numberOfMemberGateways;
  const min = definition.minMemberGatewayCount;
  const max = definition.maxMemberGatewayCount;
  if (fixed !== undefined) {
    assertMemberCount(fixed, "numberOfMemberGateways", logicalId);
    if (min !== undefined || max !== undefined) {
      throw new Error(
        `Virtual network gateway '${logicalId}' cannot combine fixed and range member counts.`,
      );
    }
  } else {
    if (min === undefined || max === undefined) {
      throw new Error(
        `Virtual network gateway '${logicalId}' must define numberOfMemberGateways or both minMemberGatewayCount and maxMemberGatewayCount.`,
      );
    }
    assertMemberCount(min, "minMemberGatewayCount", logicalId);
    assertMemberCount(max, "maxMemberGatewayCount", logicalId);
    if (min > max) {
      throw new Error(
        `Virtual network gateway '${logicalId}' minMemberGatewayCount cannot exceed maxMemberGatewayCount.`,
      );
    }
  }
  return {
    logicalId,
    ...(id ? { id } : {}),
    desiredState,
    displayName,
    capacityId,
    virtualNetworkAzureResource,
    inactivityMinutesBeforeSleep:
      inactivityMinutesBeforeSleep as VirtualNetworkGatewaySleepMinutes,
    ...(fixed === undefined
      ? {
          minMemberGatewayCount: min!,
          maxMemberGatewayCount: max!,
        }
      : { numberOfMemberGateways: fixed }),
  };
}

export function hashDesiredVirtualNetworkGateway(
  definition: VirtualNetworkGatewayDefinition,
): string {
  return sha256(
    stableJson(normalizeVirtualNetworkGatewayDefinition(definition)),
  );
}

export function hashObservedVirtualNetworkGateway(
  gateway: VirtualNetworkGateway | undefined,
): string {
  return sha256(
    stableJson(
      gateway === undefined
        ? null
        : observedVirtualNetworkGateway(gateway),
    ),
  );
}

function normalizePresentDefinition(
  definition: VirtualNetworkGatewayDefinition,
): NormalizedPresentVirtualNetworkGatewayDefinition {
  const normalized = normalizeVirtualNetworkGatewayDefinition(definition);
  if (normalized.desiredState !== "present") {
    throw new Error(
      `Virtual network gateway '${normalized.logicalId}' must have desiredState present for this operation.`,
    );
  }
  return {
    ...normalized,
    desiredState: "present",
  };
}

function normalizeVirtualNetworkResource(
  value: VirtualNetworkAzureResourceDefinition,
  logicalId: string,
): VirtualNetworkAzureResourceDefinition {
  if (!isRecord(value)) {
    throw new Error(
      `Virtual network gateway '${logicalId}' virtualNetworkAzureResource must be an object.`,
    );
  }
  return {
    subscriptionId: canonicalGuid(
      value.subscriptionId,
      `virtual network gateway '${logicalId}' subscriptionId`,
    ),
    resourceGroupName: requireNonBlank(
      value.resourceGroupName,
      `virtual network gateway '${logicalId}' resourceGroupName`,
    ),
    virtualNetworkName: requireNonBlank(
      value.virtualNetworkName,
      `virtual network gateway '${logicalId}' virtualNetworkName`,
    ),
    subnetName: requireNonBlank(
      value.subnetName,
      `virtual network gateway '${logicalId}' subnetName`,
    ),
  };
}

function createRequestBody(
  desired: ReturnType<typeof normalizePresentDefinition>,
) {
  return {
    type: "VirtualNetwork",
    displayName: desired.displayName,
    capacityId: desired.capacityId,
    virtualNetworkAzureResource:
      desired.virtualNetworkAzureResource,
    inactivityMinutesBeforeSleep:
      desired.inactivityMinutesBeforeSleep,
    ...scalingRequestBody(desired),
  };
}

function updateRequestBody(
  desired: ReturnType<typeof normalizePresentDefinition>,
) {
  return {
    type: "VirtualNetwork",
    displayName: desired.displayName,
    capacityId: desired.capacityId,
    inactivityMinutesBeforeSleep:
      desired.inactivityMinutesBeforeSleep,
    ...scalingRequestBody(desired),
  };
}

function scalingRequestBody(
  desired: NormalizedPresentVirtualNetworkGatewayDefinition,
) {
  return desired.numberOfMemberGateways === undefined
    ? {
        minMemberGatewayCount: desired.minMemberGatewayCount,
        maxMemberGatewayCount: desired.maxMemberGatewayCount,
      }
    : { numberOfMemberGateways: desired.numberOfMemberGateways };
}

function gatewayMatchesDesired(
  gateway: VirtualNetworkGateway,
  desired: NormalizedPresentVirtualNetworkGatewayDefinition,
): boolean {
  const scalingMatches =
    desired.numberOfMemberGateways === undefined
      ? gateway.minMemberGatewayCount ===
          desired.minMemberGatewayCount &&
        gateway.maxMemberGatewayCount ===
          desired.maxMemberGatewayCount
      : gateway.minMemberGatewayCount === undefined &&
        gateway.maxMemberGatewayCount === undefined &&
        gateway.numberOfMemberGateways ===
          desired.numberOfMemberGateways;
  return (
    gateway.displayName === desired.displayName &&
    idsEqual(gateway.capacityId, desired.capacityId) &&
    virtualNetworkResourcesEqual(
      gateway.virtualNetworkAzureResource,
      desired.virtualNetworkAzureResource,
    ) &&
    gateway.inactivityMinutesBeforeSleep ===
      desired.inactivityMinutesBeforeSleep &&
    scalingMatches
  );
}

function gatewayDeletionIdentityMatches(
  gateway: VirtualNetworkGateway,
  desired: NormalizedVirtualNetworkGatewayDefinition,
): boolean {
  return (
    gateway.displayName === desired.displayName &&
    virtualNetworkResourcesEqual(
      gateway.virtualNetworkAzureResource,
      desired.virtualNetworkAzureResource,
    )
  );
}

function virtualNetworkResourcesEqual(
  left: VirtualNetworkAzureResourceDefinition,
  right: VirtualNetworkAzureResourceDefinition,
): boolean {
  return (
    idsEqual(left.subscriptionId, right.subscriptionId) &&
    namesEqual(left.resourceGroupName, right.resourceGroupName) &&
    namesEqual(left.virtualNetworkName, right.virtualNetworkName) &&
    namesEqual(left.subnetName, right.subnetName)
  );
}

function observedVirtualNetworkGateway(
  gateway: VirtualNetworkGateway,
) {
  const scaling =
    gateway.minMemberGatewayCount !== undefined &&
    gateway.maxMemberGatewayCount !== undefined
      ? {
          minMemberGatewayCount:
            gateway.minMemberGatewayCount,
          maxMemberGatewayCount:
            gateway.maxMemberGatewayCount,
        }
      : {
          numberOfMemberGateways:
            gateway.numberOfMemberGateways,
        };
  return {
    id: canonicalGuid(gateway.id, "observed gateway ID"),
    type: gateway.type,
    displayName: gateway.displayName,
    capacityId: canonicalGuid(
      gateway.capacityId,
      "observed gateway capacity ID",
    ),
    virtualNetworkAzureResource: {
      subscriptionId: canonicalGuid(
        gateway.virtualNetworkAzureResource.subscriptionId,
        "observed gateway subscription ID",
      ),
      resourceGroupName:
        gateway.virtualNetworkAzureResource.resourceGroupName.toLocaleLowerCase(
          "en-US",
        ),
      virtualNetworkName:
        gateway.virtualNetworkAzureResource.virtualNetworkName.toLocaleLowerCase(
          "en-US",
        ),
      subnetName:
        gateway.virtualNetworkAzureResource.subnetName.toLocaleLowerCase(
          "en-US",
        ),
    },
    inactivityMinutesBeforeSleep:
      gateway.inactivityMinutesBeforeSleep,
    ...scaling,
  };
}

function parseGatewayRecord(
  value: unknown,
  label: string,
): GatewayRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} is empty or malformed.`);
  }
  const id = canonicalGuid(value.id, `${label} id`);
  if (typeof value.type !== "string" || value.type.trim() === "") {
    throw new Error(`${label} type must be a nonblank string.`);
  }
  if (
    value.displayName !== undefined &&
    typeof value.displayName !== "string"
  ) {
    throw new Error(`${label} displayName must be a string.`);
  }
  return {
    id,
    type: value.type,
    ...(value.displayName === undefined
      ? {}
      : { displayName: value.displayName }),
    raw: value,
  };
}

function parseVirtualNetworkGateway(
  value: unknown,
  label: string,
): VirtualNetworkGateway {
  const record = parseGatewayRecord(value, label);
  if (record.type !== "VirtualNetwork") {
    throw new Error(
      `${label} has type '${record.type}', expected VirtualNetwork.`,
    );
  }
  if (!isRecord(value)) {
    throw new Error(`${label} is empty or malformed.`);
  }
  const displayName = requireNonBlank(
    value.displayName,
    `${label} displayName`,
  );
  const capacityId = canonicalGuid(
    value.capacityId,
    `${label} capacityId`,
  );
  const virtualNetworkAzureResource =
    normalizeVirtualNetworkResource(
      value.virtualNetworkAzureResource as VirtualNetworkAzureResourceDefinition,
      label,
    );
  const inactivityMinutesBeforeSleep =
    value.inactivityMinutesBeforeSleep;
  if (
    typeof inactivityMinutesBeforeSleep !== "number" ||
    !SLEEP_MINUTES.has(inactivityMinutesBeforeSleep)
  ) {
    throw new Error(
      `${label} inactivityMinutesBeforeSleep is unsupported.`,
    );
  }
  const numberOfMemberGateways = value.numberOfMemberGateways;
  if (
    typeof numberOfMemberGateways !== "number" ||
    !Number.isInteger(numberOfMemberGateways) ||
    numberOfMemberGateways < 1 ||
    numberOfMemberGateways > 9
  ) {
    throw new Error(
      `${label} numberOfMemberGateways must be an integer between 1 and 9.`,
    );
  }
  const minMemberGatewayCount = optionalMemberCount(
    value.minMemberGatewayCount,
    `${label} minMemberGatewayCount`,
  );
  const maxMemberGatewayCount = optionalMemberCount(
    value.maxMemberGatewayCount,
    `${label} maxMemberGatewayCount`,
  );
  return {
    id: record.id,
    type: "VirtualNetwork",
    displayName,
    capacityId,
    virtualNetworkAzureResource,
    inactivityMinutesBeforeSleep:
      inactivityMinutesBeforeSleep as VirtualNetworkGatewaySleepMinutes,
    numberOfMemberGateways,
    ...(minMemberGatewayCount === undefined
      ? {}
      : { minMemberGatewayCount }),
    ...(maxMemberGatewayCount === undefined
      ? {}
      : { maxMemberGatewayCount }),
  };
}

function optionalMemberCount(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 9
  ) {
    throw new Error(`${label} must be an integer between 1 and 9.`);
  }
  return value;
}

function assertRecoveryState(
  recovery: VirtualNetworkGatewayRecoveryState,
  operation: string,
): void {
  if (
    !isRecord(recovery) ||
    (recovery.phase !== "submitting" &&
      recovery.phase !== "accepted")
  ) {
    throw new Error(
      `Virtual network gateway ${operation} recovery state is invalid.`,
    );
  }
  if (
    recovery.phase === "accepted" &&
    recovery.physicalId === undefined
  ) {
    throw new Error(
      `Accepted virtual network gateway ${operation} recovery requires a physical ID.`,
    );
  }
}

function assertMemberCount(
  value: number,
  property: string,
  logicalId: string,
): void {
  if (!Number.isInteger(value) || value < 1 || value > 9) {
    throw new Error(
      `Virtual network gateway '${logicalId}' ${property} must be an integer between 1 and 9.`,
    );
  }
}

function gatewayPath(gatewayId: string): string {
  return `/v1/gateways/${encodeURIComponent(gatewayId)}`;
}

function namesEqual(left: string, right: string): boolean {
  return (
    left.toLocaleLowerCase("en-US") ===
    right.toLocaleLowerCase("en-US")
  );
}

function idsEqual(left: string, right: string): boolean {
  return namesEqual(left, right);
}

function canonicalGuid(value: unknown, label: string): string {
  const id = requireNonBlank(value, label);
  if (!GUID_PATTERN.test(id)) {
    throw new Error(`${label} must be a GUID.`);
  }
  return id.toLocaleLowerCase("en-US");
}

function assertGuid(value: unknown, label: string): asserts value is string {
  canonicalGuid(value, label);
}

function requireGuid(
  value: string | undefined,
  label: string,
): string {
  return canonicalGuid(value, label);
}

function requireNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonblank string.`);
  }
  return value.trim();
}

function isDefinitiveRejection(error: unknown): boolean {
  return (
    error instanceof FabricApiError &&
    !error.priorAttemptAmbiguous
  );
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}
