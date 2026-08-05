# Apache Airflow Jobs

Fabric Deploy manages Microsoft Fabric Apache Airflow Job items with
`type: ApacheAirflowJob`, including the public job definition and DAG/plugin
files.

The item API is generally available, but the Fabric file-management APIs used
for DAGs and plugins are currently beta.

## Deployment manifest

```yaml
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment
metadata:
  deploymentId: apache-airflow-example
workspace:
  id: ${var.FABRIC_WORKSPACE_ID}
items:
  - logicalId: helloAirflow
    type: ApacheAirflowJob
    path: items/airflow
```

```yaml
# items/airflow/item.yaml
displayName: FabricDeployHelloAirflow
description: Hello-world Apache Airflow Job managed by Fabric Deploy.
```

See [`examples/apache-airflow`](../examples/apache-airflow) for a complete
hello-world DAG.

## Definition structure

```text
items/airflow/
  item.yaml
  definition/
    apacheairflowjob-content.json
    .platform
    dags/
      hello_world.py
    plugins/
      custom_plugin.py
```

`apacheairflowjob-content.json` is required. It is the definition part that
the live Fabric API currently returns and accepts on round trip. `.platform`
is optional, but when present its type, display name, and description must
agree with `item.yaml`. DAG and plugin files are uploaded through the beta
Files API rather than sent as definition parts.

Microsoft's generated REST examples currently show
`ApacheAirflowJobV1.json`. Live validation in the reference workspace found
that create/update requests using that documented part fail with HTTP 400,
while the exported `apacheairflowjob-content.json` shape succeeds. Fabric
Deploy therefore uses the round-trippable exported shape and fails fast if the
documented filename is supplied.

After files are uploaded, `getDefinition` also returns DAG/plugin files as
definition parts. Fabric Deploy filters those parts from runtime-definition
hashing and reconciles their bytes exclusively through the Files API.

The job definition controls the Airflow runtime, dependencies, and compute:

```json
{
  "properties": {
    "type": "Airflow",
    "typeProperties": {
      "airflowProperties": {
        "airflowConfigurationOverrides": {},
        "airflowEnvironment": "FabricAirflowJob-1.0.0",
        "airflowEnvironmentVariables": {},
        "airflowRequirements": [],
        "airflowVersion": "2.10.5",
        "enableAADIntegration": true,
        "enableTriggerers": false,
        "packageProviderPath": "plugins",
        "pythonVersion": "3.12"
      },
      "computeProperties": {
        "computePool": "StarterPool",
        "computeSize": "Small",
        "enableAutoscale": false,
        "enableAvailabilityZones": true,
        "extraNodes": 0,
        "poolId": "00000000-0000-0000-0000-000000000000",
        "poolName": "Starter Pool (Auto Pausing)",
        "vnetEnabled": false
      }
    }
  }
}
```

Use values supported by the target workspace and Fabric capacity. Unlike
Spark executor configuration, Airflow capacity is configured through
`computeProperties` and its selected pool.

## DAG and plugin reconciliation

Fabric's beta Files API exposes raw file upload/download but no ETag, content
hash, version, or last-modified metadata. Fabric Deploy therefore stores a
reserved ownership ledger at:

```text
plugins/fabric-deploy-manifest.json
```

The ledger contains the paths and SHA-256 hashes from the last successful
apply. This produces the following safety behavior:

- Missing managed files are recreated.
- Changed managed files are updated only when the live file still matches the
  last successfully applied hash.
- Identical pre-existing files can be adopted into the ledger.
- A different pre-existing file that is not owned by Fabric Deploy blocks the
  plan instead of being overwritten.
- Removed files are deleted only when the ledger proves ownership and the live
  content has not changed externally.
- Unowned remote files are ignored and never pruned.

The reserved ledger path cannot be declared in source. Uploads are ordered
plugins first and DAGs second; removals are ordered DAGs first and plugins
second.

The live Files API currently returns HTTP 500 when `GET` targets a missing
file, rather than the documented 404. Fabric Deploy lists each managed parent
directory first and downloads content only for paths proven to exist.

Each DAG or plugin file must:

- Be under `definition/dags/` or `definition/plugins/`.
- Be no larger than 2 MB.
- Use a relative path without `.` or `..` segments.
- Contain valid UTF-8 when the file extension is `.py`.
- Not be a symbolic link.

## Lifecycle

| Operation | Method | Path |
| --- | --- | --- |
| List jobs | `GET` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs` |
| Create job | `POST` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs` |
| Get job | `GET` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}` |
| Update metadata | `PATCH` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}` |
| Get definition | `POST` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}/getDefinition` |
| Update definition | `POST` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}/updateDefinition?updateMetadata=false` |
| Get file | `GET` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}/files/{filePath}?beta=true` |
| Put file | `PUT` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}/files/{filePath}?beta=true` |
| Delete file | `DELETE` | `/v1/workspaces/{workspaceId}/apacheAirflowJobs/{jobId}/files/{filePath}?beta=true` |

Create, definition retrieval, metadata update, and definition update can return
Fabric long-running operations. Fabric Deploy creates and checkpoints a shell
job first, stages only the runtime definition part with metadata updates
disabled, then reconciles files. This avoids the live service's
create-with-definition failure while preserving crash-safe physical-item
proof. Fabric Deploy waits for completion and verifies the definition and
every managed file through read-back.

Updates checkpoint metadata and definition phases. If an apply is interrupted
during file reconciliation, recovery permits only per-file states that match
either the approved pre-state or exact desired content. Any other content drift
fails closed.

## Deletion

Apache Airflow Jobs support guarded soft deletion through
`desiredState: absent`. Deletion-only items do not require a definition
directory. Apply requires `allow-delete: "true"` and binds approval to the
exact item ID and metadata hash before using the generic Fabric item DELETE
endpoint.

## Authentication and limitations

The deployment identity needs Contributor or higher workspace access and
Fabric `Item.ReadWrite.All`. The beta file operations support users, service
principals, and managed identities.

Current Fabric limitations:

- The workspace must use a supported paid Fabric capacity.
- Private networks and virtual networks are not supported for Apache Airflow
  Jobs.
- DAG/plugin Files APIs are beta and require `?beta=true`.
- File PUT overwrites by path and has no documented multi-file transaction.
- Inline `airflowRequirements` is part of the job definition. Hot deployment
  into an already-running environment is a separate beta API and is not
  currently managed by Fabric Deploy.
