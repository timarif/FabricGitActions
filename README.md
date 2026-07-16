# Microsoft Fabric Deploy Action

A GitHub Marketplace action for declarative Microsoft Fabric deployments, with
an initial focus on Data Engineering workloads.

> **Current status:** Phase 1 is complete. Phase 2 implements authenticated
> Lakehouse planning and guarded create/update/no-op apply with approved-plan
> binding, drift detection, checkpoints, and result artifacts. Live mutation
> validation remains pending. See [the roadmap](docs/ROADMAP.md).

## Initial workload scope

- Lakehouse
- Environment
- Notebook
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

Without authentication, `plan` is offline and reports item actions as
`unknown`. With Fabric authentication configured, Lakehouses are classified as
`create`, `update`, or `no-op`; later workload adapters remain `unknown`.

## Authenticated Lakehouse plan with GitHub OIDC

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

## Guarded Lakehouse apply

Generate an authenticated plan, preserve it as an immutable artifact, then pass
that exact file to a separate apply job:

```yaml
- uses: your-organization/fabric-deploy@v1
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
    plan-file: apply-output/current-plan.json
    checkpoint-file: apply-output/checkpoint.json
    result-file: apply-output/result.json
```

Apply recomputes the current authenticated plan and rejects:

- Modified or malformed approved plans
- Source commit, source content, environment, workspace, or graph mismatches
- Fabric state drift after approval
- Creates or updates without their explicit allow flag
- Blocked, unknown, deletion, or unsupported workload actions

All items are preflighted before the first mutation. A create intent is
checkpointed before POST; accepted `202` operations and returned physical IDs
are then checkpointed before read-back verification and resumed without
reissuing the create. Update intents are checkpointed before PATCH and
reconciled without repeating an ambiguously completed update. Expired operation
references reconcile against live state. The result file is initialized before
Fabric operations and finalized for failures that occur during authentication
or discovery. Explicitly failed create operations are cleared only after fresh
discovery confirms the Lakehouse is still absent; ambiguous timeouts remain
checkpointed.
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
| Environment | Non-empty `definition/` directory |
| Notebook | Exactly one `.py` or `.ipynb` file under `definition/` |
| Spark Job Definition | Exactly one `definition/main.py` or `definition/main.scala` |
| Data Pipeline | Valid JSON object at `definition/pipeline-content.json` |

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

## Phase 2 implementation boundary

The Phase 2 client implements:

- Fabric API bearer-token authentication through GitHub OIDC or client secret
- Same-origin pagination
- Transient GET retries with `Retry-After`
- Long-running-operation polling and result retrieval
- Lakehouse list/get/create/update/read-back verification
- Authenticated create/update/no-op planning
- Approved-plan integrity and source-commit binding
- Pre-mutation drift and authorization checks
- Lakehouse create/update/no-op apply
- Checkpoint and result artifacts

Environment, Notebook, Spark Job Definition, and Data Pipeline apply remain
blocked until their Phase 3 adapters are implemented.

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
