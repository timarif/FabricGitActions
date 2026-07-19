import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  DesiredState,
  ManagedPrivateEndpointManifest,
  NetworkProtectionManifest,
  PlannedManagedPrivateEndpoint,
} from "../types";
import {
  DEFAULT_FABRIC_OPERATION_POLL_INTERVAL_MS,
  DEFAULT_FABRIC_OPERATION_TIMEOUT_MS,
  FabricApiError,
  FabricClient,
  type FabricResponse,
} from "./client";

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MANAGED_PRIVATE_ENDPOINT_KEYS = new Set([
  "name",
  "desiredState",
  "targetPrivateLinkResourceId",
  "targetSubresourceType",
  "requestMessage",
]);
const CHECKPOINT_KEY_PREFIX = "mpe:";

export interface CanonicalManagedPrivateEndpoint {
  name: string;
  desiredState: DesiredState;
  targetPrivateLinkResourceId: string;
  targetSubresourceType?: string;
  requestMessage?: string;
}

export interface LiveManagedPrivateEndpoint {
  id: string;
  name: string;
  targetPrivateLinkResourceId: string;
  targetSubresourceType?: string;
  provisioningState: string;
  connectionStatus?: string;
}

export interface ManagedPrivateEndpointProvisioningOutcome {
  endpoint: LiveManagedPrivateEndpoint;
  approvalRequired: boolean;
}

export interface ManagedPrivateEndpointAdapterOptions {
  operationTimeoutMs?: number;
  operationPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export function managedPrivateEndpointCheckpointKey(
  name: string,
): string {
  return `${CHECKPOINT_KEY_PREFIX}${name.toLowerCase()}`;
}

export function managedPrivateEndpointRequestMessages(
  desired: NetworkProtectionManifest | undefined,
): string[] {
  return (desired?.managedPrivateEndpoints ?? [])
    .map((endpoint) => endpoint.requestMessage)
    .filter((message): message is string => typeof message === "string");
}

export function redactManagedPrivateEndpointRequestMessages(
  value: string,
  requestMessages: readonly string[],
): string {
  const sensitiveVariants = new Set<string>();
  for (const requestMessage of requestMessages) {
    if (requestMessage.length === 0) {
      continue;
    }
    sensitiveVariants.add(requestMessage);
    sensitiveVariants.add(
      JSON.stringify(requestMessage).slice(1, -1),
    );
    try {
      sensitiveVariants.add(encodeURIComponent(requestMessage));
    } catch {
      // Lone UTF-16 surrogates cannot be URI encoded. The raw and
      // JSON-escaped variants still remain protected.
    }
  }
  const variants = [...sensitiveVariants].sort(
    (left, right) => right.length - left.length,
  );
  if (variants.length === 0) {
    return value;
  }
  const marker = redactionMarker(variants);
  let cursor = 0;
  let redacted = "";
  while (cursor < value.length) {
    let matchIndex = -1;
    let matchLength = 0;
    for (const variant of variants) {
      const candidate = value.indexOf(variant, cursor);
      if (
        candidate !== -1 &&
        (matchIndex === -1 ||
          candidate < matchIndex ||
          (candidate === matchIndex &&
            variant.length > matchLength))
      ) {
        matchIndex = candidate;
        matchLength = variant.length;
      }
    }
    if (matchIndex === -1) {
      redacted += value.slice(cursor);
      break;
    }
    redacted += value.slice(cursor, matchIndex);
    redacted += marker;
    cursor = matchIndex + matchLength;
  }
  return redacted;
}

function redactionMarker(sensitiveVariants: readonly string[]): string {
  const preferredCodePoints = [
    0x2588, 0x2593, 0x2592, 0x2591, 0x25a0, 0x25cf, 0x25c6,
  ];
  for (const codePoint of preferredCodePoints) {
    const candidate = String.fromCodePoint(codePoint);
    if (
      sensitiveVariants.every(
        (variant) => !variant.includes(candidate),
      )
    ) {
      return candidate.repeat(8);
    }
  }
  for (let codePoint = 0xe000; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (
      sensitiveVariants.every(
        (variant) => !variant.includes(candidate),
      )
    ) {
      return candidate.repeat(8);
    }
  }
  return "";
}

export function redactManagedPrivateEndpointError(
  error: unknown,
  requestMessages: readonly string[],
): unknown {
  const seen = new Set<Error>();
  const redactUnknown = (current: unknown): unknown => {
    if (typeof current === "string") {
      return redactManagedPrivateEndpointRequestMessages(
        current,
        requestMessages,
      );
    }
    if (!(current instanceof Error)) {
      try {
        return redactManagedPrivateEndpointRequestMessages(
          String(current),
          requestMessages,
        );
      } catch {
        return "Unknown redacted error";
      }
    }
    if (seen.has(current)) {
      return new Error("Cyclic redacted error");
    }
    seen.add(current);
    let message = "Unknown error";
    try {
      message = redactManagedPrivateEndpointRequestMessages(
        current.message,
        requestMessages,
      );
    } catch {
      // Use the fixed fallback for exotic Error implementations.
    }
    let cause: unknown;
    try {
      cause =
        current.cause === undefined
          ? undefined
          : redactUnknown(current.cause);
    } catch {
      cause = "Unknown redacted cause";
    }
    let redacted: Error;
    if (current instanceof FabricApiError) {
      redacted = new FabricApiError(
        message,
        current.status,
        current.code,
        current.requestId,
        current.priorAttemptAmbiguous,
      );
    } else if (current instanceof AggregateError) {
      let nested: unknown[] = [];
      try {
        nested = Array.from(current.errors, (entry) =>
          redactUnknown(entry),
        );
      } catch {
        nested = [new Error("Unknown redacted nested error")];
      }
      redacted = new AggregateError(
        nested,
        message,
        cause === undefined ? undefined : { cause },
      );
    } else {
      redacted = new Error(
        message,
        cause === undefined ? undefined : { cause },
      );
      try {
        redacted.name = current.name;
      } catch {
        // The default Error name is safe if the original name is unreadable.
      }
    }
    try {
      if (typeof current.stack === "string") {
        redacted.stack =
          redactManagedPrivateEndpointRequestMessages(
            current.stack,
            requestMessages,
          );
      }
    } catch {
      // The newly constructed redacted stack remains safe.
    }
    return redacted;
  };
  return redactUnknown(error);
}

interface ManagedPrivateEndpointPage {
  value?: unknown;
  continuationToken?: unknown;
  continuationUri?: unknown;
}

export function normalizeManagedPrivateEndpoints(
  value: unknown,
  context = "networkProtection.managedPrivateEndpoints",
): CanonicalManagedPrivateEndpoint[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array.`);
  }
  const seenNames = new Set<string>();
  const endpoints = value.map((entry, index) => {
    const entryContext = `${context}[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${entryContext} must be an object.`);
    }
    assertOnlyKeys(entry, MANAGED_PRIVATE_ENDPOINT_KEYS, entryContext);
    const name = assertUnpaddedString(entry.name, `${entryContext}.name`);
    if (name.length > 64) {
      throw new Error(`${entryContext}.name must not exceed 64 characters.`);
    }
    const canonicalName = name.toLowerCase();
    if (seenNames.has(canonicalName)) {
      throw new Error(
        `${context} declares a case-insensitive name collision for '${name}'.`,
      );
    }
    seenNames.add(canonicalName);

    const desiredState = assertDesiredState(
      entry.desiredState,
      `${entryContext}.desiredState`,
    );
    const targetPrivateLinkResourceId = canonicalizeArmResourceId(
      entry.targetPrivateLinkResourceId,
      `${entryContext}.targetPrivateLinkResourceId`,
    );
    const targetSubresourceType =
      entry.targetSubresourceType === undefined
        ? undefined
        : assertUnpaddedString(
            entry.targetSubresourceType,
            `${entryContext}.targetSubresourceType`,
          );

    let requestMessage: string | undefined;
    if (desiredState === "present") {
      requestMessage = assertUnpaddedString(
        entry.requestMessage,
        `${entryContext}.requestMessage`,
      );
      if (requestMessage.length > 140) {
        throw new Error(
          `${entryContext}.requestMessage must not exceed 140 characters.`,
        );
      }
    } else if (entry.requestMessage !== undefined) {
      throw new Error(
        `${entryContext}.requestMessage is forbidden when desiredState is 'absent'.`,
      );
    }

    return {
      name,
      desiredState,
      targetPrivateLinkResourceId,
      ...(targetSubresourceType ? { targetSubresourceType } : {}),
      ...(requestMessage ? { requestMessage } : {}),
    };
  });
  endpoints.sort(compareManagedPrivateEndpointNames);
  return endpoints;
}

export function canonicalizeArmResourceId(
  value: unknown,
  context: string,
): string {
  const resourceId = assertUnpaddedString(value, context);
  if (!resourceId.startsWith("/") || resourceId.includes("?") || resourceId.includes("#")) {
    throw new Error(`${context} must be an absolute ARM resource ID.`);
  }
  const segments = resourceId.slice(1).split("/");
  if (
    segments.length < 8 ||
    (segments.length - 6) % 2 !== 0 ||
    segments.some((segment) => segment.length === 0) ||
    segments[0]?.toLowerCase() !== "subscriptions" ||
    !GUID_PATTERN.test(segments[1] ?? "") ||
    segments[2]?.toLowerCase() !== "resourcegroups" ||
    segments[4]?.toLowerCase() !== "providers"
  ) {
    throw new Error(`${context} must be a valid subscription-scoped ARM resource ID.`);
  }
  return `/${segments.map((segment) => segment.toLowerCase()).join("/")}`;
}

export function hashManagedPrivateEndpointDesiredIdentity(
  endpoint: Pick<
    CanonicalManagedPrivateEndpoint,
    "name" | "targetPrivateLinkResourceId" | "targetSubresourceType"
  >,
): string {
  return sha256(
    stableJson({
      name: endpoint.name,
      targetPrivateLinkResourceId: endpoint.targetPrivateLinkResourceId,
      targetSubresourceType: canonicalSubresourceType(
        endpoint.targetSubresourceType,
      ),
    }),
  );
}

export function hashManagedPrivateEndpointObservedIdentity(
  endpoint: Pick<
    LiveManagedPrivateEndpoint,
    "name" | "targetPrivateLinkResourceId" | "targetSubresourceType"
  >,
): string {
  return sha256(
    stableJson({
      name: endpoint.name,
      targetPrivateLinkResourceId: endpoint.targetPrivateLinkResourceId,
      targetSubresourceType: canonicalSubresourceType(
        endpoint.targetSubresourceType,
      ),
    }),
  );
}

export function hashManagedPrivateEndpointOperation(
  endpoint: CanonicalManagedPrivateEndpoint,
): string {
  return sha256(
    stableJson({
      name: endpoint.name,
      desiredState: endpoint.desiredState,
      targetPrivateLinkResourceId: endpoint.targetPrivateLinkResourceId,
      targetSubresourceType: canonicalSubresourceType(
        endpoint.targetSubresourceType,
      ),
      requestMessageHash:
        endpoint.requestMessage === undefined
          ? undefined
          : sha256(endpoint.requestMessage),
    }),
  );
}

export function hashManagedPrivateEndpointRequestMessage(
  endpoint: CanonicalManagedPrivateEndpoint,
): string | undefined {
  return endpoint.requestMessage === undefined
    ? undefined
    : sha256(endpoint.requestMessage);
}

export function parseManagedPrivateEndpointResponse(
  value: unknown,
  context = "Fabric managed private endpoint response",
): LiveManagedPrivateEndpoint {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const id = assertGuid(value.id, `${context}.id`);
  const name = assertUnpaddedString(value.name, `${context}.name`);
  const targetPrivateLinkResourceId = canonicalizeArmResourceId(
    value.targetPrivateLinkResourceId,
    `${context}.targetPrivateLinkResourceId`,
  );
  const targetSubresourceType =
    value.targetSubresourceType === undefined
      ? undefined
      : assertUnpaddedString(
          value.targetSubresourceType,
          `${context}.targetSubresourceType`,
        );
  const provisioningState = parseExtensibleState(value.provisioningState);
  const connectionStatus =
    isRecord(value.connectionState)
      ? parseOptionalExtensibleState(value.connectionState.status)
      : undefined;
  return {
    id,
    name,
    targetPrivateLinkResourceId,
    ...(targetSubresourceType ? { targetSubresourceType } : {}),
    provisioningState,
    ...(connectionStatus ? { connectionStatus } : {}),
  };
}

export function planManagedPrivateEndpoints(
  desired: CanonicalManagedPrivateEndpoint[],
  observed: LiveManagedPrivateEndpoint[],
): PlannedManagedPrivateEndpoint[] {
  return desired
    .map((endpoint) => planManagedPrivateEndpoint(endpoint, observed))
    .sort((left, right) =>
      compareManagedPrivateEndpointNames(left, right),
    );
}

export function buildStaticManagedPrivateEndpointPlans(
  desired: CanonicalManagedPrivateEndpoint[],
  action: "blocked" | "unknown",
  reason: string,
  bootstrapBlocked = false,
): PlannedManagedPrivateEndpoint[] {
  return desired.map((endpoint) => ({
    name: endpoint.name,
    desiredState: endpoint.desiredState,
    targetPrivateLinkResourceId: endpoint.targetPrivateLinkResourceId,
    ...(endpoint.targetSubresourceType
      ? { targetSubresourceType: endpoint.targetSubresourceType }
      : {}),
    action,
    reason,
    operationHash: hashManagedPrivateEndpointOperation(endpoint),
    desiredIdentityHash:
      hashManagedPrivateEndpointDesiredIdentity(endpoint),
    ...(hashManagedPrivateEndpointRequestMessage(endpoint)
      ? {
          requestMessageHash:
            hashManagedPrivateEndpointRequestMessage(endpoint),
        }
      : {}),
    ...(bootstrapBlocked ? { bootstrapBlocked: true } : {}),
  }));
}

export function managedPrivateEndpointOapBlockers(
  endpoints: PlannedManagedPrivateEndpoint[] | undefined,
): string[] {
  return (endpoints ?? [])
    .filter(
      (endpoint) =>
        endpoint.desiredState === "present" &&
        !isManagedPrivateEndpointApproved(endpoint),
    )
    .map((endpoint) => endpoint.name)
    .sort((left, right) =>
      compareCanonicalStrings(left.toLowerCase(), right.toLowerCase()),
    );
}

export function isManagedPrivateEndpointApproved(
  endpoint: PlannedManagedPrivateEndpoint,
): boolean {
  return (
    endpoint.action === "no-op" &&
    classifyProvisioningState(endpoint.observedProvisioningState) ===
      "succeeded" &&
    classifyConnectionStatus(endpoint.observedConnectionStatus) === "approved"
  );
}

export function isExactManagedPrivateEndpointMatch(
  desired: Pick<
    CanonicalManagedPrivateEndpoint,
    "name" | "targetPrivateLinkResourceId" | "targetSubresourceType"
  >,
  observed: LiveManagedPrivateEndpoint,
): boolean {
  return (
    observed.name === desired.name &&
    observed.targetPrivateLinkResourceId ===
      desired.targetPrivateLinkResourceId &&
    (desired.targetSubresourceType === undefined ||
      canonicalSubresourceType(observed.targetSubresourceType) ===
        canonicalSubresourceType(desired.targetSubresourceType))
  );
}

export class ManagedPrivateEndpointAdapter {
  private readonly operationTimeoutMs: number;
  private readonly operationPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: FabricClient,
    options: ManagedPrivateEndpointAdapterOptions = {},
  ) {
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_FABRIC_OPERATION_TIMEOUT_MS;
    this.operationPollIntervalMs =
      options.operationPollIntervalMs ??
      DEFAULT_FABRIC_OPERATION_POLL_INTERVAL_MS;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        }));
    this.now = options.now ?? Date.now;
  }

  async listManagedPrivateEndpoints(
    workspaceId: string,
  ): Promise<LiveManagedPrivateEndpoint[]> {
    assertGuid(workspaceId, "workspace ID");
    const path = managedPrivateEndpointsPath(workspaceId);
    const values: LiveManagedPrivateEndpoint[] = [];
    const visited = new Set<string>();
    let nextUrl: string | undefined = path;

    while (nextUrl) {
      if (visited.has(nextUrl)) {
        throw new Error(
          "Fabric managed private endpoint pagination returned a repeated continuation URI.",
        );
      }
      visited.add(nextUrl);
      const response: FabricResponse<ManagedPrivateEndpointPage> =
        await this.client.request<ManagedPrivateEndpointPage>(
          "GET",
          nextUrl,
          {
            retryable: true,
            retryMode: "throttling-only",
            acceptedStatuses: [200],
          },
        );
      if (!response.body || !Array.isArray(response.body.value)) {
        throw new Error(
          "Fabric managed private endpoint list response is missing the value array.",
        );
      }
      const pageValues = response.body.value as unknown[];
      values.push(
        ...pageValues.map((entry: unknown, index: number) =>
          parseManagedPrivateEndpointResponse(
            entry,
            `Fabric managed private endpoint list response value[${index}]`,
          ),
        ),
      );
      const continuationUri = response.body.continuationUri;
      const continuationToken = response.body.continuationToken;
      if (
        continuationUri !== undefined &&
        continuationUri !== null &&
        typeof continuationUri !== "string"
      ) {
        throw new Error(
          "Fabric managed private endpoint list response continuationUri must be a string when present.",
        );
      }
      if (
        continuationToken !== undefined &&
        continuationToken !== null &&
        typeof continuationToken !== "string"
      ) {
        throw new Error(
          "Fabric managed private endpoint list response continuationToken must be a string when present.",
        );
      }
      if (
        typeof continuationUri === "string" &&
        continuationUri.length > 0
      ) {
        if (continuationUri.trim() !== continuationUri) {
          throw new Error(
            "Fabric managed private endpoint list response continuationUri must not contain surrounding whitespace.",
          );
        }
        nextUrl = continuationUri;
      } else if (
        typeof continuationToken === "string" &&
        continuationToken.length > 0
      ) {
        if (continuationToken.trim() !== continuationToken) {
          throw new Error(
            "Fabric managed private endpoint list response continuationToken must not contain surrounding whitespace.",
          );
        }
        nextUrl = `${path}?continuationToken=${continuationToken}`;
      } else {
        nextUrl = undefined;
      }
    }

    values.sort((left, right) => {
      const byName = compareManagedPrivateEndpointNames(left, right);
      return byName === 0
        ? compareCanonicalStrings(left.id, right.id)
        : byName;
    });
    return values;
  }

  async getManagedPrivateEndpoint(
    workspaceId: string,
    physicalId: string,
  ): Promise<LiveManagedPrivateEndpoint | undefined> {
    assertGuid(workspaceId, "workspace ID");
    const canonicalPhysicalId = assertGuid(
      physicalId,
      "managed private endpoint ID",
    );
    const response = await this.client.request<unknown>(
      "GET",
      managedPrivateEndpointPath(workspaceId, canonicalPhysicalId),
      {
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200, 404],
      },
    );
    if (response.status === 404) {
      return undefined;
    }
    if (response.body === undefined) {
      throw new Error("Fabric Get Managed Private Endpoint response is empty.");
    }
    const endpoint = parseManagedPrivateEndpointResponse(response.body);
    if (endpoint.id !== canonicalPhysicalId) {
      throw new Error(
        "Fabric Get Managed Private Endpoint response ID does not match the requested physical ID.",
      );
    }
    return endpoint;
  }

  async createManagedPrivateEndpoint(
    workspaceId: string,
    endpoint: CanonicalManagedPrivateEndpoint,
    options: { onDispatch?: () => void } = {},
  ): Promise<LiveManagedPrivateEndpoint> {
    assertGuid(workspaceId, "workspace ID");
    if (
      endpoint.desiredState !== "present" ||
      endpoint.requestMessage === undefined
    ) {
      throw new Error(
        "Managed private endpoint create requires a present endpoint with a request message.",
      );
    }
    let response: FabricResponse<unknown>;
    try {
      response = await this.client.request<unknown>(
        "POST",
        managedPrivateEndpointsPath(workspaceId),
        {
          body: {
            name: endpoint.name,
            targetPrivateLinkResourceId:
              endpoint.targetPrivateLinkResourceId,
            ...(endpoint.targetSubresourceType
              ? {
                  targetSubresourceType:
                    endpoint.targetSubresourceType,
                }
              : {}),
            requestMessage: endpoint.requestMessage,
          },
          retryable: true,
          retryMode: "throttling-only",
          acceptedStatuses: [201],
          onDispatch: options.onDispatch,
        },
      );
    } catch (error) {
      throw redactManagedPrivateEndpointError(error, [
        endpoint.requestMessage,
      ]);
    }
    if (response.body === undefined) {
      throw new Error(
        "Fabric Create Managed Private Endpoint response is empty.",
      );
    }
    const created = parseManagedPrivateEndpointResponse(response.body);
    assertLiveMatchesDesired(endpoint, created, "created");
    const locationId = managedPrivateEndpointIdFromLocation(
      response.headers.get("location"),
    );
    if (locationId && locationId !== created.id) {
      throw new Error(
        "Fabric Create Managed Private Endpoint response Location does not match the returned endpoint ID.",
      );
    }
    return created;
  }

  async deleteManagedPrivateEndpoint(
    workspaceId: string,
    physicalId: string,
    options: { onDispatch?: () => void } = {},
  ): Promise<"deleted" | "not-found"> {
    assertGuid(workspaceId, "workspace ID");
    const canonicalPhysicalId = assertGuid(
      physicalId,
      "managed private endpoint ID",
    );
    const response = await this.client.request<unknown>(
      "DELETE",
      managedPrivateEndpointPath(workspaceId, canonicalPhysicalId),
      {
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200, 404],
        onDispatch: options.onDispatch,
      },
    );
    return response.status === 404 ? "not-found" : "deleted";
  }

  async waitForProvisioningSucceeded(
    workspaceId: string,
    physicalId: string,
    desired: CanonicalManagedPrivateEndpoint,
  ): Promise<ManagedPrivateEndpointProvisioningOutcome> {
    const deadline = this.now() + this.operationTimeoutMs;
    while (true) {
      const observed = await this.getManagedPrivateEndpoint(
        workspaceId,
        physicalId,
      );
      if (!observed) {
        throw new Error(
          `Managed private endpoint '${desired.name}' disappeared while provisioning.`,
        );
      }
      assertLiveMatchesDesired(desired, observed, "provisioning");
      const provisioningState = classifyProvisioningState(
        observed.provisioningState,
      );
      const connectionStatus = classifyConnectionStatus(
        observed.connectionStatus,
      );
      if (
        connectionStatus === "rejected" ||
        connectionStatus === "disconnected"
      ) {
        throw new Error(
          `Managed private endpoint '${desired.name}' connection state is '${observed.connectionStatus}'.`,
        );
      }
      if (
        connectionStatus === "unknown" &&
        (observed.connectionStatus !== undefined ||
          provisioningState === "succeeded")
      ) {
        throw new Error(
          `Managed private endpoint '${desired.name}' returned unknown connection state '${observed.connectionStatus ?? "missing"}'.`,
        );
      }
      if (provisioningState === "succeeded") {
        return {
          endpoint: observed,
          approvalRequired: connectionStatus === "pending",
        };
      }
      if (
        provisioningState === "failed" ||
        provisioningState === "deleting"
      ) {
        throw new Error(
          `Managed private endpoint '${desired.name}' provisioning state is '${observed.provisioningState}'.`,
        );
      }
      if (
        provisioningState !== "provisioning" &&
        provisioningState !== "updating"
      ) {
        throw new Error(
          `Managed private endpoint '${desired.name}' returned unknown provisioning state '${observed.provisioningState}'.`,
        );
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        break;
      }
      await this.sleep(
        Math.min(this.operationPollIntervalMs, remaining),
      );
    }
    throw new Error(
      `Managed private endpoint '${desired.name}' provisioning timed out after ${this.operationTimeoutMs} ms.`,
    );
  }
}

function planManagedPrivateEndpoint(
  desired: CanonicalManagedPrivateEndpoint,
  observed: LiveManagedPrivateEndpoint[],
): PlannedManagedPrivateEndpoint {
  const base = {
    name: desired.name,
    desiredState: desired.desiredState,
    targetPrivateLinkResourceId:
      desired.targetPrivateLinkResourceId,
    ...(desired.targetSubresourceType
      ? { targetSubresourceType: desired.targetSubresourceType }
      : {}),
    operationHash: hashManagedPrivateEndpointOperation(desired),
    desiredIdentityHash:
      hashManagedPrivateEndpointDesiredIdentity(desired),
    ...(hashManagedPrivateEndpointRequestMessage(desired)
      ? {
          requestMessageHash:
            hashManagedPrivateEndpointRequestMessage(desired),
        }
      : {}),
  };
  const nameMatches = observed.filter(
    (endpoint) =>
      endpoint.name.toLowerCase() === desired.name.toLowerCase(),
  );
  if (nameMatches.length === 0) {
    return desired.desiredState === "present"
      ? {
          ...base,
          action: "create",
          reason: "No managed private endpoint exists with the exact desired name.",
        }
      : {
          ...base,
          action: "no-op",
          reason: "The managed private endpoint is already absent.",
        };
  }
  if (
    nameMatches.length !== 1 ||
    nameMatches[0]?.name !== desired.name
  ) {
    return {
      ...base,
      action: "blocked",
      reason:
        "Fabric contains a duplicate or case-insensitive managed private endpoint name collision.",
    };
  }
  const live = nameMatches[0];
  if (!isExactManagedPrivateEndpointMatch(desired, live)) {
    return {
      ...base,
      action: "blocked",
      reason:
        "The existing managed private endpoint name is bound to a different target identity; update and replace are not supported.",
      physicalId: live.id,
      observedIdentityHash:
        hashManagedPrivateEndpointObservedIdentity(live),
      observedProvisioningState: live.provisioningState,
      ...(live.connectionStatus
        ? { observedConnectionStatus: live.connectionStatus }
        : {}),
    };
  }

  const observedFields = {
    physicalId: live.id,
    observedIdentityHash:
      hashManagedPrivateEndpointObservedIdentity(live),
    observedProvisioningState: live.provisioningState,
    ...(live.connectionStatus
      ? { observedConnectionStatus: live.connectionStatus }
      : {}),
  };
  const provisioningState = classifyProvisioningState(
    live.provisioningState,
  );
  const connectionStatus = classifyConnectionStatus(
    live.connectionStatus,
  );
  if (provisioningState === "unknown") {
    return {
      ...base,
      ...observedFields,
      action: "unknown",
      reason:
        "The managed private endpoint has an unrecognized provisioning state.",
    };
  }
  if (
    connectionStatus === "rejected" ||
    connectionStatus === "disconnected"
  ) {
    return {
      ...base,
      ...observedFields,
      action: "blocked",
      reason:
        "The managed private endpoint connection is rejected or disconnected.",
    };
  }
  if (
    connectionStatus === "unknown" &&
    live.connectionStatus !== undefined
  ) {
    return {
      ...base,
      ...observedFields,
      action: "unknown",
      reason:
        "The managed private endpoint has an unrecognized connection state.",
    };
  }
  if (
    provisioningState === "failed" ||
    provisioningState === "deleting"
  ) {
    return {
      ...base,
      ...observedFields,
      action: "blocked",
      reason:
        "The managed private endpoint is failed or deleting and cannot be safely reconciled.",
    };
  }
  if (
    provisioningState === "succeeded" &&
    connectionStatus !== "approved" &&
    connectionStatus !== "pending"
  ) {
    return {
      ...base,
      ...observedFields,
      action: "unknown",
      reason:
        "The managed private endpoint is provisioned but has no recognized connection state.",
    };
  }

  if (desired.desiredState === "absent") {
    return {
      ...base,
      ...observedFields,
      action: "delete",
      reason:
        "The exact managed private endpoint target exists and is approved for guarded deletion.",
    };
  }
  const approvalRequired =
    connectionStatus === "pending" ||
    provisioningState === "provisioning" ||
    provisioningState === "updating";
  return {
    ...base,
    ...observedFields,
    action: "no-op",
    reason:
      provisioningState === "succeeded"
        ? approvalRequired
          ? "The exact managed private endpoint exists and is awaiting connection approval."
          : "The exact managed private endpoint is provisioned and approved."
        : "The exact managed private endpoint exists and is still provisioning.",
    ...(approvalRequired ? { approvalRequired: true } : {}),
  };
}

function managedPrivateEndpointsPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/managedPrivateEndpoints`;
}

function managedPrivateEndpointPath(
  workspaceId: string,
  physicalId: string,
): string {
  return `${managedPrivateEndpointsPath(workspaceId)}/${encodeURIComponent(
    physicalId,
  )}`;
}

function managedPrivateEndpointIdFromLocation(
  location: string | null,
): string | undefined {
  if (!location) {
    return undefined;
  }
  const match = /\/managedPrivateEndpoints\/([^/?#]+)\/?$/i.exec(location);
  if (!match?.[1]) {
    return undefined;
  }
  const value = decodeURIComponent(match[1]);
  return GUID_PATTERN.test(value) ? value.toLowerCase() : undefined;
}

function assertLiveMatchesDesired(
  desired: CanonicalManagedPrivateEndpoint,
  observed: LiveManagedPrivateEndpoint,
  phase: string,
): void {
  if (!isExactManagedPrivateEndpointMatch(desired, observed)) {
    throw new Error(
      `Managed private endpoint '${desired.name}' ${phase} response does not match the approved target identity.`,
    );
  }
}

function classifyProvisioningState(
  value: string | undefined,
):
  | "provisioning"
  | "succeeded"
  | "updating"
  | "deleting"
  | "failed"
  | "unknown" {
  switch (value?.toLowerCase()) {
    case "provisioning":
      return "provisioning";
    case "succeeded":
      return "succeeded";
    case "updating":
      return "updating";
    case "deleting":
      return "deleting";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function classifyConnectionStatus(
  value: string | undefined,
): "pending" | "approved" | "rejected" | "disconnected" | "unknown" {
  switch (value?.toLowerCase()) {
    case "pending":
      return "pending";
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "disconnected":
      return "disconnected";
    default:
      return "unknown";
  }
}

function compareManagedPrivateEndpointNames(
  left: { name: string },
  right: { name: string },
): number {
  const byCanonicalName = compareCanonicalStrings(
    left.name.toLowerCase(),
    right.name.toLowerCase(),
  );
  return byCanonicalName === 0
    ? compareCanonicalStrings(left.name, right.name)
    : byCanonicalName;
}

function canonicalSubresourceType(
  value: string | undefined,
): string | undefined {
  return value?.toLowerCase();
}

function parseExtensibleState(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : "Unknown";
}

function parseOptionalExtensibleState(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function assertDesiredState(
  value: unknown,
  context: string,
): DesiredState {
  if (value === undefined || value === "present") {
    return "present";
  }
  if (value === "absent") {
    return "absent";
  }
  throw new Error(`${context} must be either 'present' or 'absent'.`);
}

function assertUnpaddedString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  if (value.trim() !== value) {
    throw new Error(`${context} must not contain surrounding whitespace.`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${context} must be a non-blank string.`);
  }
  return value;
}

function assertGuid(value: unknown, context: string): string {
  if (typeof value !== "string" || !GUID_PATTERN.test(value)) {
    throw new Error(`${context} must be a GUID.`);
  }
  return value.toLowerCase();
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  context: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${context} contains unsupported property '${key}'.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
