# DataAgent Item Support

## Overview

The `DataAgent` item type represents a Microsoft Fabric AI-powered data agent.
Deploy, configure, and update Data Agents as code using `fabric-deploy`.

> **GA status**: The `/v1/workspaces/{id}/dataAgents` REST endpoints are
> Generally Available. The `DataAgent` adapter uses only GA endpoints.

---

## REST API summary

| Operation            | Method | Path                                                          | Response        |
|----------------------|--------|---------------------------------------------------------------|-----------------|
| List agents          | GET    | `/v1/workspaces/{id}/dataAgents`                              | 200 synchronous |
| Get agent            | GET    | `/v1/workspaces/{id}/dataAgents/{agentId}`                    | 200 synchronous |
| Create agent         | POST   | `/v1/workspaces/{id}/dataAgents`                              | 201 sync (shell create used by adapter); 202 LRO when definition is sent in create body |
| PATCH metadata       | PATCH  | `/v1/workspaces/{id}/dataAgents/{agentId}`                    | 200 synchronous |
| Delete agent         | DELETE | `/v1/workspaces/{id}/dataAgents/{agentId}`                    | 200 synchronous |
| Get definition       | POST   | `/v1/workspaces/{id}/dataAgents/{agentId}/getDefinition`      | **202 LRO**     |
| Update definition    | POST   | `/v1/workspaces/{id}/dataAgents/{agentId}/updateDefinition`   | 202 LRO         |

**Live-confirmed behaviors** (probed against Fabric workspace):

* **Create shell** — `POST /dataAgents` with only `displayName` → **201 synchronous** (no LRO required).
* **getDefinition** — Always **202 LRO** (even for freshly created shells). Poll the operation URL until `status: Succeeded`.
* **Shell server-generated parts** — After creating a shell agent, `getDefinition` returns:
  - `Files/Config/data_agent.json`
  - `Files/Config/draft/stage_config.json` with `aiInstructions: null`
  - `.platform` (git-integration metadata, root-level, NOT under `Files/Config/`)
* **PATCH** → 200 synchronous; response body includes `"properties": {}`.
* **DELETE** → 200 synchronous (available at the REST layer, but declarative `desiredState: absent` is not yet supported by this release of `fabric-deploy`).

---

## Definition directory layout

```
items/my-agent/
├── item.yaml                               # displayName, description (required)
└── Files/
    └── Config/
        ├── data_agent.json                 # Required when definition present
        └── draft/
            ├── stage_config.json           # Optional — AI instructions
            └── <type>-<name>/              # Optional datasource directories
                ├── datasource.json
                └── fewshots.json
```

The following paths are **server-managed** and must **never** be authored:

* `Files/Config/published/**` — written by the Fabric publish operation
* `Files/Config/publish_info.json` — server metadata
* `.platform` — git-integration file, returned by `getDefinition` but excluded from authoring

## Draft file ownership

User-authored draft files are **authoritative**. If you add a datasource or fewshots file
to your definition, it will be deployed. If you later **remove** it from the definition
directory, the next `fabric-deploy` run will delete that file from the agent on the server.

**Service-generated defaults are preserved**: The server automatically creates a
`Files/Config/draft/stage_config.json` with `aiInstructions: null` for every new agent.
This default file is excluded from drift detection — you do not need to author it unless
you want to set custom AI instructions.

| File | Ownership | Remove from definition = |
|------|-----------|--------------------------|
| `Files/Config/data_agent.json` | User-authored | Required — cannot be removed |
| `Files/Config/draft/stage_config.json` | User-authored if present | Removed from server on next update |
| `Files/Config/draft/*/datasource.json` | User-authored | Removed from server on next update |
| `Files/Config/draft/*/fewshots.json` | User-authored | Removed from server on next update |
| `Files/Config/draft/stage_config.json` (server default) | Service-generated | Ignored — not counted as drift |

---

## item.yaml

```yaml
displayName: My Data Agent
description: AI assistant for querying sales data
```

---

## Files/Config/data_agent.json (required when definition is provided)

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/dataAgent/2.1.0/schema.json"
}
```

---

## Files/Config/draft/stage_config.json (optional)

Provides the AI system instructions for the agent.

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/fabric/item/dataAgent/definition/stageConfiguration/1.0.0/schema.json",
  "aiInstructions": "You are a helpful data assistant."
}
```

> **Note**: The server creates a default `stage_config.json` with `aiInstructions: null`. The adapter automatically excludes this server default from drift detection — you do not need to include it in your definition unless you want to set custom instructions.

---

## Shell agents (no definition)

A DataAgent can be managed without providing a definition directory (`Files/Config/`).
This creates a "shell" agent — only `displayName` and `description` are managed.

```yaml
# item.yaml
displayName: Shell Agent
description: Placeholder agent — no AI instructions yet
```

No `Files/Config/` directory = shell mode. The server auto-generates default definition parts
and the tool only tracks metadata changes.

## Deletion (desiredState: absent)

> **Not yet supported in this release.**
>
> DataAgent deletion requires definition-aware drift proof before it can be safely
> implemented. Setting `desiredState: absent` in `item.yaml` will cause manifest loading
> to fail with a clear error. Use the Fabric portal to delete Data Agents manually.

---

## Drift detection and hash

The definition hash covers only **authored** parts:
- `Files/Config/data_agent.json`
- `Files/Config/draft/**` (stage_config, datasources, fewshots)

**Excluded** from hash (server-managed):
- `Files/Config/published/**`
- `Files/Config/publish_info.json`
- `.platform`

### Comparison behavior

When the user provides only `data_agent.json` (no `stage_config.json`), the server
still returns `stage_config.json`. The adapter excludes the server-generated blank
stage config from drift detection, so shell defaults do not cause spurious `update`
actions. Current-only **user-authored** draft files are still counted as drift, which
lets the deployer remove datasources or fewshots declaratively.

---

## deployment.yaml example

```yaml
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment

metadata:
  deploymentId: ai-agents

items:
  # Full agent with AI instructions
  - logicalId: salesAssistant
    type: DataAgent
    path: items/data-agents/sales-assistant

  # Shell agent — metadata-only management
  - logicalId: shellAgent
    type: DataAgent
    path: items/data-agents/shell-agent
    dependsOn:
      - salesAssistant
```

See [`examples/data-agent/`](../examples/data-agent) for a complete working example.

---

## Checkpoint recovery

DataAgent operations use checkpoint-safe recovery phases:

| Phase                   | Meaning                                             |
|-------------------------|-----------------------------------------------------|
| `metadata-submitting`   | PATCH request about to be dispatched                |
| `metadata-updated`      | PATCH completed; definition update next             |
| `definition-submitting` | updateDefinition request about to be dispatched     |
| `definition-staged`     | updateDefinition LRO resolved; verify next          |

### Synchronous 201 create recovery
On synchronous shell creates (201), the adapter checkpoints the exact `physicalId`
plus a hash of the server-returned shell definition **before** it stages the authored
definition. On recovery, the engine verifies identity (displayName, folderId, type)
**and** the shell definition hash fail-closed before resuming definition staging.

### LRO 202 create recovery
On asynchronous 202 create dispatches, the `operationId` and `location` are
checkpointed. On recovery, after `waitForOperation` returns the item ID, the engine:
1. Verifies identity (displayName, folderId, type) fail-closed.
2. Fetches the current definition and verifies it is still an **untouched shell**
   (only `data_agent.json` with a valid schema reference and a service-default
   `stage_config.json` with `aiInstructions: null`). Any external modification
   (datasource added, aiInstructions set, etc.) causes recovery to fail closed.
3. Only then stages the desired definition.

### No-op adoption — always refused
DataAgent recovery **never** adopts a live no-op item after a create dispatch failure
or a resume-create failure. If a same-name agent appears on the server after a
failed dispatch, the operation is NOT considered recovered. The checkpoint is
preserved (unless the LRO definitively failed and the item is absent), and the
original error is re-thrown. The operator must investigate before retrying.

This differs from some other item types (e.g. SemanticModel) which fall back to
no-op adoption under certain proof conditions. DataAgent requires explicit
`physicalId+shellDefinitionHash` (sync) or LRO identity+shell-content proof (LRO).

On update recovery, the apply engine inspects `stagedDefinitionHash` in the
checkpoint to determine whether the definition update succeeded before the
process was interrupted.

---

## Immutable properties

| Property      | Mutable? | Notes                                              |
|---------------|----------|----------------------------------------------------|
| `displayName` | ✅ Yes   | PATCH endpoint                                     |
| `description` | ✅ Yes   | PATCH endpoint                                     |
| `folderId`    | ❌ No    | Fabric does not support folder moves; plan returns `blocked` |
| `type`        | ❌ N/A   | Always `"DataAgent"`                               |

---

## Known limitations (v1)

* **No logical reference resolution** for `datasource.json` `artifactId` fields.
  Users must provide physical IDs directly in datasource definitions.
* **No deletion support (this release)** — `desiredState: absent` is not yet implemented for DataAgent.
  Definition-aware deletion drift proof is required. Use the Fabric portal for manual deletion.
* **No preview staging/publish API support** — `Files/Config/published/**` and
  the Fabric publish workflow are intentionally excluded from authoring scope.

---

## Service principal compatibility

All DataAgent REST endpoints support service-principal and managed-identity
authentication via bearer token. The `DataAgentAdapter` uses the same
`FabricClient` as all other adapters — no additional configuration needed.
