import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  InboundFirewallRulesManifest,
  NetworkCommunicationPolicyManifest,
  NetworkDefaultAction,
  NetworkProtectionManifest,
  OutboundCloudConnectionRulesManifest,
  OutboundGatewayRulesManifest,
  PlannedInboundFirewallRules,
  PlannedNetworkCommunicationPolicy,
  PlannedNetworkProtection,
  PlannedNetworkSurface,
} from "../types";
import { FabricApiError, FabricClient } from "./client";
import {
  buildStaticManagedPrivateEndpointPlans,
  managedPrivateEndpointOapBlockers,
  ManagedPrivateEndpointAdapter,
  normalizeManagedPrivateEndpoints,
  planManagedPrivateEndpoints,
  type CanonicalManagedPrivateEndpoint,
} from "./managed-private-endpoints";

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

export interface CanonicalInboundFirewallRule {
  displayName: string;
  value: string;
}

export interface CanonicalInboundFirewallRules {
  rules: CanonicalInboundFirewallRule[];
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
  inboundFirewallRules?: CanonicalInboundFirewallRules;
  outboundCloudConnectionRules?: CanonicalOutboundCloudConnectionRules;
  outboundGatewayRules?: CanonicalOutboundGatewayRules;
  managedPrivateEndpoints?: CanonicalManagedPrivateEndpoint[];
}

export interface NetworkCommunicationPolicySnapshot {
  policy: CanonicalNetworkCommunicationPolicy;
  etag?: string;
}

export interface InboundFirewallRulesSnapshot {
  configuration: CanonicalInboundFirewallRules;
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
  assertOnlyKeys(
    desired,
    [
      "workspaceId",
      "communicationPolicy",
      "inboundFirewallRules",
      "outboundCloudConnectionRules",
      "outboundGatewayRules",
      "managedPrivateEndpoints",
    ],
    "networkProtection",
  );
  let workspaceId: string | undefined;
  if (desired.workspaceId !== undefined) {
    assertGuid(desired.workspaceId, "networkProtection.workspaceId");
    workspaceId = canonicalGuid(desired.workspaceId);
  }
  const communicationPolicy = normalizeCommunicationPolicyManifest(
    desired.communicationPolicy,
    "networkProtection.communicationPolicy",
  );
  const inboundFirewallRules =
    desired.inboundFirewallRules === undefined
      ? undefined
      : normalizeInboundFirewallRules(
          desired.inboundFirewallRules,
          "networkProtection.inboundFirewallRules",
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
  const managedPrivateEndpoints =
    desired.managedPrivateEndpoints === undefined
      ? undefined
      : normalizeManagedPrivateEndpoints(
          desired.managedPrivateEndpoints,
          "networkProtection.managedPrivateEndpoints",
        );

  if (
    communicationPolicy.inbound.publicAccessRules.defaultAction === "Deny" &&
    (!inboundFirewallRules || inboundFirewallRules.rules.length === 0)
  ) {
    throw new Error(
      "networkProtection.communicationPolicy.inboundDefaultAction 'Deny' requires an explicit inboundFirewallRules configuration with at least one valid public IPv4 rule.",
    );
  }
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
    ...(inboundFirewallRules ? { inboundFirewallRules } : {}),
    ...(outboundCloudConnectionRules ? { outboundCloudConnectionRules } : {}),
    ...(outboundGatewayRules ? { outboundGatewayRules } : {}),
    ...(managedPrivateEndpoints ? { managedPrivateEndpoints } : {}),
  };
}

function normalizeCommunicationPolicyManifest(
  value: NetworkCommunicationPolicyManifest,
  context: string,
): CanonicalNetworkCommunicationPolicy {
  if (!isRecord(value)) {
    throw new Error(`${context} is required and must be an object.`);
  }
  assertOnlyKeys(
    value,
    ["inboundDefaultAction", "outboundDefaultAction"],
    context,
  );
  const inboundDefaultAction = assertDefaultAction(
    value.inboundDefaultAction,
    `${context}.inboundDefaultAction`,
  );
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

interface ParsedIpv4Interval {
  start: number;
  end: number;
  canonicalValue: string;
}

const NON_PUBLIC_IPV4_INTERVALS = [
  { start: 0x00000000, end: 0x00ffffff, label: "0.0.0.0/8" },
  { start: 0x0a000000, end: 0x0affffff, label: "RFC 1918 10.0.0.0/8" },
  { start: 0x64400000, end: 0x647fffff, label: "100.64.0.0/10" },
  { start: 0x7f000000, end: 0x7fffffff, label: "127.0.0.0/8" },
  { start: 0xa9fe0000, end: 0xa9feffff, label: "169.254.0.0/16" },
  { start: 0xac100000, end: 0xac1fffff, label: "RFC 1918 172.16.0.0/12" },
  { start: 0xc0000000, end: 0xc00000ff, label: "192.0.0.0/24" },
  { start: 0xc0000200, end: 0xc00002ff, label: "192.0.2.0/24" },
  { start: 0xc0586300, end: 0xc05863ff, label: "192.88.99.0/24" },
  { start: 0xc0a80000, end: 0xc0a8ffff, label: "RFC 1918 192.168.0.0/16" },
  { start: 0xc6120000, end: 0xc613ffff, label: "198.18.0.0/15" },
  { start: 0xc6336400, end: 0xc63364ff, label: "198.51.100.0/24" },
  { start: 0xcb007100, end: 0xcb0071ff, label: "203.0.113.0/24" },
  { start: 0xe0000000, end: 0xefffffff, label: "224.0.0.0/4" },
  { start: 0xf0000000, end: 0xffffffff, label: "240.0.0.0/4" },
] as const;

/**
 * Validates and canonicalizes the preview workspace inbound IP firewall body.
 * Only the documented public IPv4 single-address, range, and CIDR forms are
 * accepted. IPv6 support is not documented by Fabric and therefore fails
 * closed in this increment.
 */
export function normalizeInboundFirewallRules(
  value: InboundFirewallRulesManifest,
  context: string,
): CanonicalInboundFirewallRules {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  assertOnlyKeys(value, ["rules"], context);
  if (!Array.isArray(value.rules)) {
    throw new Error(`${context}.rules must be an array.`);
  }
  if (value.rules.length > 256) {
    throw new Error(`${context}.rules may contain at most 256 rules.`);
  }

  const seenDisplayNames = new Map<string, string>();
  const normalized = value.rules.map((rule, index) => {
    const ruleContext = `${context}.rules[${index}]`;
    if (!isRecord(rule)) {
      throw new Error(`${ruleContext} must be an object.`);
    }
    assertOnlyKeys(rule, ["displayName", "value"], ruleContext);
    const displayName = assertNonBlankString(
      rule.displayName,
      `${ruleContext}.displayName`,
    );
    if (displayName.trim() !== displayName) {
      throw new Error(
        `${ruleContext}.displayName must not contain leading or trailing whitespace.`,
      );
    }
    if (Array.from(displayName).length > 128) {
      throw new Error(
        `${ruleContext}.displayName must be at most 128 characters.`,
      );
    }
    const displayNameKey = displayName.toLowerCase();
    const previousDisplayName = seenDisplayNames.get(displayNameKey);
    if (previousDisplayName !== undefined) {
      throw new Error(
        `${context}.rules declares duplicate or case-ambiguous displayName '${displayName}' (already declared as '${previousDisplayName}').`,
      );
    }
    seenDisplayNames.set(displayNameKey, displayName);

    const interval = parsePublicIpv4Interval(
      rule.value,
      `${ruleContext}.value`,
    );
    return {
      displayName,
      value: interval.canonicalValue,
      start: interval.start,
      end: interval.end,
    };
  });

  normalized.sort(
    (left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      compareCanonicalStrings(left.displayName, right.displayName),
  );
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current.start <= previous.end) {
      throw new Error(
        `${context}.rules contains duplicate or overlapping IP declarations '${previous.value}' and '${current.value}'.`,
      );
    }
  }

  return {
    rules: normalized.map(({ displayName, value: ruleValue }) => ({
      displayName,
      value: ruleValue,
    })),
  };
}

function parsePublicIpv4Interval(
  value: unknown,
  context: string,
): ParsedIpv4Interval {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `${context} must be a public IPv4 address, range, or CIDR string.`,
    );
  }
  if (/\s/.test(value)) {
    throw new Error(`${context} must not contain whitespace.`);
  }

  let start: number;
  let end: number;
  if (value.includes("/")) {
    if (value.includes("-") || value.split("/").length !== 2) {
      throw new Error(`${context} is not a valid IPv4 CIDR value.`);
    }
    const [addressText, prefixText] = value.split("/");
    const address = parseIpv4Address(addressText!, context);
    if (!/^(?:0|[1-9]|[12][0-9]|3[0-2])$/.test(prefixText!)) {
      throw new Error(`${context} has an invalid IPv4 CIDR prefix.`);
    }
    const prefix = Number(prefixText);
    const blockSize = 2 ** (32 - prefix);
    start = Math.floor(address / blockSize) * blockSize;
    end = start + blockSize - 1;
  } else if (value.includes("-")) {
    const parts = value.split("-");
    if (parts.length !== 2) {
      throw new Error(`${context} is not a valid IPv4 range.`);
    }
    start = parseIpv4Address(parts[0]!, context);
    end = parseIpv4Address(parts[1]!, context);
    if (start > end) {
      throw new Error(
        `${context} range start must be less than or equal to its end.`,
      );
    }
  } else {
    start = parseIpv4Address(value, context);
    end = start;
  }

  const nonPublic = NON_PUBLIC_IPV4_INTERVALS.find(
    (interval) => start <= interval.end && end >= interval.start,
  );
  if (nonPublic) {
    throw new Error(
      `${context} must contain only public internet IPv4 addresses and overlaps unsupported ${nonPublic.label}.`,
    );
  }
  return {
    start,
    end,
    canonicalValue: canonicalIpv4IntervalValue(start, end),
  };
}

function parseIpv4Address(value: string, context: string): number {
  const octets = value.split(".");
  if (
    octets.length !== 4 ||
    octets.some(
      (octet) =>
        !/^(?:0|[1-9][0-9]{0,2})$/.test(octet) ||
        Number(octet) > 255,
    )
  ) {
    throw new Error(
      `${context} must use an unambiguous dotted-decimal IPv4 address.`,
    );
  }
  return octets.reduce(
    (result, octet) => result * 256 + Number(octet),
    0,
  );
}

function canonicalIpv4IntervalValue(start: number, end: number): string {
  if (start === end) {
    return formatIpv4Address(start);
  }
  const size = end - start + 1;
  const prefixOffset = Math.log2(size);
  if (
    Number.isInteger(prefixOffset) &&
    start % size === 0
  ) {
    return `${formatIpv4Address(start)}/${32 - prefixOffset}`;
  }
  return `${formatIpv4Address(start)}-${formatIpv4Address(end)}`;
}

function formatIpv4Address(value: number): string {
  return [
    Math.floor(value / 2 ** 24) % 256,
    Math.floor(value / 2 ** 16) % 256,
    Math.floor(value / 2 ** 8) % 256,
    value % 256,
  ].join(".");
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

export function hashInboundFirewallRules(
  rules: CanonicalInboundFirewallRules,
): string {
  return sha256(stableJson(rules));
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
  bootstrapBlocked = false,
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
    ...(canonical.inboundFirewallRules
      ? {
          inboundFirewallRules: {
            action,
            reason,
            desiredHash: hashInboundFirewallRules(
              canonical.inboundFirewallRules,
            ),
            ruleCount: canonical.inboundFirewallRules.rules.length,
          },
        }
      : {}),
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
    ...(canonical.managedPrivateEndpoints
      ? {
          managedPrivateEndpoints:
            buildStaticManagedPrivateEndpointPlans(
              canonical.managedPrivateEndpoints,
              action,
              reason,
              bootstrapBlocked,
            ),
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
  bootstrapBlocked = false,
): PlannedNetworkProtection {
  return buildStaticNetworkProtectionPlan(
    desired,
    "blocked",
    reason,
    bootstrapBlocked,
  );
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function communicationPolicyPath(workspaceId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/networking/communicationPolicy`;
}

function inboundFirewallPath(workspaceId: string): string {
  return `${communicationPolicyPath(workspaceId)}/inbound/firewall`;
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
  constructor(
    private readonly client: FabricClient,
    private readonly managedPrivateEndpointAdapter =
      new ManagedPrivateEndpointAdapter(client),
  ) {}

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

  async getInboundFirewallRules(
    workspaceId: string,
  ): Promise<InboundFirewallRulesSnapshot> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "GET",
      inboundFirewallPath(workspaceId),
    );
    if (response.body === undefined) {
      throw new Error("Fabric Get Firewall Rules response is empty.");
    }
    const etag = response.headers.get("etag")?.trim();
    return {
      configuration: normalizeInboundFirewallRules(
        response.body as InboundFirewallRulesManifest,
        "Fabric inbound firewall rules response",
      ),
      ...(etag ? { etag } : {}),
    };
  }

  async putInboundFirewallRules(
    workspaceId: string,
    desired: CanonicalInboundFirewallRules,
    options: { ifMatchEtag?: string; onDispatch?: () => void },
  ): Promise<InboundFirewallRulesSnapshot> {
    assertGuid(workspaceId, "workspace ID");
    const response = await this.client.request<unknown>(
      "PUT",
      inboundFirewallPath(workspaceId),
      {
        body: desired,
        retryable: true,
        retryMode: "throttling-only",
        acceptedStatuses: [200, 204],
        ...(options.ifMatchEtag
          ? { headers: { "if-match": quoteEtag(options.ifMatchEtag) } }
          : {}),
        onDispatch: options.onDispatch,
      },
    );
    if (response.body !== undefined) {
      throw new Error(
        "Fabric Set Firewall Rules returned an unexpected response body.",
      );
    }
    const etag = response.headers.get("etag")?.trim();
    return {
      configuration: desired,
      ...(etag ? { etag } : {}),
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

    let communicationPolicy: PlannedNetworkCommunicationPolicy = {
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

    const inboundFirewallRules = canonical.inboundFirewallRules
      ? await this.planInboundFirewallSurface(
          targetWorkspaceId,
          canonical.inboundFirewallRules,
        )
      : undefined;

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
    const managedPrivateEndpoints = canonical.managedPrivateEndpoints
      ? planManagedPrivateEndpoints(
          canonical.managedPrivateEndpoints,
          await this.managedPrivateEndpointAdapter.listManagedPrivateEndpoints(
            targetWorkspaceId,
          ),
        )
      : undefined;
    const managedPrivateEndpointBlockers =
      managedPrivateEndpointOapBlockers(managedPrivateEndpoints);
    if (
      communicationPolicy.action === "update" &&
      observedOutbound === "Allow" &&
      desiredOutbound === "Deny" &&
      managedPrivateEndpointBlockers.length > 0
    ) {
      communicationPolicy = {
        ...communicationPolicy,
        action: "blocked",
        reason:
          "Outbound Deny is blocked until every declared present managed private endpoint is provisioned and approved. Apply the endpoint changes first, obtain approval, then generate a new plan.",
        blockedByManagedPrivateEndpoints:
          managedPrivateEndpointBlockers,
      };
    }

    return {
      workspaceId: targetWorkspaceId,
      communicationPolicy,
      ...(inboundFirewallRules ? { inboundFirewallRules } : {}),
      ...(outboundCloudConnectionRules ? { outboundCloudConnectionRules } : {}),
      ...(outboundGatewayRules ? { outboundGatewayRules } : {}),
      ...(managedPrivateEndpoints ? { managedPrivateEndpoints } : {}),
    };
  }

  private async planInboundFirewallSurface(
    workspaceId: string,
    desired: CanonicalInboundFirewallRules,
  ): Promise<PlannedInboundFirewallRules> {
    const observed = await this.getInboundFirewallRules(workspaceId);
    const desiredHash = hashInboundFirewallRules(desired);
    const observedHash = hashInboundFirewallRules(observed.configuration);
    const matches = observedHash === desiredHash;
    return {
      action: matches ? "no-op" : "update",
      reason: matches
        ? "The preview inbound firewall rules already match the desired configuration."
        : "The preview inbound firewall rules differ from the desired full-replacement configuration.",
      desiredHash,
      observedStateHash: observedHash,
      ...(observed.etag ? { etag: observed.etag } : {}),
      ruleCount: desired.rules.length,
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

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  context: string,
): void {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort(compareCanonicalStrings);
  if (unexpected.length > 0) {
    throw new Error(
      `${context} contains unsupported propert${unexpected.length === 1 ? "y" : "ies"}: ${unexpected
        .map((key) => `'${key}'`)
        .join(", ")}.`,
    );
  }
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
