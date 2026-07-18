import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import { FabricClient } from "./client";

export const MAX_TAG_DISPLAY_NAME_LENGTH = 40;

const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FabricTagScope =
  | { type: "Tenant" }
  | { type: "Domain"; domainId: string };

export interface FabricTag {
  id: string;
  displayName: string;
  scope: FabricTagScope;
}

export interface DesiredFabricTag {
  displayName: string;
  scope: FabricTagScope;
}

export interface FabricItemTagAssignment {
  id: string;
  displayName: string;
}

export interface TagCatalogPlanResult {
  action: "create" | "no-op" | "blocked";
  reason: string;
  observedStateHash: string;
  physicalId?: string;
}

export interface ItemTagAssignmentPlan {
  action: "no-op" | "update";
  reason: string;
  desiredTagIds: string[];
  observedTagIds: string[];
  missingTagIds: string[];
  observedStateHash: string;
}

export class FabricTagAdapter {
  constructor(private readonly client: FabricClient) {}

  async list(): Promise<FabricTag[]> {
    const raw = await this.client.listAll<unknown>("/v1/tags");
    return raw.map((entry, index) =>
      parseFabricTag(entry, `Fabric tag at index ${index}`),
    );
  }

  async plan(desired: DesiredFabricTag): Promise<TagCatalogPlanResult> {
    assertValidDesiredTag(desired);
    const tags = await this.list();

    const exactMatches = tags.filter(
      (tag) =>
        tag.displayName === desired.displayName &&
        scopesEqual(tag.scope, desired.scope),
    );

    if (exactMatches.length > 1) {
      return blockedResult(
        `Multiple tags named '${desired.displayName}' exist in the requested scope.`,
        exactMatches,
      );
    }

    const [singleMatch] = exactMatches;
    if (singleMatch) {
      return {
        action: "no-op",
        reason: `Tag '${desired.displayName}' already exists in the requested scope.`,
        physicalId: singleMatch.id,
        observedStateHash: hashObservedTags(exactMatches),
      };
    }

    const conflicts = tags.filter(
      (tag) =>
        namesEqualIgnoreCase(tag.displayName, desired.displayName) &&
        scopesConflict(desired.scope, tag.scope),
    );
    if (conflicts.length > 0) {
      return blockedResult(
        `Tag '${desired.displayName}' conflicts with an existing tag that prevents creation in the requested scope.`,
        conflicts,
      );
    }

    return {
      action: "create",
      reason: `Tag '${desired.displayName}' does not exist in the requested scope.`,
      observedStateHash: hashObservedTags([]),
    };
  }

  async create(desired: DesiredFabricTag): Promise<FabricTag> {
    assertValidDesiredTag(desired);
    const response = await this.client.request<unknown>(
      "POST",
      "/v1/admin/tags/bulkCreateTags",
      {
        body: {
          scope: scopeRequestBody(desired.scope),
          createTagsRequest: [{ displayName: desired.displayName }],
        },
        retryable: false,
        acceptedStatuses: [201],
      },
    );

    const body = response.body;
    if (!isRecord(body) || !Array.isArray(body.tags)) {
      throw new Error(
        "Fabric bulkCreateTags response is missing the tags array.",
      );
    }
    if (body.tags.length !== 1) {
      throw new Error(
        `Fabric bulkCreateTags response returned ${body.tags.length} tags; expected exactly one.`,
      );
    }

    const created = parseFabricTag(
      body.tags[0],
      "Fabric bulkCreateTags response tag",
    );
    if (created.displayName !== desired.displayName) {
      throw new Error(
        `Fabric bulkCreateTags returned displayName '${created.displayName}'; expected '${desired.displayName}'.`,
      );
    }
    if (!scopesEqual(created.scope, desired.scope)) {
      throw new Error(
        `Fabric bulkCreateTags returned tag '${desired.displayName}' with a mismatched scope.`,
      );
    }
    return created;
  }

  async verify(
    desired: DesiredFabricTag,
    tagId: string,
  ): Promise<FabricTag> {
    assertValidDesiredTag(desired);
    assertGuid(tagId, "tagId");
    const canonicalId = canonicalGuid(tagId);
    const matches = (await this.list()).filter(
      (tag) => canonicalGuid(tag.id) === canonicalId,
    );
    const [tag, ...rest] = matches;
    if (!tag) {
      throw new Error(
        `Tag verification failed: no tag found with ID '${tagId}'.`,
      );
    }
    if (rest.length > 0) {
      throw new Error(
        `Tag verification failed: multiple tags found with ID '${tagId}'.`,
      );
    }
    if (tag.displayName !== desired.displayName) {
      throw new Error(
        `Tag verification failed: expected displayName '${desired.displayName}', received '${tag.displayName}'.`,
      );
    }
    if (!scopesEqual(tag.scope, desired.scope)) {
      throw new Error(
        `Tag verification failed: tag '${desired.displayName}' has a mismatched scope.`,
      );
    }
    return tag;
  }

  async planItemAssignment(
    workspaceId: string,
    itemId: string,
    desiredTagIds: string[],
  ): Promise<ItemTagAssignmentPlan> {
    assertGuid(workspaceId, "workspaceId");
    assertGuid(itemId, "itemId");
    const desired = canonicalizeTagIds(desiredTagIds, "desiredTagIds");
    const observed = canonicalizeTagIds(
      (await this.getItemTags(workspaceId, itemId)).map((tag) => tag.id),
      "item tags",
    );
    const observedSet = new Set(observed);
    const missingTagIds = desired.filter((id) => !observedSet.has(id));
    const observedStateHash = sha256(stableJson(observed));

    if (missingTagIds.length === 0) {
      return {
        action: "no-op",
        reason: `Item '${itemId}' already carries all ${desired.length} desired tag(s).`,
        desiredTagIds: desired,
        observedTagIds: observed,
        missingTagIds: [],
        observedStateHash,
      };
    }

    return {
      action: "update",
      reason: `Item '${itemId}' is missing ${missingTagIds.length} desired tag(s).`,
      desiredTagIds: desired,
      observedTagIds: observed,
      missingTagIds,
      observedStateHash,
    };
  }

  async applyItemTags(
    workspaceId: string,
    itemId: string,
    tagIds: string[],
  ): Promise<void> {
    assertGuid(workspaceId, "workspaceId");
    assertGuid(itemId, "itemId");
    const tags = canonicalizeTagIds(tagIds, "tagIds");
    if (tags.length === 0) {
      throw new Error("applyItemTags requires at least one tag ID.");
    }
    await this.client.request<unknown>(
      "POST",
      `${itemPath(workspaceId, itemId)}/applyTags`,
      {
        body: { tags },
        retryable: false,
        acceptedStatuses: [200],
      },
    );
  }

  async verifyItemAssignment(
    workspaceId: string,
    itemId: string,
    desiredTagIds: string[],
  ): Promise<string[]> {
    assertGuid(workspaceId, "workspaceId");
    assertGuid(itemId, "itemId");
    const desired = canonicalizeTagIds(desiredTagIds, "desiredTagIds");
    const observed = canonicalizeTagIds(
      (await this.getItemTags(workspaceId, itemId)).map((tag) => tag.id),
      "item tags",
    );
    const observedSet = new Set(observed);
    const missing = desired.filter((id) => !observedSet.has(id));
    if (missing.length > 0) {
      throw new Error(
        `Item tag assignment verification failed: item '${itemId}' is missing tags ${missing.join(
          ", ",
        )}.`,
      );
    }
    return observed;
  }

  private async getItemTags(
    workspaceId: string,
    itemId: string,
  ): Promise<FabricItemTagAssignment[]> {
    const response = await this.client.request<unknown>(
      "GET",
      itemPath(workspaceId, itemId),
    );
    const body = response.body;
    if (!isRecord(body)) {
      throw new Error("Fabric Get Item response is empty.");
    }
    return parseItemTags(body.tags);
  }
}

export function hashObservedTags(tags: FabricTag[]): string {
  const ordered = [...tags]
    .map(canonicalTag)
    .sort((left, right) =>
      compareCanonicalStrings(stableJson(left), stableJson(right)),
    );
  return sha256(stableJson(ordered));
}

function blockedResult(
  reason: string,
  tags: FabricTag[],
): TagCatalogPlanResult {
  return {
    action: "blocked",
    reason,
    ...(tags.length === 1 && tags[0]?.id
      ? { physicalId: tags[0].id }
      : {}),
    observedStateHash: hashObservedTags(tags),
  };
}

function canonicalTag(tag: FabricTag): {
  id: string;
  displayName: string;
  scope: FabricTagScope;
} {
  return {
    id: tag.id,
    displayName: tag.displayName,
    scope: normalizeScope(tag.scope),
  };
}

function normalizeScope(scope: FabricTagScope): FabricTagScope {
  return scope.type === "Domain"
    ? { type: "Domain", domainId: canonicalGuid(scope.domainId) }
    : { type: "Tenant" };
}

function scopeRequestBody(scope: FabricTagScope): FabricTagScope {
  return scope.type === "Domain"
    ? { type: "Domain", domainId: scope.domainId }
    : { type: "Tenant" };
}

function scopesEqual(left: FabricTagScope, right: FabricTagScope): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "Domain" && right.type === "Domain") {
    return canonicalGuid(left.domainId) === canonicalGuid(right.domainId);
  }
  return true;
}

function scopesConflict(
  desired: FabricTagScope,
  other: FabricTagScope,
): boolean {
  if (desired.type === "Tenant" || other.type === "Tenant") {
    return true;
  }
  return canonicalGuid(desired.domainId) === canonicalGuid(other.domainId);
}

function namesEqualIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseFabricTag(value: unknown, context: string): FabricTag {
  if (!isRecord(value)) {
    throw new Error(`${context} is not an object.`);
  }
  if (typeof value.id !== "string" || !GUID_PATTERN.test(value.id)) {
    throw new Error(`${context} is missing a valid id.`);
  }
  if (typeof value.displayName !== "string" || value.displayName.length === 0) {
    throw new Error(`${context} is missing a valid displayName.`);
  }
  return {
    id: value.id,
    displayName: value.displayName,
    scope: parseScope(value.scope, context),
  };
}

function parseScope(value: unknown, context: string): FabricTagScope {
  if (!isRecord(value)) {
    throw new Error(`${context} is missing a valid scope.`);
  }
  if (value.type === "Tenant") {
    return { type: "Tenant" };
  }
  if (value.type === "Domain") {
    if (
      typeof value.domainId !== "string" ||
      !GUID_PATTERN.test(value.domainId)
    ) {
      throw new Error(`${context} has a Domain scope without a valid domainId.`);
    }
    return { type: "Domain", domainId: value.domainId };
  }
  throw new Error(
    `${context} has an unsupported scope type '${String(value.type)}'.`,
  );
}

function parseItemTags(value: unknown): FabricItemTagAssignment[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Fabric item tags must be an array when present.");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Fabric item tag at index ${index} is not an object.`);
    }
    if (typeof entry.id !== "string" || !GUID_PATTERN.test(entry.id)) {
      throw new Error(
        `Fabric item tag at index ${index} is missing a valid id.`,
      );
    }
    if (typeof entry.displayName !== "string") {
      throw new Error(
        `Fabric item tag at index ${index} is missing a valid displayName.`,
      );
    }
    return { id: entry.id, displayName: entry.displayName };
  });
}

function assertValidDesiredTag(desired: DesiredFabricTag): void {
  if (!isRecord(desired)) {
    throw new Error("Desired tag must be an object.");
  }
  if (
    typeof desired.displayName !== "string" ||
    desired.displayName.trim().length === 0
  ) {
    throw new Error("Desired tag displayName must be a non-empty string.");
  }
  if (desired.displayName.length > MAX_TAG_DISPLAY_NAME_LENGTH) {
    throw new Error(
      `Desired tag displayName must be at most ${MAX_TAG_DISPLAY_NAME_LENGTH} characters.`,
    );
  }
  parseScope(desired.scope, "Desired tag");
}

function canonicalizeTagIds(ids: unknown, name: string): string[] {
  if (!Array.isArray(ids)) {
    throw new Error(`${name} must be an array of tag IDs.`);
  }
  const canonical = ids.map((id, index) => {
    assertGuid(id, `${name}[${index}]`);
    return canonicalGuid(id as string);
  });
  return [...new Set(canonical)].sort(compareCanonicalStrings);
}

function assertGuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !GUID_PATTERN.test(value)) {
    throw new Error(`${name} must be a GUID.`);
  }
}

function canonicalGuid(value: string): string {
  return value.toLowerCase();
}

function itemPath(workspaceId: string, itemId: string): string {
  return `/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/items/${encodeURIComponent(itemId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
