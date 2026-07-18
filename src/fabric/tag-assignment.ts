import { compareCanonicalStrings, sha256, stableJson } from "../hash";
import type {
  LoadedManifest,
  PlannedItemTagAssignment,
} from "../types";

export function getDesiredTagLogicalIds(
  loaded: LoadedManifest,
  itemLogicalId: string,
): string[] {
  return [...(loaded.itemDefinitions[itemLogicalId]?.tags ?? [])].sort(
    compareCanonicalStrings,
  );
}

export function buildTagAssignmentHash(
  loaded: LoadedManifest,
  itemLogicalId: string,
): string {
  return sha256(
    stableJson({
      itemLogicalId,
      tags: getDesiredTagLogicalIds(loaded, itemLogicalId).map(
        (logicalId) => ({
          logicalId,
          contentHash: loaded.itemContentHashes[logicalId] ?? null,
        }),
      ),
    }),
  );
}

export function buildOfflineTagAssignment(
  loaded: LoadedManifest,
  itemLogicalId: string,
): PlannedItemTagAssignment | undefined {
  const tagLogicalIds = getDesiredTagLogicalIds(loaded, itemLogicalId);
  if (tagLogicalIds.length === 0) {
    return undefined;
  }
  return {
    assignmentHash: buildTagAssignmentHash(loaded, itemLogicalId),
    tagLogicalIds,
    missingTagLogicalIds: tagLogicalIds,
    action: "unknown",
    observedStateHash: sha256(stableJson({ appliedDesiredTagIds: null })),
    reason:
      "Live Fabric tag assignment state is not available during offline planning.",
  };
}
