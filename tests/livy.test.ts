import { describe, expect, it } from "vitest";

import {
  buildLakehouseLivyApiEndpoints,
  lakehouseLivyApiEndpoint,
} from "../src/fabric/livy";

describe("Lakehouse Livy API outputs", () => {
  it("builds the Lakehouse-scoped Fabric Livy endpoint", () => {
    expect(
      lakehouseLivyApiEndpoint(
        "https://api.fabric.microsoft.com/",
        "workspace-id",
        "lakehouse-id",
      ),
    ).toBe(
      "https://api.fabric.microsoft.com/v1/workspaces/workspace-id/lakehouses/lakehouse-id/livyApi/versions/2023-12-01",
    );
  });

  it("returns endpoints only for deployed Lakehouses", () => {
    expect(
      buildLakehouseLivyApiEndpoints(
        "https://api.fabric.microsoft.com",
        "workspace-id",
        [
          {
            logicalId: "bronze",
            type: "Lakehouse",
            action: "create",
            status: "created",
            physicalId: "lakehouse-id",
            durationMs: 1,
          },
          {
            logicalId: "notebook",
            type: "Notebook",
            action: "create",
            status: "created",
            physicalId: "notebook-id",
            durationMs: 1,
          },
        ],
      ),
    ).toEqual({
      bronze:
        "https://api.fabric.microsoft.com/v1/workspaces/workspace-id/lakehouses/lakehouse-id/livyApi/versions/2023-12-01",
    });
  });
});
