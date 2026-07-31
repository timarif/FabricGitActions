# Ontology

Fabric Deploy manages Microsoft Fabric Ontologies with `type: Ontology`.
Ontology REST APIs are currently in preview, so the supported contract is
deliberately narrow and fail-closed.

## Deployment manifest

```yaml
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: ontology-example
workspace:
  id: ${var.FABRIC_WORKSPACE_ID}
items:
  - logicalId: assetOntology
    type: Ontology
    path: items/ontology
```

```yaml
# items/ontology/item.yaml
displayName: FabricDeployOntologySample
description: Managed by Fabric Deploy.
```

Ontology display names must begin with a letter, contain only letters, numbers,
and underscores, and be at most 99 characters.

See [`examples/ontology`](../examples/ontology) for a complete definition.

## Definition structure

Present Ontologies require a `definition/` directory:

```text
items/ontology/
  item.yaml
  definition/
    definition.json
    .platform
    EntityTypes/
      1001/
        definition.json
        DataBindings/
          source.json
        Documents/
          document.json
        Overviews/
          definition.json
        ResourceLinks/
          definition.json
    RelationshipTypes/
      3001/
        definition.json
        Contextualizations/
          contextualization.json
```

`definition/definition.json` must contain an empty JSON object:

```json
{}
```

`.platform` must contain metadata whose `type`, `displayName`, and optional
`description` agree with `item.yaml`:

```json
{
  "metadata": {
    "type": "Ontology",
    "displayName": "FabricDeployOntologySample",
    "description": "Managed by Fabric Deploy."
  }
}
```

Supported optional paths are:

- `EntityTypes/{ID}/definition.json`
- `EntityTypes/{ID}/DataBindings/*.json`
- `EntityTypes/{ID}/Documents/*.json`
- `EntityTypes/{ID}/Overviews/definition.json`
- `EntityTypes/{ID}/ResourceLinks/definition.json`
- `RelationshipTypes/{ID}/definition.json`
- `RelationshipTypes/{ID}/Contextualizations/*.json`

Entity and relationship directory IDs must be positive signed 64-bit integers.
The `id` in each entity or relationship `definition.json` must exactly match
its directory ID. Unsupported paths, duplicate parts, malformed JSON, and
non-inline payloads are rejected before planning.

## Drift detection

Ontology definitions use Fabric's JSON format. The REST examples omit the
optional `definition.format` field, so the action also omits it from create
and update requests. Every JSON part is canonicalized before hashing, so
whitespace and object property order do not create drift.

Fabric can add `.platform.config.logicalId` during service read-back. That
service-managed value is excluded from the definition hash. The action hashes
the `.platform` type and display name, while item display name and description
are independently compared through Ontology metadata.

Live validation also confirmed that Fabric adds a top-level `$schema` to
entity definitions and materializes omitted optional entity fields such as
`untypedProperties: []`. The canonicalizer removes generated schema metadata
and normalizes those documented defaults before hashing.

If `getDefinition` is blocked by an encrypted sensitivity label or an
unsupported service state, planning returns `blocked` instead of treating the
definition as absent or overwriting it.

## Lifecycle

| Operation | Method | Path |
| --- | --- | --- |
| List | `GET` | `/v1/workspaces/{workspaceId}/ontologies` |
| Get | `GET` | `/v1/workspaces/{workspaceId}/ontologies/{ontologyId}` |
| Create | `POST` | `/v1/workspaces/{workspaceId}/ontologies` |
| Update metadata | `PATCH` | `/v1/workspaces/{workspaceId}/ontologies/{ontologyId}` |
| Get definition | `POST` | `/v1/workspaces/{workspaceId}/ontologies/{ontologyId}/getDefinition` |
| Update definition | `POST` | `/v1/workspaces/{workspaceId}/ontologies/{ontologyId}/updateDefinition?updateMetadata=true` |

Create and definition operations support synchronous responses or Fabric
long-running operations. The action waits for completion and verifies metadata
and the complete managed definition through read-back.

Disposable live validation confirmed create through an LRO, immediate no-op
read-back, metadata plus entity-property update, a second no-op plan, generic
soft deletion, exact-ID `404` absence, and an absent no-op replan.

Updates checkpoint the following phases:

| Phase | Meaning |
| --- | --- |
| `metadata-submitting` | The metadata PATCH is about to be dispatched |
| `metadata-updated` | Metadata was accepted and definition staging is next |
| `definition-staged` | Definition staging completed and verification is next |

Recovery compares the live definition hash with the approved pre-state,
checkpointed staged state, or exact desired state. Unproven drift fails closed
instead of redispatching an ambiguous update.

## Deletion

Ontology supports guarded soft deletion:

```yaml
# deployment.yaml
items:
  - logicalId: retiredOntology
    type: Ontology
    path: items/ontology/retired
    desiredState: absent
```

```yaml
# items/ontology/retired/item.yaml
displayName: RetiredOntology
desiredState: absent
```

Deletion-only items do not require a definition directory. Apply requires
`allow-delete: "true"`, binds approval to the exact item ID and identity hash,
checkpoints intent before dispatch, and confirms exact-ID absence afterward.
The generic Fabric item DELETE endpoint is used without `hardDelete`.

## Authentication and permissions

Ontology operations use the normal Fabric API audience:

```text
https://api.fabric.microsoft.com/.default
```

The deployment identity needs workspace access and the Fabric
`Item.ReadWrite.All` permission for mutations and definition reads. Creating
an Ontology requires Contributor or higher workspace access. User, service
principal, and managed identity authentication follow the same Fabric client
configuration as other action adapters.

## Current limitations

- Ontology is a preview Fabric API and may change.
- Folder placement is rejected because the preview create contract does not
  document `folderId`.
- Logical source binding materialization is not yet implemented. Data binding
  JSON must contain explicit physical Fabric workspace and item IDs.
- Sensitivity labels cannot be declared in `.platform`.
