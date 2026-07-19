# Microsoft Fabric Deploy Action

A GitHub Marketplace action for declarative Microsoft Fabric deployments, with
an initial focus on Data Engineering workloads.

> **Current status:** Phases 1 through 4 are implemented. Production
> hardening includes deterministic OneLake staging for Spark Job JVM
> executables and JAR libraries plus managed Fabric tag creation and additive
> item assignment, Lakehouse schema creation, and guarded soft deletion for
> selected workspace items, disposable live E2E validation, reusable
> promotion, and provenance-attested releases. Deployments support authenticated planning and
> guarded create/update/delete/no-op apply with approved-plan binding, drift
> detection, checkpoints, and result artifacts. Phase 5 adds the workspace
> network communication policy, outbound cloud connection and gateway rules,
> guarded managed private endpoint lifecycle support, and preview inbound
> firewall, Azure resource instance, and External Data Shares bypass policy
> support. See
> [the roadmap](docs/ROADMAP.md).

For sequential environment deployment, see the
[dev/test/prod promotion guide](docs/PROMOTION.md).
The [live sandbox E2E guide](docs/LIVE_E2E.md) describes disposable
workspace validation and cleanup.
The [Fabric platform expansion plan](docs/PHASE5_PLAN.md) defines the network
protection, Semantic Model, Power BI report, and remaining item roadmap.
For operational help and release verification, see
[`SUPPORT.md`](SUPPORT.md), [`SECURITY.md`](SECURITY.md), and the
[release guide](docs/RELEASING.md).

## Initial workload scope

- Workspace
- Lakehouse
- Lakehouse table DDL
- Fabric tags and item tag assignment
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
LakehouseTables bundles, Fabric tags, Spark Job Definitions, Data Pipelines,
and workspace custom Spark pools are
classified as `create`, `update`, `delete`, `no-op`, or `blocked`; later workload
adapters remain `unknown`.

## Network protection

An optional top-level `networkProtection` manifest section manages the GA
workspace network communication policy, outbound cloud connection and gateway
rules, managed private endpoints, and the preview workspace inbound IP
firewall, Azure resource instance, and External Data Shares bypass policy
rules, either for the manifest's own managed/target workspace or an
independent explicit `workspaceId`:

```yaml
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  inboundFirewallRules:
    rules:
      - displayName: corporate-egress
        value: 12.34.56.78
      - displayName: vpn-cidr
        value: 34.56.78.0/24
  inboundAzureResourceRules:
    rules:
      - displayName: trusted-sql-server
        resourceId: /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/example/providers/Microsoft.Sql/servers/example-sql
  inboundExternalDataSharesPolicy:
    defaultAction: Deny
  outboundCloudConnectionRules:
    defaultAction: Deny
    rules:
      - connectionType: Web
        defaultAction: Allow
      - connectionType: Sql
        defaultAction: Deny
        allowedEndpoints:
          - hostnamePattern: "*.database.windows.net"
  outboundGatewayRules:
    defaultAction: Deny
    allowedGateways:
      - id: ${var.FABRIC_GATEWAY_ID}
  managedPrivateEndpoints:
    - name: storage-blob
      targetPrivateLinkResourceId: ${var.PRIVATE_LINK_RESOURCE_ID}
      targetSubresourceType: blob
      requestMessage: Approve Fabric workspace access
    - name: retired-endpoint
      desiredState: absent
      targetPrivateLinkResourceId: ${var.RETIRED_PRIVATE_LINK_RESOURCE_ID}
```

`communicationPolicy` is required whenever `networkProtection` is present, and
every `defaultAction` field must be explicit so nothing silently defaults to
`Allow`. `inboundFirewallRules` uses the documented full-replacement body
exactly: `rules[]` entries contain only `displayName` and `value`. The action
accepts documented public IPv4 single addresses, ranges, and CIDRs, normalizes
them deterministically, limits the list to 256 rules, and rejects unknown
fields, duplicate or case-ambiguous names, malformed/non-public values, and
duplicate or overlapping address declarations. IPv6 support is not documented
by Fabric and fails closed.

`inboundAzureResourceRules` uses the documented full-replacement body exactly:
`rules[]` entries contain only `displayName` and `resourceId` (a full ARM
resource ID). Each rule allows a specific Azure resource instance to reach the
workspace regardless of the IP firewall allow list. `resourceId` is validated
and canonicalized the same way as managed private endpoint target identities.
Duplicate resource IDs and unknown fields are rejected. Display names are
descriptive rather than identifiers, so Fabric's documented body permits the
same display name for different resources. The action does not invent
rule-count or display-name length limits that the preview API does not
document.
Unlike inbound firewall rules, Azure resource rules grant access to specific
resources rather than any client IP, so inbound `Deny` does not require a
non-empty `inboundAzureResourceRules` configuration on its own -- only the
firewall's non-empty-rule requirement guards against total public lockout.

Inbound `Deny` is accepted only with an explicit non-empty approved firewall
configuration. An empty `rules` array is permitted only while the desired
inbound policy is `Allow`, for example to clear staged rules after first opening
the master policy.

`inboundExternalDataSharesPolicy` uses the documented full-replacement body
exactly: `{ defaultAction }`. It controls whether External Data Shares
traffic may bypass every other inbound restriction. Enabling the bypass
(observed `Deny` -> desired `Allow`) is a security relaxation and requires the
independent `allow-inbound-external-data-share-policy-relaxation` safeguard in
addition to `allow-inbound-external-data-share-policy-update`; tightening
(disabling the bypass) never requires the relaxation safeguard. Fabric
documents Get Inbound External Data Shares Policy as generally available
(viewer role) while Set Inbound External Data Shares Policy is explicitly
preview (admin role); the action treats both the same operationally and calls
out the asymmetry in its plan output. Like Azure resource rules, this surface
does not participate in the firewall's non-empty-rule lockout requirement and
may be declared independently of the master inbound default action.
`outboundCloudConnectionRules` and `outboundGatewayRules` are optional and may
only be declared while `outboundDefaultAction` is `Deny`, matching the Fabric
API's own requirement that outbound access protection (OAP) be enabled before
its allow lists can be read or written.

Managed private endpoint `desiredState` defaults to `present`. Present entries
require `requestMessage`; absent entries forbid it and must still declare the
target ARM resource identity. Names are case-insensitively unique, ARM IDs are
compared canonically without case sensitivity, and target identity is
immutable: mismatches are blocked rather than updated or replaced.
`targetFQDNs` is not supported yet. Request messages are sent only in the
create request and are never written to plans, checkpoints, results, or job
summaries.

Network safeguards are independent and default to `false`:

- `allow-network-policy-update`
- `allow-network-policy-relaxation` (required in addition to
  `allow-network-policy-update` for either an inbound or outbound
  Deny -> Allow transition)
- `allow-inbound-firewall-update`
- `allow-inbound-azure-resource-rule-update`
- `allow-inbound-external-data-share-policy-update`
- `allow-inbound-external-data-share-policy-relaxation` (required in addition
  to `allow-inbound-external-data-share-policy-update` for an observed
  Deny -> desired Allow bypass transition; tightening never requires it)
- `acknowledge-firewall-lockout-risk` (required independently, together with
  both `allow-network-policy-update` and
  `allow-inbound-firewall-update`, for observed inbound Allow -> desired Deny;
  neither `allow-inbound-azure-resource-rule-update` nor
  `allow-inbound-external-data-share-policy-update`/`-relaxation` participate
  in or satisfy this lockout acknowledgement)
- `allow-outbound-cloud-connection-rule-update`
- `allow-outbound-gateway-rule-update`
- `allow-managed-private-endpoint-create`
- `allow-managed-private-endpoint-delete`

Every configured surface is preflighted before any Fabric item is mutated.
Present managed private endpoints are verified or created after item
reconciliation, OAP policy/rules run next, and absent endpoint deletions run
last. An interrupted inbound firewall, Azure resource rule, External Data
Shares policy, or communication policy operation is recovered before unrelated
item loading, while untouched operations are never started by early recovery.

Safe ordering is directional even though both defaults share one communication
policy PUT. Inbound `Allow` -> `Deny` stages and verifies every inbound
exception surface (firewall rules, then Azure resource instance rules, then
the External Data Shares bypass policy) before the policy; inbound
`Deny` -> `Allow` opens the policy before those surfaces relax or clear
(firewall rules, then Azure resource instance rules, then the External Data
Shares bypass policy). Outbound `Allow` -> `Deny` writes the policy before OAP
rules; other outbound rule updates run before the policy. Combined transitions
apply all required pre-policy surfaces, write the single policy body, then
apply required post-policy surfaces. Each surface runs exactly once per apply.

Outbound `Allow` -> `Deny` is intentionally deferred when a declared present
endpoint is missing, provisioning, awaiting approval, or otherwise not safely
approved. Apply creates and polls the endpoint first; `Succeeded` plus
connection `Pending` is a successful apply with `approvalRequired: true`.
Approve the private-link request and generate a fresh plan before OAP can
tighten. A managed workspace bootstrap likewise requires a replan before
same-workspace endpoints can run; an explicit independent
`networkProtection.workspaceId` remains actionable.

The inbound firewall, Azure resource rule, and External Data Shares policy
APIs are preview (Set Inbound External Data Shares Policy is explicitly
documented as preview; Get Inbound External Data Shares Policy is documented
as generally available). The firewall reference documents an ETag, but live
GET responses can omit it; the official reference for Azure resource rules
does not document an ETag or `If-Match` support at all, while External Data
Shares documents both. Apply sends any fresh ETag as quoted `If-Match` when
the adapter observes one for any of these surfaces. A plan approved without
an ETag remains actionable only while fresh discovery is also headerless and
the observed body hash still matches; losing ETag support after approving a
token-bound plan fails closed. Only HTTP 429 is retried; transport failures,
408, and 5xx remain ambiguous and are resolved by checkpointed read-back
rather than blind resubmission. Unlike Set Firewall Rules (which accepts `200`
or `204`), Set Inbound Azure Resource Rules and Set Inbound External Data
Shares Policy each document only `200`; any other status is treated as a
validation error. GitHub-hosted live validation is plan-only and never
enables inbound `Deny` or the External Data Shares bypass.

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
    allow-delete: "false"
    allow-lakehouse-data-loss: "false"
    allow-lakehouse-schema-create: "true"
    allow-lakehouse-table-create: "true"
    allow-tag-create: "true"
    allow-tag-assign: "true"
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
- Creates, updates, or deletions without their explicit allow flag
- Blocked, unknown, or unsupported workload actions

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
`approved-plan-hash` identifies the plan authorized for apply.

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

### Guarded item deletion

Lakehouse, Environment, Notebook, Spark Job Definition, and Data Pipeline
items can declare `desiredState: absent`. Deletion intent must be explicit in
both the deployment manifest and `item.yaml`:

```yaml
# deployment.yaml
items:
  - logicalId: retiredNotebook
    type: Notebook
    path: items/notebooks/retired
    desiredState: absent
```

```yaml
# items/notebooks/retired/item.yaml
displayName: Retired Notebook
desiredState: absent
folderId: 11111111-1111-1111-1111-111111111111 # optional
```

Deletion-only items do not require a `definition/` directory and cannot
declare descriptions, references, bindings, or tags. Apply performs Fabric's
default soft deletion; it does not request permanent deletion. A delete plan
is bound to the exact physical item ID and observed identity metadata. Apply
requires `allow-delete: "true"`, checkpoints intent before the DELETE request,
verifies the exact approved ID is absent, and refuses to delete a replacement
item that appears under the same name and folder.

Dependencies between absent items run in reverse order so dependents are
deleted before their dependencies. A present item cannot depend on an absent
item. Lakehouse deletion additionally requires
`allow-lakehouse-data-loss: "true"` so a generic delete approval cannot remove
Lakehouse data. FabricTag, LakehouseTables, and workspace custom Spark pool
deletion remain unsupported.

See [`examples/deletion`](examples/deletion) for a Lakehouse and dependent
Data Pipeline retirement manifest.

### Fabric tags

Declare a tenant or domain tag as a managed `FabricTag` resource:

```yaml
items:
  - logicalId: phase4ReviewTag
    type: FabricTag
    path: items/tags/phase4-review

  - logicalId: bronzeLakehouse
    type: Lakehouse
    path: items/lakehouses/bronze
    dependsOn:
      - phase4ReviewTag
```

```yaml
# items/tags/phase4-review/item.yaml
displayName: Fabric Deploy Phase 4 Review
scope:
  type: Tenant
```

```yaml
# items/lakehouses/bronze/item.yaml
displayName: Bronze
tags:
  - phase4ReviewTag
```

Domain tags use `scope.type: Domain` plus a Fabric domain GUID. Tag references
must target `FabricTag` logical IDs and must be declared in `dependsOn`, which
ensures same-plan tags are created before assignment. A tag name is limited to
40 characters and an item can declare at most 10 tags.

Tag ownership is additive: apply adds missing desired tags and verifies the
desired subset, but never removes unrelated tags or tags omitted from the
manifest. `FabricTag` resources are create/no-op only; rename, scope change,
unassignment, and deletion are intentionally unsupported.

Tag creation requires both `allow-create` and the independent
`allow-tag-create` safeguard. Assignment requires `allow-tag-assign`. All
default to `false`. Creating catalog tags uses the Fabric administrator API
and requires the corresponding tenant permission; assigning tags requires
Contributor or higher on the target workspace.

Definition-bearing workloads are structurally validated:

The required definitions below apply to `desiredState: present`. Supported
deletion-only items use only `item.yaml` as described above.

| Type | Required definition |
| --- | --- |
| Lakehouse | `item.yaml` |
| LakehouseTables | `definition/tables.yaml` plus every declared `definition/tables/*.sql` file |
| FabricTag | `item.yaml`; no `definition/` directory |
| Environment | `definition/environment.yml`; optional `Sparkcompute.yml`, `.platform`, and custom libraries |
| Notebook | Exactly one `.py`, `.scala`, `.r`, `.sql`, or `.ipynb` file under `definition/`; optional `.platform` |
| Spark Job Definition | Exactly one `definition/main.py` or `definition/main.jar`; optional `SparkJobDefinitionV1.json`, `.platform`, and files under `definition/libs/` |
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
adoptExisting: false
schemas:
  - logicalId: salesSchema
    name: sales
tables:
  - logicalId: helloWorld
    file: tables/001-hello-world.sql
```

`schemas` and `tables` are independently optional, but at least one must be
non-empty. Managed schema declarations generate only
`CREATE SCHEMA IF NOT EXISTS`; reserved system schemas are rejected. Existing
schemas are left unchanged, and schemas omitted from the bundle are unmanaged.
Schema operations are always planned and executed before table operations.

The action accepts one restricted managed Delta
`CREATE TABLE IF NOT EXISTS ... USING DELTA` statement per file. It rejects
ALTER/DROP, CTAS, LOCATION, OPTIONS, external tables, non-Delta providers,
protocol-changing properties, and multiple statements. Schemas are never
created from table SQL; a missing table schema must be declared in the same
bundle. The target Lakehouse must be schema-enabled. Verification pins the Delta protocol to
reader version 1 and writer version 2, permits only Fabric's legacy
`appendOnly` and `invariants` capability metadata, and blocks newer table
features.

Authenticated planning observes Spark catalog and Delta metadata through the
Lakehouse-scoped Fabric Livy session API. Schema and table mutations require
the independent `allow-lakehouse-schema-create` and
`allow-lakehouse-table-create` flags respectively; mixed bundles require both.
Existing structurally matching tables are
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

Spark Job Definitions use `SparkJobDefinitionV2`. Python jobs use inline
`definition/main.py` and optional non-JAR `definition/libs/` files; Fabric
rejects JAR libraries for Python jobs. JVM jobs use `definition/main.jar`,
language `Scala/Java`, a nonempty `mainClass`, and optional JAR files under
`definition/libs/`. The main JAR and its JAR libraries are captured as
immutable staging sources rather than sent inline. A staged job must declare a
logical `defaultLakehouse` reference or equivalent binding. Planning assigns
each staged artifact the deterministic path
`Files/.fabric-deploy/{deploymentId}/{environment}/{logicalId}/{sha256}/{filename}`
and classifies it as create, no-op, or blocked after a full SHA-256 readback.
Apply requires the independent `allow-onelake-artifact-create` flag, creates
the directory hierarchy through the OneLake DFS API, uploads at most 512 MiB
with an atomic conditional Block Blob request, and never overwrites mismatched
content. The approved staging proof binds both configured OneLake endpoints;
changing either endpoint requires a new plan. Upload intent and verification
are checkpointed before the Spark Job write, and pending Spark recovery first
proves that every artifact was verified under the exact materialized binding.
For JVM jobs, the generated definition receives the main JAR's
content-addressed `abfss://` URI in `executableFile` and library URIs in
`additionalLibraryUris`. Definition updates use full-replacement semantics, so
the generated `SparkJobDefinitionV1.json` always includes the executable and
complete library list. Spark Jobs support the
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
  onelake-blob-endpoint: https://onelake.blob.fabric.microsoft.com
```

When `onelake-blob-endpoint` is omitted, it is derived from a `.dfs.` OneLake
host by replacing `.dfs.` with `.blob.`. Changing the endpoint does not change
the OAuth audience.

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
- Immutable OneLake staging for Spark Job JVM executables and JAR libraries
- Data Pipeline definition mapping, create/update, and read-back verification
- Workspace custom Spark pool mapping, create/update, and read-back verification
- Fabric tenant/domain tag creation and additive item tag assignment
- Published Environment definition proof and target-version advancement checks
- Regional Fabric long-running-operation polling for trusted operation URLs
- Authenticated create/update/no-op planning
- Approved-plan integrity and source-commit binding
- Pre-mutation drift and authorization checks
- Lakehouse, Environment, Notebook, Spark Job Definition, Data Pipeline, and workspace custom Spark pool create/update/no-op apply
- Checkpoint and result artifacts

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
