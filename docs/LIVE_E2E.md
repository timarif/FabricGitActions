# Live sandbox E2E

[`live-fabric-e2e.yml`](../.github/workflows/live-fabric-e2e.yml) provisions a
uniquely named disposable workspace, assigns it to a capacity, deploys the
maintained core, pipeline, and tag fixtures, and then replans every fixture to
prove an idempotent no-op result.

The workflow deletes the workspace in an `always()` cleanup step and verifies
that its exact physical ID returns `404`. Plans, checkpoints, apply results,
and cleanup responses are retained as workflow artifacts for 14 days.

## Repository configuration

Configure these repository variables:

| Variable | Purpose |
| --- | --- |
| `FABRIC_TENANT_ID` | Entra tenant containing the OIDC deployment application |
| `FABRIC_CLIENT_ID` | Deployment application client ID |
| `FABRIC_CAPACITY_ID` | Capacity assigned to each disposable workspace |
| `FABRIC_E2E_ENABLED` | Set to `true` to enable the weekly scheduled run |

The workflow can always be started manually. Scheduled runs are skipped unless
`FABRIC_E2E_ENABLED` is exactly `true`.

The deployment application needs workspace creation, capacity assignment,
Fabric item mutation, tenant tag management, and workspace deletion
permissions. Its GitHub federated credential must authorize this repository's
workflow subject.

## Failure retention

Manual runs can retain the workspace when a deployment step fails. Use this
only for short-lived diagnosis and delete the workspace after inspection.
Successful runs always clean up.

The tag fixture uses one stable tenant tag rather than creating a new
tenant-scoped tag on every run. The disposable tagged Lakehouse is removed
with the workspace.

## Inbound firewall live probe

[`live-fabric-plan.yml`](../.github/workflows/live-fabric-plan.yml) has an
optional `probe_inbound_firewall` input. It runs an authenticated read-only
plan against `examples/inbound-firewall-probe` and verifies that all three
preview inbound surfaces (IP firewall rules, Azure resource instance rules,
and the External Data Shares bypass policy) are discoverable. The fixture
keeps desired inbound public access at `Allow` and the External Data Shares
bypass at `Deny`; no GitHub-hosted workflow applies rules on any surface or
enables inbound `Deny` or the bypass. The preview firewall service can omit
the ETag advertised by its REST reference, the Azure resource rules reference
does not document an ETag at all, and the External Data Shares policy
reference documents one that a live response may still omit; the probe
remains actionable for all three by binding and rechecking each surface's
complete observed body hash. Probe mode skips the unrelated Lakehouse
planning check so an inactive capacity cannot prevent inbound surface API
validation.

Future mutation validation must use a self-hosted runner with stable,
allow-listed egress and an explicit recovery plan. Tenant-level Private Link
settings remain outside this action.
