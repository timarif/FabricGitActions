import { FABRIC_ITEM_TYPES } from "./types";

export const deploymentSchema = {
  $id: "https://github.com/fabric-deploy/schemas/deployment-v1alpha1.json",
  type: "object",
  additionalProperties: false,
  required: ["apiVersion", "kind", "metadata", "items"],
  properties: {
    apiVersion: { const: "fabric.deploy/v1alpha1" },
    kind: { const: "FabricDeployment" },
    metadata: {
      type: "object",
      additionalProperties: false,
      required: ["deploymentId"],
      properties: {
        deploymentId: {
          type: "string",
          minLength: 1,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        },
      },
    },
    workspace: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", minLength: 1 },
      },
    },
    items: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["logicalId", "type", "path"],
        properties: {
          logicalId: {
            type: "string",
            minLength: 1,
            pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
          },
          type: {
            type: "string",
            enum: [...FABRIC_ITEM_TYPES],
          },
          path: { type: "string", minLength: 1 },
          dependsOn: {
            type: "array",
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          desiredState: {
            const: "present",
          },
        },
      },
    },
  },
} as const;
