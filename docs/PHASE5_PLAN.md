# Fabric platform expansion plan

This plan extends the guarded deployment model beyond the initial data
engineering workloads. Network protection is implemented first, followed by
Semantic Models and Power BI reports, then the remaining supported Fabric item
families in dependency order.

## Design rules

- Preserve authenticated plan, immutable approval, drift detection,
  preflight, checkpoint, and read-back verification for every new surface.
- Keep tenant-wide security settings outside this action. The planner may
  report missing prerequisites, but it must not mutate tenant settings.
- Require an independent safeguard for every security relaxation, connectivity
  deletion, data-loss risk, or code-execution capability.
- Treat preview APIs as opt-in capabilities and identify them prominently in
  plans and documentation.
- Reject unsupported definition parts, credentials, and implicit bindings
  instead of ignoring them.
- Use service-principal-compatible APIs only.

## Phase 5: workspace network protection

Network protection is a top-level workspace concern, not a Fabric item. Add an
optional `networkProtection` manifest section that can target either a managed
workspace or an explicit workspace ID.

### Phase 5A: outbound access protection

Implement the generally available workspace APIs:

| Surface | Fabric REST API |
| --- | --- |
| Network communication policy | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy` |
| Outbound cloud connection rules | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy/outbound/connections` |
| Outbound gateway rules | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy/outbound/gateways` |
| Managed private endpoints | `POST/GET/LIST/DELETE /v1/workspaces/{workspaceId}/managedPrivateEndpoints` |

Every `PUT` is a full replacement. Desired payloads must always include
explicit `defaultAction` values so omitted fields cannot silently default to
`Allow`. Plans bind the complete normalized body, observed hash, and available
ETag. Apply rechecks the observed hash and sends `If-Match` when supported.
Reusable workflow apply jobs are serialized repository-wide because one plan
can mutate both its deployment workspace and a separate explicit network
protection workspace. The concurrency group uses the extended queue so pending
deployments are not replaced by newer runs.

Outbound connection and gateway rules require the communication policy's
outbound default action to be `Deny`. The approved plan therefore contains the
master policy and complete allow lists as one mutation unit. Recovery after the
master switch is accepted must prioritize completing the outbound rules before
any unrelated work.

Managed private endpoints use exact-name discovery, immutable target identity,
provisioning-state polling, and separate create/delete safeguards. Deletion
must verify the approved physical ID and target resource before dispatch.

The tested increment uses a top-level array:

```yaml
networkProtection:
  communicationPolicy:
    inboundDefaultAction: Allow
    outboundDefaultAction: Deny
  managedPrivateEndpoints:
    - name: storage-blob
      targetPrivateLinkResourceId: ${var.PRIVATE_LINK_RESOURCE_ID}
      targetSubresourceType: blob
      requestMessage: Approve Fabric workspace access
    - name: retired-endpoint
      desiredState: absent
      targetPrivateLinkResourceId: ${var.RETIRED_PRIVATE_LINK_RESOURCE_ID}
```

`desiredState` defaults to `present`. Present entries require a write-only
`requestMessage`; absent entries forbid it and still require the target ARM
identity. Names are unique without case sensitivity, ARM IDs are canonicalized
for case-insensitive comparison, and target identity mismatches are blocked.
There is intentionally no update/replace path and no `targetFQDNs` support in
this increment.

Create uses `POST` with an expected `201`, then polls `GET` until provisioning
is `Succeeded`. Connection `Pending` is successful but reports
`approvalRequired`; `Rejected`, `Disconnected`, failed/deleting, duplicate,
collision, and unknown states fail closed. Delete is bound to the exact
approved physical ID and observed identity hash, accepts `200` or already-gone
`404`, verifies absence, detects replacement IDs, and records a 15-minute
`recreateNotBefore` window.

Checkpoints are written before both `POST` and `DELETE`. An ambiguous create
adopts only one exact live name/identity match and never blindly resubmits. An
ambiguous delete is not redispatched while the approved ID remains. Early
recovery resumes only endpoint operations already present in the checkpoint;
normal apply order is present endpoints after item reconciliation, OAP next,
and absent endpoint deletion last.

Outbound `Allow` -> `Deny` is a two-plan rollout whenever any declared present
endpoint is missing, provisioning, pending approval, rejected, disconnected,
or unknown. The first apply creates/verifies endpoints and defers the policy.
After approval, a fresh authenticated plan may tighten OAP. Same-workspace
endpoints are blocked during managed-workspace bootstrap until replan, while
an explicit independent `networkProtection.workspaceId` remains actionable.

### Phase 5B: inbound access protection

Phase 5B now covers all three documented preview inbound surfaces:

| Surface | Fabric REST API |
| --- | --- |
| IP firewall rules | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy/inbound/firewall` (implemented) |
| Azure resource instance rules | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy/inbound/azureResources` (implemented) |
| External Data Shares bypass policy | `GET/PUT /v1/workspaces/{workspaceId}/networking/communicationPolicy/inbound/externalDataShares` (implemented) |

`inboundFirewallRules` mirrors the documented request body exactly:
`{ "rules": [{ "displayName": "...", "value": "..." }] }`. Rules are
canonicalized and hashed as a complete replacement. The validator accepts only
documented public IPv4 single-address, range, and CIDR forms, enforces the
256-rule and 128-character name limits, and rejects unknown fields,
case-ambiguous names, malformed/non-public values, duplicates, and overlaps.
IPv6 and empty inbound-Deny allow lists fail closed.

Authenticated planning binds the target workspace, canonical desired hash,
observed hash, rule count, and GET ETag when Fabric returns one. The preview
reference advertises an ETag, but live GET responses can omit it. Apply uses a
fresh ETag as quoted `If-Match` when available; a headerless approved plan may
proceed only after fresh hash-based drift checks, while disappearance of an
approval-time ETag fails closed. Apply checkpoints before dispatch, accepts the
two status codes currently shown by the official reference (`200` in the
response table and `204` in the example), and verifies with a new GET. Only
definitive HTTP 429 is retried. Transport failures, 408, and 5xx remain
ambiguous and are never blindly resubmitted.

`inboundAzureResourceRules` mirrors the documented Get/Set Inbound Azure
Resource Rules request/response body exactly:
`{ "rules": [{ "displayName": "...", "resourceId": "..." }] }`, where
`resourceId` is a full ARM resource ID. Rules are canonicalized (ARM IDs are
lowercased using the same canonicalization as managed private endpoint target
identities) and hashed as a complete replacement, sorted by resource ID then
display name. The validator rejects unknown fields, duplicate or
case-ambiguous resource IDs, and malformed ARM resource ID shapes. Display
names are descriptive rather than identifiers and need not be unique. Unlike
the sibling firewall surface, the official reference documents no rule-count
or displayName-length limit and no ETag/`If-Match` support at all for this
surface, so the action does not invent those limits. It opportunistically
captures and forwards any ETag the service happens to return, using the
identical headerless-safe drift model, in case a future preview revision adds
one. A live read-only GET currently returns `{ "rules": [] }` without an ETag.
Set Inbound Azure Resource Rules documents only a `200` response (no `204`
alternative), and any other status is treated as a validation error rather
than an accepted no-content response. Because Azure resource rules grant
access to a specific Azure resource instance rather than any client IP, they
do not participate in the inbound-Deny non-empty-configuration requirement
that guards against total public lockout -- that requirement remains bound to
`inboundFirewallRules` only.

`inboundExternalDataSharesPolicy` mirrors the documented Get/Set Inbound
External Data Shares Policy request/response body exactly:
`{ "defaultAction": "Allow" | "Deny" }`. `defaultAction` defines whether
External Data Shares traffic is allowed to bypass every other inbound
restriction. The official reference marks **Set** Inbound External Data
Shares Policy explicitly as preview (admin workspace role), while **Get**
Inbound External Data Shares Policy is documented without a preview notice
(viewer role) -- an asymmetry unlike the sibling firewall/Azure-resource
surfaces, where both Get and Set are marked preview. The action treats both
operations identically at runtime and calls out the asymmetry in documentation
only. The GET example response documents an ETag (`ETag: "a1b2c3d4"`) and the
PUT example documents a fresh one on success, so this surface follows the
identical headerless-safe drift model as the other two: a fresh ETag is sent
as quoted `If-Match` when available, but a live response omitting the header
does not block planning. Like Azure resource rules, Set Inbound External Data
Shares Policy documents only a `200` response (no `204` alternative); any
other status is a validation error. Only definitive HTTP 429 is retried;
transport failures, 408, and 5xx remain ambiguous. Because the bypass applies
independently of any specific IP or resource identity, this surface does not
participate in the firewall's non-empty-rule lockout requirement and may be
declared regardless of the master inbound default action.

Enabling the bypass (observed `Deny` -> desired `Allow`) is itself a security
relaxation -- it lets External Data Shares traffic circumvent every other
inbound restriction -- and requires the fully independent
`allow-inbound-external-data-share-policy-relaxation` safeguard in addition to
the base `allow-inbound-external-data-share-policy-update`. Tightening
(disabling the bypass) never requires the relaxation safeguard. The plan's
`isRelaxation` classification is bound to the approved hash (both desired and
observed) and independently re-derived during drift checks, so a tampered
plan artifact cannot reclassify an enabling transition as non-relaxing to
bypass the extra safeguard.

Inbound exceptions are staged and verified before changing inbound public
access from `Allow` to `Deny`. The transition requires
`allow-network-policy-update`, `allow-inbound-firewall-update`, and the
independent `acknowledge-firewall-lockout-risk` before any mutation in the
network unit, including recovery; `allow-inbound-azure-resource-rule-update`
and `allow-inbound-external-data-share-policy-update`/`-relaxation` are each
fully independent safeguards scoped only to their own surface and neither
satisfy nor are implied by the lockout safeguards. Inbound `Deny` to `Allow`
opens the master policy before firewall, Azure resource rule, and External
Data Shares policy relaxation/removal (firewall first, then Azure resource
rules, then the External Data Shares bypass policy). Combined inbound/outbound
transitions run direction-specific pre-policy surfaces (all three inbound
exception surfaces staged before an `Allow` -> `Deny` transition, or relaxed
together after a `Deny` -> `Allow` transition), the single communication
policy PUT, then direction-specific post-policy surfaces. Each surface runs
exactly once per apply. Because enabling the bypass is itself a relaxation
independent of the master policy's own transition, staging it before an
inbound `Allow` -> `Deny` tightening keeps the bypass continuously in effect
across the transition rather than opening a window where it is momentarily
disabled; disabling it is deferred until after an inbound `Deny` -> `Allow`
relaxation for the same reason, mirroring the ordering already used for the
firewall and Azure resource rule allow lists.

GitHub-hosted live validation is intentionally limited to an authenticated
read-only plan probe with desired inbound `Allow`, covering the firewall,
Azure resource rule, and External Data Shares policy surfaces. A self-hosted
runner with a stable, allow-listed egress address remains the recommended
future mutation test path.

Tenant-level and workspace-level Private Link configuration remains out of
scope because the required controls are portal/ARM surfaces rather than
documented Fabric workspace REST operations. Fully configuring trusted
workspace access for a specific Azure resource (for example, an Azure Storage
account) also requires a resource-instance rule on that target resource's own
network settings; that half of the configuration remains an ARM/portal
surface for the target resource and is out of scope, even though this action
now manages the Fabric-side `inboundAzureResourceRules` allow list.

### Network safeguards

- `allow-network-policy-update`
- `allow-network-policy-relaxation`
- `allow-outbound-cloud-connection-rule-update`
- `allow-outbound-gateway-rule-update`
- `allow-managed-private-endpoint-create`
- `allow-managed-private-endpoint-delete`
- `allow-inbound-firewall-update`
- `allow-inbound-azure-resource-rule-update`
- `allow-inbound-external-data-share-policy-update`
- `allow-inbound-external-data-share-policy-relaxation`
- `acknowledge-firewall-lockout-risk`

### Network live validation

Extend the disposable E2E workflow with an outbound-only fixture. Verify
tighten, no-op, relax, private-endpoint cleanup, and final workspace deletion.
Do not enable inbound deny or the External Data Shares bypass from a
GitHub-hosted runner.

## Phase 6: Power BI items

### Phase 6A: Semantic Models

Add Fabric item type `SemanticModel` using:

- TMDL definitions: `definition/**`, `definition.pbism`, optional
  `diagramLayout.json`
- TMSL definitions: `model.bim`, `definition.pbism`
- Typed `/semanticModels` create, get, get-definition, update-definition,
  metadata update, and delete APIs

TMDL and TMSL are mutually exclusive. Definitions are canonicalized and hashed
without credentials. External connection credentials, gateway binding, and
`bindConnection` are not part of the first adapter. Encrypted sensitivity
labels that prevent definition reads produce a blocked plan.

### Phase 6B: Power BI reports

Add Fabric item type `Report` using PBIR first and PBIR-Legacy as an alternate
format. A report declares:

```yaml
references:
  semanticModel: salesModel
```

The target must be a `SemanticModel` item declared in `dependsOn`. The planner
keeps the reference symbolic, while apply materializes
`definition.pbir.datasetReference.byConnection.connectionString` as
`semanticmodelid=<physicalId>`. Verification confirms both the definition hash
and the resolved model binding.

Semantic Model and report deletion require the generic delete safeguard plus
item-specific approval. Permanent deletion is not enabled by default.

## Remaining Fabric item order

| Phase | Item family | Initial order and constraints |
| --- | --- | --- |
| 7 | Real-Time Intelligence | Eventhouse, KQL Database, Eventstream, KQL Queryset, KQL Dashboard, then newer ontology and graph artifacts. Defer items without service-principal support. |
| 8 | Warehouse and databases | Warehouse metadata, guarded T-SQL DDL companion, Fabric SQL Database, then service-principal-compatible mirrored catalog variants. |
| 9 | Data Factory | Copy Job, mounted factory integration, then dbt job support after preview validation. |
| 10 | Platform and application items | Variable Library, GraphQL API, User Data Function, Snowflake Database, and Azure Databricks storage/catalog items. User Data Functions require a separate code-execution safeguard. |
| 11 | Additional Power BI items | Paginated Report and organizational app artifacts after the Semantic Model/report foundation is stable. |
| 12 | Data Science and blocked surfaces | Revisit ML and other item types only when service-principal support and definition APIs are available. |

Read-only or automatically generated artifacts are inventory-only and are not
declarative deployment targets.

## Definition-adapter implementation order

For every new item:

1. Add the item type, schema, definition loader, canonical hash, and strict
   validation.
2. Add authenticated discovery and create/update/no-op planning.
3. Add approved-plan apply, checkpoints, recovery, and read-back verification.
4. Add exact guarded deletion only after create/update recovery is complete.
5. Add maintained examples, unit/integration coverage, and disposable live
   validation.
6. Rebuild `dist/index.js`, run the full suite, review, then commit.

## Primary references

- [Workspace network communication policy](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/get-network-communication-policy)
- [Set network communication policy](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-network-communication-policy)
- [Get workspace firewall rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/get-firewall-rules)
- [Set workspace firewall rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-firewall-rules)
- [Workspace IP firewall overview](https://learn.microsoft.com/en-us/fabric/security/security-workspace-level-firewall-overview)
- [Get inbound Azure resource rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/get-inbound-azure-resource-rules)
- [Set inbound Azure resource rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-inbound-azure-resource-rules)
- [Get inbound External Data Shares policy](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/get-inbound-external-data-shares-policy)
- [Set inbound External Data Shares policy](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-inbound-external-data-shares-policy)
- [Outbound cloud connection rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-outbound-cloud-connection-rules)
- [Outbound gateway rules](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/set-outbound-gateway-rules)
- [Managed private endpoints](https://learn.microsoft.com/en-us/rest/api/fabric/core/managed-private-endpoints)
- [Semantic Model definitions](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/semantic-model-definition)
- [Report definitions](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/report-definition)
- [Fabric item management overview](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/item-management-overview)
