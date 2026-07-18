import { describe, expect, it } from "vitest";

import { buildDeploymentStages } from "../src/graph";

describe("deployment graph", () => {
  it("groups independent items and orders dependent items", () => {
    const stages = buildDeploymentStages([
      { logicalId: "lakehouse", type: "Lakehouse", path: "lakehouse" },
      { logicalId: "environment", type: "Environment", path: "environment" },
      {
        logicalId: "notebook",
        type: "Notebook",
        path: "notebook",
        dependsOn: ["lakehouse", "environment"],
      },
      {
        logicalId: "pipeline",
        type: "DataPipeline",
        path: "pipeline",
        dependsOn: ["notebook"],
      },
    ]);

    expect(stages).toEqual([
      ["environment", "lakehouse"],
      ["notebook"],
      ["pipeline"],
    ]);
  });

  it("rejects dependency cycles", () => {
    expect(() =>
      buildDeploymentStages([
        {
          logicalId: "one",
          type: "Notebook",
          path: "one",
          dependsOn: ["two"],
        },
        {
          logicalId: "two",
          type: "Notebook",
          path: "two",
          dependsOn: ["one"],
        },
      ]),
    ).toThrow("Dependency cycle detected");
  });

  it("deletes dependents before their absent dependencies", () => {
    const stages = buildDeploymentStages([
      {
        logicalId: "environment",
        type: "Environment",
        path: "environment",
        desiredState: "absent",
      },
      {
        logicalId: "notebook",
        type: "Notebook",
        path: "notebook",
        desiredState: "absent",
        dependsOn: ["environment"],
      },
      {
        logicalId: "pipeline",
        type: "DataPipeline",
        path: "pipeline",
        desiredState: "absent",
        dependsOn: ["notebook"],
      },
    ]);

    expect(stages).toEqual([
      ["pipeline"],
      ["notebook"],
      ["environment"],
    ]);
  });

  it("keeps present deployment stages ahead of reverse deletion stages", () => {
    const stages = buildDeploymentStages([
      {
        logicalId: "newNotebook",
        type: "Notebook",
        path: "new",
      },
      {
        logicalId: "oldEnvironment",
        type: "Environment",
        path: "old-environment",
        desiredState: "absent",
      },
      {
        logicalId: "oldNotebook",
        type: "Notebook",
        path: "old-notebook",
        desiredState: "absent",
        dependsOn: ["oldEnvironment"],
      },
    ]);

    expect(stages).toEqual([
      ["newNotebook"],
      ["oldNotebook"],
      ["oldEnvironment"],
    ]);
  });
});
