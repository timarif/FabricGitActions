# Fabric-managed Virtual Network data gateways

Fabric Deploy manages Microsoft-managed Virtual Network data gateways through
the tenant-level Fabric gateway API:

```text
POST   /v1/gateways
GET    /v1/gateways
GET    /v1/gateways/{gatewayId}
PATCH  /v1/gateways/{gatewayId}
DELETE /v1/gateways/{gatewayId}
```

The deployment principal needs `Gateway.ReadWrite.All`; updates and deletions
also require gateway admin permission. Service principals and managed
identities are supported by the Fabric API.

## Manifest

```yaml
workspace:
  id: ${var.FABRIC_WORKSPACE_ID}

virtualNetworkGateways:
  - logicalId: primaryGateway
    displayName: Fabric Deploy Managed VNet Gateway
    capacityId: ${var.FABRIC_CAPACITY_ID}
    virtualNetworkAzureResource:
      subscriptionId: ${var.AZURE_SUBSCRIPTION_ID}
      resourceGroupName: fabric-network
      virtualNetworkName: fabric-vnet
      subnetName: fabric-gateway
    inactivityMinutesBeforeSleep: 30
    numberOfMemberGateways: 2

items: []
```

`workspace.id` or the action's `workspace-id` input remains required as the
deployment context even when a manifest contains only global gateways.

Use exactly one scaling mode:

- Fixed: `numberOfMemberGateways`
- Autoscaling: `minMemberGatewayCount` and `maxMemberGatewayCount`

Every count must be an integer from 1 through 9. The minimum cannot exceed the
maximum. Supported sleep values are `30`, `60`, `90`, `120`, `150`, `240`,
`360`, `480`, `720`, and `1440`.

## Planning and drift protection

Name discovery is case-insensitive and fails closed when multiple gateways
match. An explicit `id` is authoritative: a missing explicit ID is blocked and
is never recreated by name.

The following placement properties are immutable:

- Azure subscription
- Resource group
- Virtual network
- Subnet

Placement drift produces a blocked plan. Display name, capacity, inactivity
timeout, and member scaling are mutable.

Plan and apply hash canonical desired and observed state. Apply repeats live
discovery immediately before each new mutation and rejects drift after
approval.

## Guarded apply and recovery

The safeguards are independent and fail closed:

```yaml
allow-vnet-gateway-create: "true"
allow-vnet-gateway-update: "true"
allow-vnet-gateway-delete: "true"
```

Create, update, and delete intent is checkpointed before dispatch. Accepted
physical IDs are persisted before read-back verification. Recovery never
blindly repeats an ambiguous mutation:

- Create recovery requires one exact matching gateway or an accepted ID.
- Update recovery succeeds only when the exact approved ID already matches.
- Delete recovery succeeds only when the exact approved ID is absent.

Deletion requires `desiredState: absent`, an exact gateway `id`, and matching
display-name and virtual-network placement proof.

Present gateways run before workspace network protection. Absent gateways run
after configured outbound gateway rules are verified, allowing an approved
deployment to remove a gateway ID from the workspace allow list before the
gateway is deleted. If outbound protection is deferred, deletion remains
pending for a fresh plan.

## Azure prerequisites and VM scope

The Azure VNet, subnet, delegation, routing, DNS, and capacity must be prepared
outside this action. Fabric Virtual Network data gateways are hosted and
managed by Microsoft; they cannot attach to a customer VM.

A gateway installed on a VM is an on-premises data gateway. Its interactive
registration and machine lifecycle are separate from the Fabric-managed
gateway API and are not provisioned by Fabric Deploy.
