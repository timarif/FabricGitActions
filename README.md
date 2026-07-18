# Microsoft Fabric Deploy Action

A GitHub Marketplace action for declarative Microsoft Fabric deployments, with
an initial focus on Data Engineering workloads.

> **Current status:** Phases 1 and 2 are complete. Phase 3 now includes
> managed workspace provisioning plus Environment, Notebook, Spark Job
> Definition, Data Pipeline, and workspace custom Spark pool deployment in
> addition to Lakehouse deployment. These adapters support authenticated
> planning and guarded create/update/no-op apply with approved-plan binding,
> drift detection, checkpoints, and result artifacts. See
> [the roadmap](docs/ROADMAP.md).

## Initial workload scope

- Workspace
- Lakehouse
- Lakehouse table DDL
- Environment
- Notebook
- Workspace custom Spark pool
- Spark Job Definition
- Data Pipeline

## Quickstart

```yaml
permissions:
  contents: read

steps:
  - uses: actions/checkout@v5

  - uses: your-organization/fabric-deploy@v1
    with:
      mode: plan
      manifest: fabric/deployment.yaml
      environment: dev
      workspace-id: ${{ vars.FABRIC_WORKSPACE_ID }}
```

The action writes a machine-readable plan and a GitHub job summary. The plan
contains the validated deployment order, observed Fabric state, source commit,
and a deterministic hash used to bind approval to an exact deployment.

## Managed workspace provisioning

To create or manage the target workspace, declare its desired properties at
the top level instead of supplying only an ID:

```yaml
workspace:
  displayName: tva-Analytics
  description: Managed by Fabric Deploy
  capacityId: ${var.FABRIC_CAPACITY_ID}

items: []
```

The `workspace-id` action input remains authoritative when supplied. An
explicit ID is never replaced by name discovery, and a missing explicit ID is
blocked rather than recreated.

Workspace creation is a separate approved bootstrap. The first plan/apply
creates the workspace, verifies any capacity assignment, returns
`workspace-id`, and sets `requires-item-replan` to `true`. Generate and approve
a fresh plan to deploy child items into that immutable physical workspace ID.
Existing managed workspaces can update metadata or capacity and deploy child
items in the same approved apply.

```yaml
- id: provision
  uses: your-organization/fabric-deploy@v1
  with:
    mode: apply
    manifest: fabric/deployment.yaml
    approved-plan-file: approved/fabric-plan.json
    auth-mode: oidc
    tenant-id: ${{ vars.FABRIC_TENANT_ID }}
    client-id: ${{ vars.FABRIC_CLIENT_ID }}
    variables: >-
      {"FABRIC_CAPACITY_ID":"${{ vars.FABRIC_CAPACITY_ID }}"}
    allow-workspace-create: "true"
    allow-capacity-assignment: "true"
```

Workspace safeguards are independent and default to `false`:

- `allow-workspace-create`
- `allow-workspace-update`
- `allow-capacity-assignment`

The deployment identity needs the tenant setting that permits workspace
creation. Capacity assignment additionally requires Workspace Admin plus
contributor or administrator permission on the target capacity. Workspace
deletion and capacity unassignment are intentionally unsupported.

Without authentication, `plan` is offline and reports item actions as
`unknown`. With Fabric authentication configured, Lakehouses, Environments, Notebooks,
LakehouseTables bundles, Spark Job Definitions, Data Pipelines, and workspace custom Spark pools are
classified as `create`, `update`, `no-op`, or `blocked`; later workload
adapters remain `unknown`.

## Authenticated Fabric plan with GitHub OIDC

Configure a federated credential on the deployment application's Entra service
principal, enable service principals for Fabric APIs, and grant the application
access to the target workspace.

```yaml
permissions:
  contents: read
  id-token: write

steps:
  - uses: actions/checkout@v5

  - uses: your-organization/fabric-deploy@v1
    with:
      mode: plan
      manifest: fabric/deployment.yaml
      environment: dev
      workspace-id: ${{ vars.FABRIC_WORKSPACE_ID }}
      auth-mode: oidc
      tenant-id: ${{ vars.FABRIC_TENANT_ID }}
      client-id: ${{ vars.FABRIC_CLIENT_ID }}
```

A service-principal secret can be used as a fallback:

```yaml
with:
  auth-mode: service-principal-secret
  tenant-id: ${{ vars.FABRIC_TENANT_ID }}
  client-id: ${{ vars.FABRIC_CLIENT_ID }}
  client-secret: ${{ secrets.FABRIC_CLIENT_SECRET }}
```

## Guarded core data engineering apply

Generate an authenticated plan, preserve it as an immutable artifact, then pass
that exact file to a separate apply job:

```yaml
- id: deploy
  uses: your-organization/fabric-deploy@v1
  with:
    mode: apply
    manifest: fabric/deployment.yaml
    environment: dev
    workspace-id: ${{ vars.FABRIC_WORKSPACE_ID }}
    auth-mode: oidc
    tenant-id: ${{ vars.FABRIC_TENANT_ID }}
    client-id: ${{ vars.FABRIC_CLIENT_ID }}
    approved-plan-file: approved/fabric-plan.json
    allow-create: "true"
    allow-update: "false"
    allow-lakehouse-table-create: "true"
    return-livy-api-endpoint: "true"
    plan-file: apply-output/current-plan.json
    checkpoint-file: apply-output/checkpoint.json
    result-file: apply-output/result.json
```

When `return-livy-api-endpoint` is enabled, `livy-api-endpoints` returns a
JSON map keyed by Lakehouse logical ID. If the deployment contains exactly one
Lakehouse, `livy-api-endpoint` also returns its Lakehouse-scoped endpoint
directly.

Apply recomputes the current authenticated plan and rejects:

- Modified or malformed approved plans
- Source commit, source content, environment, workspace, or graph mismatches
- Fabric state drift after approval
- Creates or updates without their explicit allow flag
- Blocked, unknown, deletion, or unsupported workload actions

When the approved workspace action is `create`, blocked child items are not
mutated; the successful workspace bootstrap explicitly requires a fresh item
plan.

All items are preflighted before the first mutation. A create intent is
checkpointed before POST; accepted `202` operations and returned physical IDs
are then checkpointed before read-back verification and resumed without
reissuing the create. Update intents are checkpointed before PATCH and
reconciled without repeating an ambiguously completed update. Expired operation
references reconcile against live state. The result file is initialized before
Fabric operations and finalized for failures that occur during authentication
or discovery. Explicitly failed create operations are cleared only after fresh
discovery confirms the item is still absent; ambiguous timeouts remain
checkpointed. Environment recovery also resumes interrupted definition updates
and publishes against the discovered physical item. Recovery either requires
the exact approved pre-state or proves that the staged definition marker,
staged definition hash, and managed item metadata all still match the approved
deployment. Environment updates additionally checkpoint metadata, definition,
publish, and marker-cleanup phases so retries can validate the exact
intermediate state before continuing. Notebook definition updates checkpoint
their metadata and definition phases and fail closed when an interrupted
update cannot be proven safe to resume.
`plan-hash` identifies the freshly generated `plan-file`;
`approved-plan-hash` identifies the plan authorized for apply. Deletion is not
implemented.

## Manifest

```yaml
apiVersion: fabric.deploy/v1alpha1
kind: FabricDeployment

metadata:
  deploymentId: sales-platform

items:
  - logicalId: bronzeLakehouse
    type: Lakehouse
    path: items/lakehouses/bronze

  - logicalId: ingestOrders
    type: Notebook
    path: items/notebooks/ingest-orders
    dependsOn:
      - bronzeLakehouse
```

Each item directory requires an `item.yaml`:

```yaml
displayName: Ingest Orders
description: Loads raw orders into the Bronze Lakehouse
desiredState: present

references:
  defaultLakehouse: bronzeLakehouse
```

References and item-ID bindings must target known logical IDs and must also be
declared in `dependsOn`.

Definition-bearing workloads are structurally validated:

| Type | Required definition |
| --- | --- |
| Lakehouse | `item.yaml` |
| LakehouseTables | `definition/tables.yaml` plus every declared `definition/tables/*.sql` file |
| Environment | `definition/environment.yml`; optional `Sparkcompute.yml`, `.platform`, and custom libraries |
| Notebook | Exactly one `.py`, `.scala`, `.r`, `.sql`, or `.ipynb` file under `definition/`; optional `.platform` |
| Spark Job Definition | Exactly one `definition/main.py` or `definition/main.scala`; optional `SparkJobDefinitionV1.json`, `.platform`, and files under `definition/libs/` |
| Data Pipeline | Valid JSON object at `definition/pipeline-content.json` |
| Workspace custom Spark pool | `definition/pool.yaml` with node family, node size, autoscale, and dynamic executor allocation settings |

### Lakehouse table DDL

`LakehouseTables` is a declarative bundle, not a Fabric item. Its `item.yaml`
must set `desiredState: present`, declare exactly one
`references.lakehouse`, include that logical ID in `dependsOn`, and contain no
other references or bindings.

```yaml
displayName: Bronze managed tables
desiredState: present
references:
  lakehouse: bronzeLakehouse
```

`definition/tables.yaml` declares deterministic dependency order:

```yaml
apiVersion: fabric.deploy/tables/v1alpha1
kind: LakehouseTables
defaultSchema: dbo
adoptExisting: false
tables:
  - logicalId: helloWorld
    file: tables/001-hello-world.sql
```

Phase 3 accepts one restricted managed Delta
`CREATE TABLE IF NOT EXISTS ... USING DELTA` statement per file. It rejects
ALTER/DROP, CTAS, LOCATION, OPTIONS, external tables, non-Delta providers,
protocol-changing properties, and multiple statements. Schemas are never
created implicitly; the target Lakehouse must be schema-enabled and the
referenced schema must already exist. Verification pins the Delta protocol to
reader version 1 and writer version 2, permits only Fabric's legacy
`appendOnly` and `invariants` capability metadata, and blocks newer table
features.

Authenticated planning observes Spark catalog and Delta metadata through the
Lakehouse-scoped Fabric Livy session API. Apply requires the independent
`allow-lakehouse-table-create` flag. Existing structurally matching tables are
accepted only when their reserved deployment ownership properties match.
Ownership scheme `v1` hashes the deployment ID, bundle logical ID, target
Lakehouse logical ID, and table logical ID, and separately stores the canonical
per-table desired hash. Source filenames, formatting, comments, bundle source
hashes, and operation hashes are not persisted as ownership. Legacy
source/operation-hash ownership properties conflict and require an explicitly
reviewed migration; they are never silently adopted.
`adoptExisting: true` produces an explicit adoption plan, but Phase 3 blocks
execution because ownership stamping would require ALTER TABLE.

Session and statement dispatch boundaries are checkpointed using deterministic
attempt names, request/code hashes, IDs, phases, timestamps, and cleanup state.
Raw Livy stdout is never persisted. Ambiguous POST recovery enumerates and
confirms exact tagged session or code-marker candidates; zero or multiple
matches fail closed and are never automatically resubmitted. OneLake tokens are
not required for managed table DDL because no staging receipt is written in
this session-based implementation.

The Phase 3 live workflow treats a GitHub run rerun as checkpoint recovery, not
as a new deployment. Attempt 1 creates and uploads the approved plan normally.
On later attempts, the plan job queries the GitHub Actions artifacts API,
restores the earliest approved plan for that run, and restores
`checkpoint.json` only from the immediately preceding run attempt. It requires
exactly one unexpired artifact for each selected attempt and fails closed if
either artifact is missing, duplicated, or expired. The original plan is uploaded again
under the current attempt for normal job handoff, and the recovered checkpoint
is copied to `apply-output/checkpoint.json` before apply. The workflow never
relies on `download-artifact` implicitly choosing an artifact from an older
attempt.

Environment custom libraries require `definition/Sparkcompute.yml`. When Spark
settings are managed, the action reserves
`spark.fabric.deploy.definitionHash` as a published verification marker. The
marker binds the effective Fabric publish to the complete approved Environment
definition, including custom-library bytes, and is removed from staging after
the staged and published definitions are verified. Cleanup revalidates staging
before removing only the reserved marker so concurrent changes fail closed.

Notebook source files are mapped to the Fabric `fabricGitSource` or `ipynb`
public-definition formats. When `.platform` is managed, `item.yaml` must
explicitly define the description so metadata updates remain deterministic.
Sensitivity labels are intentionally rejected in `.platform` until the
dedicated Fabric sensitivity-label contract is implemented.

Spark Job Definitions use `SparkJobDefinitionV2`, including inline `Main/`
and `Libs/` parts. Inline JARs are rejected because Fabric requires an external
`abfss://` library URI for that case. Definition updates use full-replacement
semantics, so the generated `SparkJobDefinitionV1.json` always includes the
main file and complete library list. Spark Jobs support the
`defaultLakehouse` and `environment` logical-reference sugars plus explicit
bindings to `/properties/defaultLakehouseArtifactId` and
`/properties/environmentArtifactId`. Binding sources use
`items.<logicalId>.id`; the legacy singular `item.<logicalId>.id` form remains
accepted. Existing dependencies are materialized during planning. A Spark Job
that is also new can wait for dependencies created earlier in the same apply;
an existing Spark Job is blocked until all referenced dependency IDs are
available for a reviewed definition comparison.

Data Pipelines deploy the public `pipeline-content.json` definition with
semantic JSON comparison and optional managed `.platform` metadata. Accepted
create and definition-update operations are checkpointed and verified through
Fabric readback before apply completes.

Workspace custom Spark pools use the stable workspace
`/spark/pools` API. The adapter manages only workspace pools, rejects Starter
Pool and capacity-level pool collisions, and requires the deployment identity
to be a Workspace Admin for create and update operations. Pool mutations are
synchronous, non-retryable, checkpointed before submission, and reconciled
against either the exact approved pre-state or the verified desired state.
Deletion is intentionally unsupported.

Optional non-sensitive deployment variables can be passed explicitly:

```yaml
with:
  variables: >-
    {"REGION":"${{ vars.FABRIC_REGION }}"}
```

Manifest strings reference them as `${var.REGION}`. The action never reads
arbitrary process environment variables and does not evaluate JavaScript,
shell expressions, or arbitrary templates. Secrets must not be passed through
this Phase 1 variables mechanism because resolved values can affect plans.

Item paths must be directories beneath the manifest directory. Paths that
escape the deployment directory, including through symbolic links or
junctions, are rejected. Every file path and byte is included in the item
content hash and therefore in the final plan hash.

## Local development

```powershell
npm install
npm run check
npm run package
```

JavaScript actions commit their bundled `dist/` output. CI verifies that the
bundle matches the TypeScript source.

Fabric API operations and OneLake staging require separate token audiences:

| Operation | OAuth scope |
| --- | --- |
| Fabric item deployment | `https://api.fabric.microsoft.com/.default` |
| OneLake staging | `https://storage.azure.com/.default` |

The endpoints are configurable for private-network and OAP environments:

```yaml
with:
  fabric-api-endpoint: https://api.fabric.microsoft.com
  onelake-endpoint: https://onelake.dfs.fabric.microsoft.com
```

Changing the endpoint does not change the OAuth audience.

## Current implementation boundary

The action currently implements:

- Fabric API bearer-token authentication through GitHub OIDC or client secret
- Managed workspace discovery, create, metadata update, capacity assignment, and read-back verification
- Same-origin pagination
- Transient GET retries with `Retry-After`
- Long-running-operation polling and result retrieval
- Lakehouse list/get/create/update/read-back verification
- Environment definition mapping, create/update, publish, and read-back verification
- Notebook source/ipynb mapping, create/update, and read-back verification
- Spark Job Definition V2 mapping, create/update, and read-back verification
- Data Pipeline definition mapping, create/update, and read-back verification
- Workspace custom Spark pool mapping, create/update, and read-back verification
- Published Environment definition proof and target-version advancement checks
- Regional Fabric long-running-operation polling for trusted operation URLs
- Authenticated create/update/no-op planning
- Approved-plan integrity and source-commit binding
- Pre-mutation drift and authorization checks
- Lakehouse, Environment, Notebook, Spark Job Definition, Data Pipeline, and workspace custom Spark pool create/update/no-op apply
- Checkpoint and result artifacts

Lakehouse table DDL apply remains blocked until its Phase 3 adapter is
implemented.

## Live test workflow

The repository includes manual `Live Fabric Plan` and `Live Fabric Lakehouse
Apply` workflows. They use GitHub OIDC and the following repository variables:

```text
FABRIC_TENANT_ID
FABRIC_CLIENT_ID
FABRIC_WORKSPACE_ID
```

The plan workflow performs read-only discovery. The apply workflow uses a
Lakehouse-only manifest, uploads the approved plan from its plan job, and only
runs its apply job when the typed confirmation is exactly `APPLY`. Create and
update permissions are independent workflow inputs and default to false.
Configure required reviewers on the `fabric-live-apply` GitHub environment to
add a human approval gate between plan and apply. Failed-job reruns restore the
prior attempt's checkpoint when the original plan is reused. Full-workflow
reruns also require the prior checkpoint whenever the fresh plan still contains
creates. Required checkpoint restoration fails closed if the artifact is
unavailable.
