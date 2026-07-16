# Microsoft Fabric Deploy Action

A GitHub Marketplace action for declarative Microsoft Fabric deployments, with
an initial focus on Data Engineering workloads.

> **Current status:** Phase 1 is complete. Phase 2 adds authenticated online
> Lakehouse planning plus tested create/update/read-back primitives. The action
> still makes **no Fabric mutations** until guarded `apply` mode is added. See
> [the roadmap](docs/ROADMAP.md).

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
contains the validated deployment order and a deterministic hash that can later
be used to bind approval to an exact deployment.

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

Create and update methods are intentionally not exposed through action `apply`
mode yet. Approval binding, destructive safeguards, checkpoints, and recovery
artifacts are required before enabling mutations.

## Live test workflow

The repository includes a manual `Live Fabric Plan` workflow. It uses GitHub
OIDC and the following repository variables:

```text
FABRIC_TENANT_ID
FABRIC_CLIENT_ID
FABRIC_WORKSPACE_ID
```

The workflow performs read-only discovery and uploads the generated plan. It
does not create or update Fabric items.
