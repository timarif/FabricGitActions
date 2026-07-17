import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertValidSparkCustomPoolDefinition,
  hashSparkCustomPoolDefinition,
  loadSparkCustomPoolDefinition,
} from "../src/fabric/spark-custom-pool-definition";

function createItem(poolYaml?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "fabric-spark-pool-"));
  if (poolYaml !== undefined) {
    const definition = path.join(root, "definition");
    mkdirSync(definition, { recursive: true });
    writeFileSync(path.join(definition, "pool.yaml"), poolYaml, "utf8");
  }
  return root;
}

const validDefinition = {
  nodeFamily: "MemoryOptimized" as const,
  nodeSize: "Small" as const,
  autoScale: {
    enabled: true,
    minNodeCount: 1,
    maxNodeCount: 2,
  },
  dynamicExecutorAllocation: {
    enabled: true,
    minExecutors: 1,
    maxExecutors: 1,
  },
};

describe("Spark custom pool definition", () => {
  it("loads definition/pool.yaml", () => {
    const itemDirectory = createItem(`
nodeFamily: MemoryOptimized
nodeSize: Small
autoScale:
  enabled: true
  minNodeCount: 1
  maxNodeCount: 2
dynamicExecutorAllocation:
  enabled: true
  minExecutors: 1
  maxExecutors: 1
`);

    expect(loadSparkCustomPoolDefinition(itemDirectory)).toEqual(
      validDefinition,
    );
  });

  it("hashes semantic definitions canonically", () => {
    const first = loadSparkCustomPoolDefinition(
      createItem(`
nodeFamily: MemoryOptimized
nodeSize: Small
autoScale: { enabled: true, minNodeCount: 1, maxNodeCount: 2 }
dynamicExecutorAllocation:
  enabled: true
  minExecutors: 1
  maxExecutors: 1
`),
    );
    const second = loadSparkCustomPoolDefinition(
      createItem(`
# formatting and key order do not affect the canonical definition hash
dynamicExecutorAllocation: { maxExecutors: 1, minExecutors: 1, enabled: true }
autoScale:
  maxNodeCount: 2
  minNodeCount: 1
  enabled: true
nodeSize: Small
nodeFamily: MemoryOptimized
`),
    );

    expect(hashSparkCustomPoolDefinition(first)).toBe(
      hashSparkCustomPoolDefinition(second),
    );
  });

  it("requires definition/pool.yaml", () => {
    expect(() =>
      loadSparkCustomPoolDefinition(createItem()),
    ).toThrow("requires definition/pool.yaml");
  });

  it("rejects pool definition files that are not deployed", () => {
    const itemDirectory = createItem(`
nodeFamily: MemoryOptimized
nodeSize: Small
autoScale: { enabled: true, minNodeCount: 1, maxNodeCount: 2 }
dynamicExecutorAllocation: { enabled: true, minExecutors: 1, maxExecutors: 1 }
`);
    writeFileSync(
      path.join(itemDirectory, "definition", "notes.txt"),
      "ignored",
      "utf8",
    );

    expect(() =>
      loadSparkCustomPoolDefinition(itemDirectory),
    ).toThrow("Unsupported Spark custom pool definition path");
  });

  it("rejects unsupported fields and enum values", () => {
    expect(() =>
      loadSparkCustomPoolDefinition(
        createItem(`
nodeFamily: ComputeOptimized
nodeSize: Tiny
description: unsupported
autoScale:
  enabled: true
  minNodeCount: 1
  maxNodeCount: 2
dynamicExecutorAllocation:
  enabled: true
  minExecutors: 1
  maxExecutors: 1
`),
      ),
    ).toThrow("Invalid Spark custom pool definition");
  });

  it("enforces the documented 200-node limit and integer minimums", () => {
    expect(() =>
      assertValidSparkCustomPoolDefinition({
        ...validDefinition,
        autoScale: {
          enabled: true,
          minNodeCount: 0,
          maxNodeCount: 201,
        },
      }),
    ).toThrow("Invalid Spark custom pool definition");
  });

  it("rejects inverted node and executor ranges", () => {
    expect(() =>
      assertValidSparkCustomPoolDefinition({
        ...validDefinition,
        autoScale: {
          enabled: true,
          minNodeCount: 3,
          maxNodeCount: 2,
        },
      }),
    ).toThrow("minNodeCount must be less than or equal");

    expect(() =>
      assertValidSparkCustomPoolDefinition({
        ...validDefinition,
        dynamicExecutorAllocation: {
          enabled: true,
          minExecutors: 2,
          maxExecutors: 1,
        },
      }),
    ).toThrow("minExecutors must be less than or equal");
  });
});
