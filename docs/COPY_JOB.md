# Copy Job

Fabric Deploy manages Fabric Copy Jobs (`type: CopyJob`) through the GA
`/v1/workspaces/{workspaceId}/copyJobs` API. This document covers the
definition contract, constraints, safeguards, and recovery behaviour confirmed
by live API probe against the Fabric service.

> Live validation reference: `C:\Users\timarif\fabricLivyTest\live-output\copy-job-live-validation\result.json`
> (redacted evidence, outside the repository). Item: `2tva-copy-job-probe`.

---

## Definition structure

A Copy Job item directory must contain exactly one `definition/copyjob-content.json`
file. An optional `definition/.platform` file can be included to manage
`.platform` metadata.

```
items/copy-jobs/my-job/
  item.yaml
  definition/
    copyjob-content.json        # required
    .platform                   # optional — see "Platform metadata" below
```

### `copyjob-content.json`

The Fabric Copy Job **public definition** for **desired** (manifest) files
exposes only `properties.jobMode`. Only this field is managed by this action;
all other configuration is portal-managed and preserved.

#### Desired (manifest) file — managed surface only

```json
{
  "properties": {
    "jobMode": "Batch"
  }
}
```

**`properties.jobMode`** — required. Accepted values:

| Value | Behaviour |
| ----- | --------- |
| `Batch` | One-time or scheduled full/incremental copy |
| `CDC` | Change Data Capture continuous replication |

Extra top-level fields or extra `properties` fields in the desired file are
rejected at load time with a descriptive error — this is intentional to keep
the managed surface explicit.

#### Server readback — portal-managed fields preserved

When you read back an existing Copy Job definition via `getDefinition`, the
Fabric service returns a richer structure that includes portal-managed
configuration (source: [MS Learn Copy Job definition article](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/copyjob-definition)):

```json
{
  "properties": {
    "jobMode": "Batch",
    "source":      { "type": "...", "connectionSettings": { ... } },
    "destination": { "type": "...", "connectionSettings": { ... } },
    "policy":      { "timeout": "0.12:00:00" }
  },
  "activities": [
    {
      "id": "eeeeeeee-...",
      "properties": {
        "source":      { "datasetSettings": { ... } },
        "destination": { "writeBehavior": "Append", "datasetSettings": { ... } },
        "translator":  { "type": "TabularTranslator" },
        "typeConversionSettings": { ... }
      }
    }
  ]
}
```

The adapter **projects** server readback to the managed surface
(`properties.jobMode` only) before hashing. Portal-managed fields
(`activities`, `properties.source`, `properties.destination`,
`properties.policy`) are intentionally ignored in all hash comparisons and
are never overwritten by this action. Calling `updateDefinition` with only
`jobMode` would destroy them — so `updateDefinition` is never called for
existing Copy Jobs.

### `item.yaml`

```yaml
displayName: Bronze Batch Ingestion
description: Batch Copy Job for bronze layer ingestion   # optional
desiredState: present                                     # or absent
folderId: 11111111-1111-1111-1111-111111111111           # optional
```

`folderId` is accepted at creation. It is read by the adapter during workspace
discovery and passed in `CreateCopyJobRequest`. Folder moves after creation are
blocked — see [Folder semantics](#folder-semantics).

`description` can be updated through the Fabric `PATCH` endpoint (see
[Update behaviour](#update-behaviour)).

---

## Deployment manifest

```yaml
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment

metadata:
  deploymentId: data-platform

workspace:
  id: ${var.FABRIC_WORKSPACE_ID}

items:
  - logicalId: batchIngestion
    type: CopyJob
    path: items/copy-jobs/batch-ingestion
```

See [`examples/copy-job`](../examples/copy-job) for a complete runnable
example.

---

## API endpoints (live-confirmed)

| Operation | Method | Path | Response |
| --------- | ------ | ---- | -------- |
| Create | `POST` | `/v1/workspaces/{wid}/copyJobs` | `201` synchronous or `202` LRO |
| Get metadata | `GET` | `/v1/workspaces/{wid}/copyJobs/{id}` | `200` |
| Get definition | `POST` | `/v1/workspaces/{wid}/copyJobs/{id}/getDefinition` | `200` synchronous or `202` LRO |
| Update metadata | `PATCH` | `/v1/workspaces/{wid}/copyJobs/{id}` | `200` |
| Update definition | `POST` | `/v1/workspaces/{wid}/copyJobs/{id}/updateDefinition` | `200` synchronous or `202` LRO |
| Delete | `DELETE` | `/v1/workspaces/{wid}/copyJobs/{id}` | `200` |
| List (dedicated) | `GET` | `/v1/workspaces/{wid}/copyJobs` | `200` (omits `folderId`) |
| List (generic) | `GET` | `/v1/workspaces/{wid}/items?type=CopyJob` | `200` (includes `folderId`) |

`UpdateCopyJobRequest` (`PATCH` body) accepts only `displayName` and
`description`. There is no `folderId` field.

---

## Immutable field: `jobMode`

`jobMode` is set at creation and is **immutable**. Changing `jobMode` on a
running CDC Copy Job would destroy its replication checkpoint state and is
therefore data-destructive.

**Planning behaviour when `jobMode` drifts:**

```
action: blocked
reason: "Copy Job 'MyJob' has jobMode 'CDC' but the manifest requests 'Batch'.
         jobMode is immutable after creation: changing it destroys CDC sync
         tracking state. Recreate the Copy Job with the desired jobMode to
         resolve this drift."
```

`resetCopyJob` is **never called automatically** by this action. Resolving a
`jobMode` drift requires manually deleting the existing Copy Job and redeploying
with a new `Batch` or `CDC` choice.

---

## Update behaviour

Only `displayName` and `description` can be updated on an existing Copy Job;
`jobMode` is immutable and `updateDefinition` is **never called for existing
jobs**.

The adapter's `update()` method is **unconditionally PATCH-only** for all
existing Copy Jobs, with or without `definition/.platform`:

1. Issues a single `PATCH` with the `displayName`/`description` payload.
2. Verifies the result through a `GET + getDefinition` readback.

Calling `updateDefinition` on an existing Copy Job would overwrite
portal-managed activities, connections, and policies with the minimal public
schema (`{ "properties": { "jobMode": "..." } }`), permanently destroying
configuration that cannot be recovered programmatically. This is prevented
unconditionally.

### `.platform` drift for existing Copy Jobs

If the hashed `.platform` content in the desired definition differs from what
the service returns, the plan produces **`blocked`**, not `update`. There is no
safe programmatic path to apply `.platform` changes to an existing Copy Job
without calling `updateDefinition`. `.platform` is therefore **validation and
read-back only** for existing items; drift must be resolved by recreating the
Copy Job.

```
action: blocked
reason: "Copy Job 'MyJob' has a definition/platform mismatch that cannot be
         applied without calling updateDefinition, which would erase all
         portal-managed activities and connections. Recreate the Copy Job to
         apply this change."
```

---

## Folder semantics

`folderId` is accepted in `CreateCopyJobRequest` (live-confirmed) and is
stored on the item. After creation, folder moves are **blocked** because
`UpdateCopyJobRequest` has no `folderId` field.

**Planning behaviour when desired folder differs from current folder:**

```
action: blocked
reason: "Copy Job 'MyJob' is in folder 'old-folder' but the manifest targets
         'new-folder'. The Fabric API does not support moving Copy Jobs between
         folders (UpdateCopyJobRequest has no folderId field); recreate the
         Copy Job in the correct folder to resolve this."
```

### Workspace-wide identity discovery

The adapter uses the **generic** `/items?type=CopyJob` endpoint for discovery
(not the dedicated `/copyJobs` endpoint). The dedicated endpoint omits `folderId`
from list responses, making folder-scoped identity checks unreliable.

If a Copy Job with the same `displayName` exists in a **different** folder than
the desired folder, the plan returns `blocked` rather than silently creating a
duplicate:

```
action: blocked
reason: "Copy Job 'MyJob' was not found in the target folder 'new-folder' but
         a Copy Job with the same display name exists in: old-folder. Creating
         a new Copy Job would produce an ambiguous identity. Relocate the
         existing Copy Job to the desired folder or rename one of them."
```

Root-folder semantics: an absent or `undefined` `folderId` is treated as the
workspace root and compares equal to other absent values.

---

## Platform metadata (`.platform`)

Optional `definition/.platform` manages `.platform` metadata when present.
The `.platform` structure must follow the Fabric v2 platform properties schema.

### `config.logicalId` sentinel policy

`config.logicalId` is **server-managed** for items deployed without Git
integration. Live evidence: the Fabric service always returns
`"00000000-0000-0000-0000-000000000000"` (the zero GUID) for non-Git-integrated
Copy Jobs.

**Accepted values:** absent field, or exactly `"00000000-0000-0000-0000-000000000000"`.

**Rejected values:** any non-zero GUID. These belong to Git-integrated items
and are server-assigned; clients cannot set them. The action fails closed with:

```
Error: Copy Job .platform config.logicalId must be absent or the zero GUID
"00000000-0000-0000-0000-000000000000". Non-zero values are assigned by Fabric
when the item is integrated with a Git repository and are server-managed —
they cannot be applied by this action.
```

The zero GUID and the absent field hash identically (both are stripped before
hashing) to prevent spurious drift between items with and without the sentinel.

### Sensitivity labels

`sensitivityLabelId` in `.platform` is rejected. Manage sensitivity labels
outside the definition deployment.

---

## Guarded deletion

Copy Jobs support `desiredState: absent`. Live-confirmed: `DELETE` returns
`200` synchronously.

```yaml
# deployment.yaml
items:
  - logicalId: retiredJob
    type: CopyJob
    path: items/copy-jobs/retired-job
    desiredState: absent
```

```yaml
# items/copy-jobs/retired-job/item.yaml
displayName: Retired Copy Job
desiredState: absent
```

Deletion-only Copy Job items do not require a `definition/` directory.

**Required safeguards** (both must be explicitly set to `"true"`):

```yaml
with:
  allow-delete: "true"
```

Apply preflights that the exact approved physical ID is still present, performs
the DELETE, and verifies the ID is absent. A new Copy Job with the same name
that appears after the plan is approved is never deleted in place of the
original.

---

## Safeguards summary

| Safeguard input | Required for |
| --------------- | ------------ |
| `allow-create: "true"` | Creating a new Copy Job |
| `allow-update: "true"` | Updating an existing Copy Job (`displayName`, `description`, or `.platform` definition) |
| `allow-delete: "true"` | Deleting a Copy Job (`desiredState: absent`) |

All safeguards default to `false`. No `allow-copy-job-data-loss` or
`resetCopyJob` safeguard is implemented: `jobMode` drift is always `blocked`,
never executed.

---

## Checkpoint and recovery

| Scenario | Recovery path |
| -------- | ------------- |
| Create interrupted before `201`/`202` accepted | **Do NOT automatically reissue** — the POST may have already reached Fabric. A duplicate may exist during eventual-consistency propagation before it appears in list responses. Wait for the item to become visible in workspace discovery, then verify it matches the desired identity. If no item appears after sufficient time, confirm absence manually via both the dedicated and generic list endpoints before creating. When in doubt, prefer manual verification over automated retry to avoid creating an orphaned duplicate. |
| Create `202` accepted, interrupted before verification | Poll the accepted operation reference; verify readback once the operation completes |
| Metadata PATCH interrupted | Re-examine live state: if metadata already matches desired → skip to verify path; otherwise re-issue PATCH (idempotent) |
| Delete interrupted before `DELETE` issued | Re-issue `DELETE` after confirming the exact approved ID is still present |
| Delete `DELETE` issued, interrupted before verification | Re-verify absence of exact approved ID |

---

## Not supported in this increment

- `resetCopyJob` — never called automatically; manual recreation is required for `jobMode` changes.
- On-demand job execution — use the Data Pipeline `run-pipeline` mode instead.
- Schedules and triggers — managed through the Fabric portal.
- `defaultIdentity`, audit/volatile fields, and sensitivity labels.
- **Activity-level definition management** — `activities`, `properties.source`, `properties.destination`, and `properties.policy` are fully portal-managed. They are preserved on every plan/apply and never overwritten. Declare only `properties.jobMode` in the desired `copyjob-content.json`; the adapter projects portal-managed fields away before comparing hashes.
