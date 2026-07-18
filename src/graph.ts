import type { DeploymentItem } from "./types";

export function buildDeploymentStages(items: DeploymentItem[]): string[][] {
  const present = new Set(
    items
      .filter((item) => item.desiredState !== "absent")
      .map((item) => item.logicalId),
  );
  const absent = new Set(
    items
      .filter((item) => item.desiredState === "absent")
      .map((item) => item.logicalId),
  );
  return [
    ...buildStages(items, present),
    ...buildStages(items, absent).reverse(),
  ];
}

function buildStages(
  items: DeploymentItem[],
  included: Set<string>,
): string[][] {
  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const item of items) {
    if (!included.has(item.logicalId)) {
      continue;
    }
    dependencies.set(
      item.logicalId,
      new Set(
        (item.dependsOn ?? []).filter((logicalId) => included.has(logicalId)),
      ),
    );
    dependents.set(item.logicalId, new Set());
  }

  for (const item of items) {
    if (!included.has(item.logicalId)) {
      continue;
    }
    for (const dependency of item.dependsOn ?? []) {
      if (included.has(dependency)) {
        dependents.get(dependency)?.add(item.logicalId);
      }
    }
  }

  const stages: string[][] = [];
  const remaining = new Set(included);

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((logicalId) => dependencies.get(logicalId)?.size === 0)
      .sort();

    if (ready.length === 0) {
      const cycleMembers = [...remaining].sort().join(", ");
      throw new Error(`Dependency cycle detected among: ${cycleMembers}.`);
    }

    stages.push(ready);
    for (const logicalId of ready) {
      remaining.delete(logicalId);
      for (const dependent of dependents.get(logicalId) ?? []) {
        dependencies.get(dependent)?.delete(logicalId);
      }
    }
  }

  return stages;
}
