import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  NetworkCommunicationPolicyManifest,
  NetworkDefaultAction,
  NetworkProtectionManifest,
  OutboundCloudConnectionRulesManifest,
  OutboundGatewayRulesManifest,
  PlannedNetworkCommunicationPolicy,
  PlannedNetworkProtection,
  PlannedNetworkSurface,
} from "../types";
import { FabricApiError, FabricClient } from "./client";

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OAP_NOT_ENABLED_SENTINEL_HASH = sha256(
  stableJson({ state: "outbound-access-protection-not-enabled" }),
);

// ---------------------------------------------------------------------------
// Canonical (normalized) shapes. These mirror the official GA REST API
// request/response bodies exactly so plan/apply can serialize them directly.
// ---------------------------------------------------------------------------

export interface CanonicalNetworkCommunicationPolicy {
  inbound: { publicAccessRules: { defaultAction: NetworkDefaultAction } };
  outbound: { publicAccessRules: { defaultAction: NetworkDefaultAction } };
}

export interface CanonicalOutboundConnectionEndpointRule {
  hostnamePattern: string;
}

export interface CanonicalOutboundConnectionWorkspaceRule {
  workspaceId: string;
}

export interface CanonicalOutboundConnectionRule {
  connectionType: string;
  defaultAction: NetworkDefaultAction;
  allowedEndpoints?: CanonicalOutboundConnectionEndpointRule[];
  allowedWorkspaces?: CanonicalOutboundConnectionWorkspaceRule[];
}

export interface CanonicalOutboundCloudConnectionRules {
  defaultAction: NetworkDefaultAction;
  rules: CanonicalOutboundConnectionRule[];
}

export interface CanonicalOutboundGatewayRule {
  id: string;
}

export interface CanonicalOutboundGatewayRules {
  defaultAction: NetworkDefaultAction;
  allowedGateways: CanonicalOutboundGatewayRule[];
}

export interface CanonicalNetworkProtection {
  workspaceId?: string;
  communicationPolicy: CanonicalNetworkCommunicationPolicy;
  outboundCloudConnectionRules?: CanonicalOutboundCloudConnectionRules;
  outboundGatewayRules?: CanonicalOutboundGatewayRules;
}

export interface NetworkCommunicationPolicySnapshot {
  policy: CanonicalNetworkCommunicationPolicy;
  etag?: string;
}

// ---------------------------------------------------------------------------
// Validation, normalization, and hashing
// ---------------------------------------------------------------------------

/**
 * Validates and canonically normalizes a desired `networkProtection` manifest
 * section: explicit defaultAction fields, sorted/deduplicated rules,
 * endpoints, workspaces, and gateway IDs, nonblank hostnames/connection
 * types, and GUID validation. Throws a descriptive error for any violation.
 */
export function normalizeNetworkProtection(
  desired: NetworkProtectionManifest,
): CanonicalNetworkProtection {
  if (!isRecord(desired)) {
    throw new Error("networkProtection must be an object.");
  }
  let workspaceId: string | undefined;
  if (desired.workspaceId !== undefined) {
    assertGuid(desired.workspaceId, "networkProtection.workspaceId");
    workspaceId = canonicalGuid(desired.workspaceId);
  }
  const communicationPolicy = normalizeCommunicationPolicyManifest(
    desired.communicationPolicy,
    "networkProtection.communicationPolicy",
  );
  const outboundCloudConnectionRules =
    desired.outboundCloudConnectionRules === undefined
      ? undefined
      : normalizeOutboundCloudConnectionRules(
          desired.outboundCloudConnectionRules,
          "networkProtection.outboundCloudConnectionRules",
        );
  const outboundGatewayRules =
    desired.outboundGatewayRules === undefined
      ? undefined
      : normalizeOutboundGatewayRules(
          desired.outboundGatewayRules,
          "networkProtection.outboundGatewayRules",
        );

  if (
    (outboundCloudConnectionRules || outboundGatewayRules) &&
    communicationPolicy.outbound.publicAccessRules.defaultAction !== "Deny"
  ) {
    throw new Error(
      "networkProtection.outboundCloudConnectionRules and outboundGatewayRules may only be declared when communicationPolicy.outboundDefaultAction is 'Deny'.",
    );
  }

  return {
    ...(workspaceId ? { workspaceId } : {}),
    communicationPolicy,
    ...(outboundCloudConnectionRules ? { outboundCloudConnectionRules } : {}),
    ...(outboundGatewayRules ? { outboundGatewayRules } : {}),
  };
}

function normalizeCommunicationPolicyManifest(
  value: NetworkCommunicationPolicyManifest,
  context: string,
): CanonicalNetworkCommunicationPolicy {
  if (!isRecord(value)) {
    throw new Error(`${context} is required and must be an object.`);
  }
  const inboundDefaultAction = assertDefaultAction(
    value.inboundDefaultAction,
    `${context}.inboundDefaultAction`,
  );
  if (inboundDefaultAction === "Deny") {
    throw new Error(
      `${context}.inboundDefaultAction 'Deny' is not supported yet. Phase 5A manages outbound access protection only; inbound firewall support arrives in Phase 5B. Use 'Allow' for now.`,
    );
  }
  const outboundDefaultAction = assertDefaultAction(
    value.outboundDefaultAction,
    `${context}.outboundDefaultAction`,
  );
  return {
    inbound: { publicAccessRules: { defaultAction: inboundDefaultAction } },
    outbound: { publicAccessRules: { defaultAction: outboundDefaultAction } },
  };
}

/** Defensively parses/canonicalizes a live GET response body. */
export function parseCommunicationPolicyResponse(
  value: unknown,
): CanonicalNetworkCommunicationPolicy {
  if (!isRecord(value)) {
    throw new Error(
      "Fabric network communication policy response is not an object.",
    );
  }
  return {
    inbound: {
      publicAccessRules: {
        defaultAction: parseNestedDefaultAction(
          value.inbound,
          "Fabric network communication policy response inbound",
        ),
      },
    },
    outbound: {
      publicAccessRules: {
        defaultAction: parseNestedDefaultAction(
          value.outbound,
          "Fabric network communication policy response outbound",
        ),
      },
    },
  };
}

function parseNestedDefaultAction(
  value: unknown,
  context: string,
): NetworkDefaultAction {
  if (!isRecord(value) || !isRecord(value.publicAccessRules)) {
    throw new Error(`${context} is missing publicAccessRules.`);
  }
  return assertDefaultAction(
    value.publicAccessRules.defaultAction,
    `${context}.publicAccessRules.defaultAction`,
  );
}

/**
 * Normalizes an `outboundCloudConnectionRules` body. The manifest shape and
 * the official GA request/response shape are identical, so this function is
 * reused both to validate manifest input and to canonically parse live GET
 * responses.
 */
export function normalizeOutboundCloudConnectionRules(
  value: OutboundCloudConnectionRulesManifest,
  context: string,
): CanonicalOutboundCloudConnectionRules {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const defaultAction = assertDefaultAction(
    value.defaultAction,
    `${context}.defaultAction`,
  );
  if (!Array.isArray(value.rules)) {
    throw new Error(`${context}.rules must be an array.`);
  }
  const seenConnectionTypes = new Set<string>();
  const rules = value.rules.map((rule, index) =>
    normalizeOutboundConnectionRule(
      rule,
      `${context}.rules[${index}]`,
      seenConnectionTypes,
    ),
  );
  rules.sort((left, right) =>
    compareCanonicalStrings(left.connectionType, right.connectionType),
  );
  return { defaultAction, rules };
}

function normalizeOutboundConnectionRule(
  value: unknown,
  context: string,
  seenConnectionTypes: Set<string>,
): CanonicalOutboundConnectionRule {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const connectionType = assertNonBlankString(
    value.connectionType,
    `${context}.connectionType`,
  );
  if (seenConnectionTypes.has(connectionType)) {
    throw new Error(
      `${context.replace(/\[\d+\]$/, "")} declares duplicate connectionType '${connectionType}'.`,
    );
  }
  seenConnectionTypes.add(connectionType);
  const defaultAction = assertDefaultAction(
    value.defaultAction,
    `${context}.defaultAction`,
  );

  let allowedEndpoints: CanonicalOutboundConnectionEndpointRule[] | undefined;
  if (value.allowedEndpoints !== undefined) {
    if (!Array.isArray(value.allowedEndpoints)) {
      throw new Error(`${context}.allowedEndpoints must be an array.`);
    }
    const seenHostnames = new Set<string>();
    allowedEndpoints = value.allowedEndpoints.map((endpoint, index) => {
      if (!isRecord(endpoint)) {
        throw new Error(
          `${context}.allowedEndpoints[${index}] must be an object.`,
        );
      }
      const hostnamePattern = assertNonBlankString(
        endpoint.hostnamePattern,
        `${context}.allowedEndpoints[${index}].hostnamePattern`,
      );
      if (seenHostnames.has(hostnamePattern)) {
        throw new Error(
          `${context}.allowedEndpoints declares duplicate hostnamePattern '${hostnamePattern}'.`,
        );
      }
      seenHostnames.add(hostnamePattern);
      return { hostnamePattern };
    });
    allowedEndpoints.sort((left, right) =>
      compareCanonicalStrings(left.hostnamePattern, right.hostnamePattern),
    );
  }

  let allowedWorkspaces: CanonicalOutboundConnectionWorkspaceRule[] | undefined;
  if (value.allowedWorkspaces !== undefined) {
    if (!Array.isArray(value.allowedWorkspaces)) {
      throw new Error(`${context}.allowedWorkspaces must be an array.`);
    }
    const seenWorkspaceIds = new Set<string>();
    allowedWorkspaces = value.allowedWorkspaces.map((workspace, index) => {
      if (!isRecord(workspace)) {
        throw new Error(
          `${context}.allowedWorkspaces[${index}] must be an object.`,
        );
      }
      assertGuid(
        workspace.workspaceId,
        `${context}.allowedWorkspaces[${index}].workspaceId`,
      );
      const workspaceId = canonicalGuid(workspace.workspaceId as string);
      if (seenWorkspaceIds.has(workspaceId)) {
        throw new Error(
          `${context}.allowedWorkspaces declares duplicate workspaceId '${workspaceId}'.`,
        );
      }
      seenWorkspaceIds.add(workspaceId);
      return { workspaceId };
    });
    allowedWorkspaces.sort((left, right) =>
      compareCanonicalStrings(left.workspaceId, right.workspaceId),
    );
  }

  return {
    connectionType,
    defaultAction,
    ...(allowedEndpoints && allowedEndpoints.length > 0
      ? { allowedEndpoints }
      : {}),
    ...(allowedWorkspaces && allowedWorkspaces.length > 0
      ? { allowedWorkspaces }
      : {}),
  };
}

/**
 * Normalizes an `outboundGatewayRules` body. The manifest shape and the
 * official GA request/response shape are identical, so this function is
 * reused both to validate manifest input and to canonically parse live GET
 * responses.
 */
export function normalizeOutboundGatewayRules(
  value: OutboundGatewayRulesManifest,
  context: string,
): CanonicalOutboundGatewayRules {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const defaultAction = assertDefaultAction(
    value.defaultAction,
    `${context}.defaultAction`,
  );
  if (!Array.isArray(value.allowedGateways)) {
    throw new Error(`${context}.allowedGateways must be an array.`);
  }
  const seenIds = new Set<string>();
  const allowedGateways = value.allowedGateways.map((gateway, index) => {
    if (!isRecord(gateway)) {
      throw new Error(
        `${context}.allowedGateways[${index}] must be an object.`,
      );
    }
    assertGuid(gateway.id, `${context}.allowedGateways[${index}].id`);
    const id = canonicalGuid(gateway.id as string);
    if (seenIds.has(id)) {
      throw new Error(
        `${context}.allowedGateways declares duplicate gateway id '${id}'.`,
      );
    }
    seenIds.add(id);
    return { id };
  });
  allowedGateways.sort((left, right) => compareCanonicalStrings(left.id, right.id));
  return { defaultAction, allowedGateways };
}

export function hashCommunicationPolicy(
  policy: CanonicalNetworkCommunicationPolicy,
): string {
  return sha256(stableJson(policy));
}

export function hashOutboundCloudConnectionRules(
  rules: CanonicalOutboundCloudConnectionRules,
): string {
  return sha256(stableJson(rules));
}

export function hashOutboundGatewayRules(
  rules: CanonicalOutboundGatewayRules,
): string {
  return sha256(stableJson(rules));
}

/** Builds a fully static (offline or blocked) plan without any network I/O. */
function buildStaticNetworkProtectionPlan(
  desired: NetworkProtectionManifest,
  action: Extract<PlannedNetworkSurface["action"], "blocked" | "unknown">,
  reason: string,
): PlannedNetworkProtection {
  const canonical = normalizeNetworkProtection(desired);
  const communicationPolicy: PlannedNetworkCommunicationPolicy = {
    action,
    reason,
    desiredHash: hashCommunicationPolicy(canonical.communicationPolicy),
    desiredInboundDefaultAction:
      canonical.communicationPolicy.inbound.publicAccessRules.defaultAction,
    desiredOutboundDefaultAction:
      canonical.communicationPolicy.outbound.publicAccessRules.defaultAction,
  };
  return {
    ...(canonical.workspaceId ? { workspaceId: canonical.workspaceId } : {}),
    communicationPolicy,
    ...(canonical.outboundCloudConnectionRules
      ? {
          outboundCloudConnectionRules: {
            action,
            reason,
            desiredHash: hashOutboundCloudConnectionRules(
              canonical.outboundCloudConnectionRules,
            ),
          },
        }
      : {}),
    ...(canonical.outboundGatewayRules
      ? {
          outboundGatewayRules: {
            action,
            reason,
            desiredHash: hashOutboundGatewayRules(canonical.outboundGatewayRules),
          },
        }
      : {}),
  };
}

/**
 * Builds the offline plan shown when Fabric authentication is not
 * configured. Every surface is reported with an `unknown` action.
 */
export function buildUnknownNetworkProtectionPlan(
  desired: NetworkProtectionManifest,
): PlannedNetworkProtection {
  return buildStaticNetworkProtectionPlan(
    desired,
    "unknown",
    "Online Fabric network protection discovery is disabled because authentication is not configured.",
  );
}

/**
 * Builds a blocked plan for every configured surface, used when the target
 * workspace cannot yet be resolved (a managed workspace pending creation) or
 * cannot be found.
 */
export function buildBlockedNetworkProtectionPlan(
  desired: NetworkProtectionManifest,
  reason: string,
): PlannedNetworkProtection {
  return buildStaticNetworkProtectionPlan(desired, "blocked", reason);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function communicationPolicyPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/networking/communicationPolicy`;
}

function outboundConnectionsPath(workspaceId: string): string {
  return `${communicationPolicyPath(workspaceId)}/outbound/connections`;
}

function outboundGatewaysPath(workspaceId: string): string {
  return `${communicationPolicyPath(workspaceId)}/outbound/gateways`;
}

/** Ensures an `If-Match` header value is wrapped in quotes exactly once. */
export function quoteEtag(etag: string): string {
  const trimmed = etag.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed
    : `"${trimmed}"`;
}

export class NetworkProtectionAdapter {
  constructor(private readonly client: FabricClient) {}

  async getCommunicationPolicy(
    workspaceId: string,
  ): Promise<NetworkCommunicationPolicySnapshot> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "GET",
      communicationPolicyPath(workspaceId),
    );
    if (response.body === undefined) {
      throw new Error(
        "Fabric Get Network Communication Policy response is empty.",
      );
    }
    return {
      policy: parseCommunicationPolicyResponse(response.body),
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async putCommunicationPolicy(
    workspaceId: string,
    desired: CanonicalNetworkCommunicationPolicy,
    options: { ifMatchEtag?: string; onDispatch?: () => void } = {},
  ): Promise<NetworkCommunicationPolicySnapshot> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "PUT",
      communicationPolicyPath(workspaceId),
      {
        body: desired,
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200],
        ...(options.ifMatchEtag
          ? { headers: { "if-match": quoteEtag(options.ifMatchEtag) } }
          : {}),
        onDispatch: options.onDispatch,
      },
    );
    return {
      policy:
        response.body === undefined
          ? desired
          : parseCommunicationPolicyResponse(response.body),
      etag: response.headers.get("etag") ?? undefined,
    };
  }

  async getOutboundCloudConnectionRules(
    workspaceId: string,
  ): Promise<CanonicalOutboundCloudConnectionRules> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "GET",
      outboundConnectionsPath(workspaceId),
    );
    if (response.body === undefined) {
      throw new Error(
        "Fabric Get Outbound Cloud Connection Rules response is empty.",
      );
    }
    return normalizeOutboundCloudConnectionRules(
      response.body as OutboundCloudConnectionRulesManifest,
      "Fabric outbound cloud connection rules response",
    );
  }

  async putOutboundCloudConnectionRules(
    workspaceId: string,
    desired: CanonicalOutboundCloudConnectionRules,
    options: { onDispatch?: () => void } = {},
  ): Promise<CanonicalOutboundCloudConnectionRules> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "PUT",
      outboundConnectionsPath(workspaceId),
      {
        body: desired,
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200],
        onDispatch: options.onDispatch,
      },
    );
    return response.body === undefined
      ? desired
      : normalizeOutboundCloudConnectionRules(
          response.body as OutboundCloudConnectionRulesManifest,
          "Fabric outbound cloud connection rules response",
        );
  }

  async getOutboundGatewayRules(
    workspaceId: string,
  ): Promise<CanonicalOutboundGatewayRules> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "GET",
      outboundGatewaysPath(workspaceId),
    );
    if (response.body === undefined) {
      throw new Error("Fabric Get Outbound Gateway Rules response is empty.");
    }
    return normalizeOutboundGatewayRules(
      response.body as OutboundGatewayRulesManifest,
      "Fabric outbound gateway rules response",
    );
  }

  async putOutboundGatewayRules(
    workspaceId: string,
    desired: CanonicalOutboundGatewayRules,
    options: { onDispatch?: () => void } = {},
  ): Promise<CanonicalOutboundGatewayRules> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "PUT",
      outboundGatewaysPath(workspaceId),
      {
        body: desired,
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200],
        onDispatch: options.onDispatch,
      },
    );
    return response.body === undefined
      ? desired
      : normalizeOutboundGatewayRules(
          response.body as OutboundGatewayRulesManifest,
          "Fabric outbound gateway rules response",
        );
  }

  async plan(
    workspaceId: string,
    desired: NetworkProtectionManifest,
  ): Promise<PlannedNetworkProtection> {
    const targetWorkspaceId = desired.workspaceId ?? workspaceId;
    assertGuid(targetWorkspaceId, "networkProtection workspace ID");
    const canonical = normalizeNetworkProtection(desired);

    let observedPolicy: NetworkCommunicationPolicySnapshot;
    try {
      observedPolicy = await this.getCommunicationPolicy(targetWorkspaceId);
    } catch (error) {
      if (error instanceof FabricApiError && error.status === 404) {
        return buildBlockedNetworkProtectionPlan(
          desired,
          `Network protection target workspace '${targetWorkspaceId}' was not found.`,
        );
      }
      throw error;
    }

    const desiredPolicyHash = hashCommunicationPolicy(
      canonical.communicationPolicy,
    );
    const observedPolicyHash = hashCommunicationPolicy(observedPolicy.policy);
    const policyMatches = desiredPolicyHash === observedPolicyHash;
    const observedInbound =
      observedPolicy.policy.inbound.publicAccessRules.defaultAction;
    const observedOutbound =
      observedPolicy.policy.outbound.publicAccessRules.defaultAction;
    const desiredInbound =
      canonical.communicationPolicy.inbound.publicAccessRules.defaultAction;
    const desiredOutbound =
      canonical.communicationPolicy.outbound.publicAccessRules.defaultAction;
    const isRelaxation =
      (observedInbound === "Deny" && desiredInbound === "Allow") ||
      (observedOutbound === "Deny" && desiredOutbound === "Allow");

    const communicationPolicy: PlannedNetworkCommunicationPolicy = {
      action: policyMatches ? "no-op" : "update",
      reason: policyMatches
        ? "Workspace network communication policy already matches the desired configuration."
        : `Workspace network communication policy differs from the desired configuration (observed inbound=${observedInbound}/outbound=${observedOutbound}, desired inbound=${desiredInbound}/outbound=${desiredOutbound}).`,
      desiredHash: desiredPolicyHash,
      observedStateHash: observedPolicyHash,
      ...(observedPolicy.etag ? { etag: observedPolicy.etag } : {}),
      desiredInboundDefaultAction: desiredInbound,
      desiredOutboundDefaultAction: desiredOutbound,
      observedInboundDefaultAction: observedInbound,
      observedOutboundDefaultAction: observedOutbound,
      isRelaxation,
    };

    const outboundCloudConnectionRules = canonical.outboundCloudConnectionRules
      ? await this.planOutboundSurface(
          targetWorkspaceId,
          observedOutbound,
          canonical.outboundCloudConnectionRules,
          hashOutboundCloudConnectionRules,
          (id) => this.getOutboundCloudConnectionRules(id),
          "outbound cloud connection rules",
        )
      : undefined;

    const outboundGatewayRules = canonical.outboundGatewayRules
      ? await this.planOutboundSurface(
          targetWorkspaceId,
          observedOutbound,
          canonical.outboundGatewayRules,
          hashOutboundGatewayRules,
          (id) => this.getOutboundGatewayRules(id),
          "outbound gateway rules",
        )
      : undefined;

    return {
      workspaceId: targetWorkspaceId,
      communicationPolicy,
      ...(outboundCloudConnectionRules ? { outboundCloudConnectionRules } : {}),
      ...(outboundGatewayRules ? { outboundGatewayRules } : {}),
    };
  }

  private async planOutboundSurface<T>(
    workspaceId: string,
    observedOutboundDefaultAction: NetworkDefaultAction,
    desired: T,
    hash: (value: T) => string,
    get: (workspaceId: string) => Promise<T>,
    label: string,
  ): Promise<PlannedNetworkSurface> {
    const desiredHash = hash(desired);
    if (observedOutboundDefaultAction !== "Deny") {
      return {
        action: "update",
        reason: `Outbound access protection is not yet enabled; the configured ${label} will be applied immediately after the communication policy is tightened to Deny.`,
        desiredHash,
        observedStateHash: OAP_NOT_ENABLED_SENTINEL_HASH,
      };
    }
    const observed = await get(workspaceId);
    const observedHash = hash(observed);
    const matches = observedHash === desiredHash;
    return {
      action: matches ? "no-op" : "update",
      reason: matches
        ? `The ${label} already match the desired configuration.`
        : `The ${label} differ from the desired configuration.`,
      desiredHash,
      observedStateHash: observedHash,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared runtime validation helpers
// ---------------------------------------------------------------------------

function assertDefaultAction(
  value: unknown,
  name: string,
): NetworkDefaultAction {
  if (value !== "Allow" && value !== "Deny") {
    throw new Error(`${name} must be either 'Allow' or 'Deny'.`);
  }
  return value;
}

function assertNonBlankString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-blank string.`);
  }
  return value;
}

function assertGuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !GUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a GUID.`);
  }
}

function canonicalGuid(value: string): string {
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
