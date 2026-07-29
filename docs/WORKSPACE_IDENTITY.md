# Workspace identity

Fabric Deploy can provision the Microsoft Fabric-managed identity associated
with the deployment workspace and add explicit workspace role assignments for
its service principal.

```yaml
workspace:
  id: ${var.FABRIC_WORKSPACE_ID}

workspaceIdentity:
  provision: true
  roleAssignments:
    - role: Contributor
    - workspaceId: ${var.SHARED_WORKSPACE_ID}
      role: Viewer

items: []
```

Omitting `workspaceId` from a role assignment targets the deployment
workspace. Supplying it grants the workspace identity access to another
workspace.

## API contract

The adapter uses the GA Fabric Core APIs:

| Operation | Method | Path |
| --- | --- | --- |
| Read identity | `GET` | `/v1/workspaces/{workspaceId}` |
| Provision identity | `POST` | `/v1/workspaces/{workspaceId}/provisionIdentity` |
| List roles | `GET` | `/v1/workspaces/{workspaceId}/roleAssignments` |
| Add role | `POST` | `/v1/workspaces/{workspaceId}/roleAssignments` |

Provisioning can complete synchronously with `200` or through a `202`
long-running operation. The resulting `applicationId` and
`servicePrincipalId` are verified through workspace readback. Role assignment
creates return `201`.

## Staged deployment

Provisioning grants no workspace role automatically. When the identity is
missing, role assignments are deferred because their approved plan must bind
the service principal ID returned by Fabric.

1. Generate and approve a plan that provisions the identity.
2. Apply with `allow-workspace-identity-provision: "true"`.
3. Generate a fresh plan after Fabric exposes the identity IDs.
4. Apply approved role grants with
   `allow-workspace-identity-role-assign: "true"`.

Creating a managed workspace is already a separate bootstrap, so a deployment
that creates the workspace, provisions its identity, and grants roles can
require three approved plan/apply cycles.

## Safeguards

Both mutation capabilities default to `false`:

- `allow-workspace-identity-provision`
- `allow-workspace-identity-role-assign`

Role assignments are additive only. An existing assignment with the requested
role is verified as a no-op. Duplicate assignments or an existing assignment
with another role are blocked. Role changes, role removal, and identity
deprovisioning are intentionally unsupported.

The section is unmanaged when omitted. Fabric Deploy never deprovisions an
identity because configuration was removed.

## Recovery and drift

The checkpoint is written before each non-idempotent POST. Accepted
provisioning operations retain their Fabric operation reference for safe
resume. If a response is lost before acceptance is recorded, recovery adopts
only an identity or exact role assignment already visible through canonical
readback; otherwise it fails as ambiguous instead of redispatching.

Approved plans bind the source workspace, identity application and service
principal IDs, target workspaces, assignment IDs, roles, and scoped observed
state hashes. Identity replacement, duplicate assignments, or role drift
requires a new plan or manual correction.

## Permissions

The deployment principal should be Workspace Admin on the source and target
workspaces. Provisioning requires `Workspace.ReadWrite.All`; role discovery
requires `Workspace.Read.All` or `Workspace.ReadWrite.All`, and role creation
requires `Workspace.ReadWrite.All`. The Fabric tenant setting that permits
service principals to call public APIs must include the deployment principal.

This feature does not manage Azure RBAC or the separate preview item identity
association API.

## References

- [Provision workspace identity](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/provision-identity)
- [Get workspace](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/get-workspace)
- [List workspace role assignments](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/list-workspace-role-assignments)
- [Add workspace role assignment](https://learn.microsoft.com/en-us/rest/api/fabric/core/workspaces/add-workspace-role-assignment)
