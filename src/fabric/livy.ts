import type { ApplyItemResult } from "../types";

const FABRIC_LIVY_API_VERSION = "2023-12-01";

export function buildLakehouseLivyApiEndpoints(
  fabricApiEndpoint: string,
  workspaceId: string,
  items: ApplyItemResult[],
): Record<string, string> {
  return Object.fromEntries(
    items.flatMap((item) => {
      if (
        item.type !== "Lakehouse" ||
        typeof item.physicalId !== "string" ||
        item.physicalId.length === 0
      ) {
        return [];
      }
      return [
        [
          item.logicalId,
          lakehouseLivyApiEndpoint(
            fabricApiEndpoint,
            workspaceId,
            item.physicalId,
          ),
        ],
      ];
    }),
  );
}

export function lakehouseLivyApiEndpoint(
  fabricApiEndpoint: string,
  workspaceId: string,
  lakehouseId: string,
): string {
  return `${fabricApiEndpoint.replace(/\/$/, "")}/v1/workspaces/${encodeURIComponent(
    workspaceId,
  )}/lakehouses/${encodeURIComponent(
    lakehouseId,
  )}/livyApi/versions/${FABRIC_LIVY_API_VERSION}`;
}
