# Dev, test, and production promotion

[`reusable-fabric-deploy.yml`](../.github/workflows/reusable-fabric-deploy.yml)
generates an authenticated plan, stores it as an immutable artifact, waits on a
GitHub Environment before apply, and uploads the current plan, checkpoint, and
result. A rerun restores the attempt-1 approved plan and the immediately
preceding checkpoint instead of silently approving new Fabric state.

[`promote-fabric.yml`](../.github/workflows/promote-fabric.yml) calls the
reusable workflow in order for `dev`, `test`, and `prod`. The selected target
is the highest environment reached; later environments run only after the
earlier deployment succeeds.

Recovery fails closed when the immediately preceding apply attempt did not
produce a checkpoint artifact. Start a new workflow run to generate and
approve a fresh plan; do not continue rerunning an attempt with incomplete
mutation evidence.

## Repository variables

Configure:

| Variable | Purpose |
| --- | --- |
| `FABRIC_TENANT_ID` | Entra tenant containing the deployment application |
| `FABRIC_CLIENT_ID` | OIDC-enabled deployment application client ID |
| `FABRIC_DEV_WORKSPACE_ID` | Existing dev workspace ID |
| `FABRIC_TEST_WORKSPACE_ID` | Existing test workspace ID |
| `FABRIC_PROD_WORKSPACE_ID` | Existing production workspace ID |
| `FABRIC_DEV_VARIABLES_JSON` | Optional non-sensitive dev variables |
| `FABRIC_TEST_VARIABLES_JSON` | Optional non-sensitive test variables |
| `FABRIC_PROD_VARIABLES_JSON` | Optional non-sensitive production variables |

Leave a workspace variable empty only when the manifest declares a managed
workspace. Managed workspace creation, update, and capacity assignment still
require their independent workflow flags.

## GitHub Environments

Create `fabric-dev`, `fabric-test`, and `fabric-prod`. Configure required
reviewers, deployment branch rules, and wait timers appropriate to each
environment. At minimum, protect production with required reviewers.

The reusable workflow intentionally places only the apply job behind the
GitHub Environment. Planning remains read-only and produces the artifact that
reviewers approve.

## OIDC

Grant the GitHub repository and relevant environment subjects federated access
to the Entra deployment application. The application needs the Fabric
permissions and workspace roles required by the planned resource types.

## Mutation safeguards

Every mutation input defaults to `false`. Enable only the operations expected
for the promotion. Lakehouse deletion requires both `allow_delete` and
`allow_lakehouse_data_loss`.

Do not reuse a plan across environments. Plans bind the deployment
environment, workspace, source commit, dependency graph, physical IDs, and
observed Fabric state.

## Reuse from another repository

The checked-in workflow uses `uses: ./` because the action and deployment
manifests are in this repository. If the deployment source is moved to another
repository, replace those steps with a pinned Marketplace reference such as
`timarif/FabricGitActions@v1`.
