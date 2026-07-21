# Roadmap

## Phase 1: deployment contract and offline planner

- [x] Node 24 TypeScript Marketplace action scaffold
- [x] Deployment manifest schema
- [x] Explicit non-sensitive variable substitution
- [x] Item-path validation
- [x] Dependency ordering and cycle detection
- [x] Deterministic plan hash
- [x] Per-item content hashing
- [x] Symlink-safe path containment
- [x] Explicit non-sensitive variable map
- [x] JSON plan and GitHub job summary
- [x] Item-level manifest and definition validation

## Phase 2: Fabric connectivity and Lakehouse adapter

- [x] GitHub OIDC authentication
- [x] Service-principal secret fallback
- [x] Configurable Fabric and OneLake endpoints
- [x] Fabric HTTP client with retries and long-running-operation polling
- [x] Lakehouse discovery, create, update, and read-back verification primitives
- [x] Real Lakehouse create/update/no-op classification during authenticated plans
- [x] Approved-plan integrity, source binding, and Fabric drift detection
- [x] Full-plan preflight and explicit create/update safeguards
- [x] Guarded `apply` mode wiring for Lakehouse mutations
- [x] Checkpoint and result artifacts
- [x] Live sandbox validation with OIDC

## Phase 3: core data engineering adapters

- [x] Managed workspace provisioning and capacity assignment
- [x] Environment definition and publish
- [x] Notebook definition deployment
- [x] Lakehouse table DDL deployment
- [x] Workspace custom Spark pool deployment
- [x] Spark Job Definition deployment
- [x] Logical reference resolution
- [x] Data Pipeline definition deployment and folder-drift blocking
- [x] Guarded on-demand Data Pipeline job execution (`run-pipeline` mode)

## Phase 4: production hardening

- [x] Guarded soft deletion for Environment, Notebook, Spark Job Definition, Data Pipeline, and Semantic Model items
- [x] Lakehouse deletion with an independent data-loss safeguard
- [x] OneLake staging for Spark Job JVM executables and JAR libraries
- [x] Fabric tag catalog creation and additive item assignment
- [x] Lakehouse schema creation
- [x] Live sandbox E2E suite
- [x] Reusable dev/test/prod workflow
- [x] Marketplace release automation, provenance, and support documentation

## Phase 5: workspace network protection

- [x] Expansion plan and remaining Fabric item inventory
- [x] Outbound access protection communication policy
- [x] Outbound cloud connection and gateway rules
- [x] Guarded managed private endpoint create/delete, checkpoint, and recovery
- [x] Guarded declarative inbound IP firewall rules
- [x] Guarded declarative inbound Azure resource instance rules
- [x] Guarded declarative inbound External Data Shares bypass policy
- [x] Network recovery
- [ ] Disposable managed private endpoint live validation

## Phase 6: Power BI

- [x] Semantic Model TMSL/TMDL definition deployment implementation
- [x] Semantic Model live Fabric create/no-op/update validation
- [x] Power BI report deployment and Semantic Model binding
- [ ] Power BI report deletion with stable identity proof
- [x] PBIR report live create/no-op/update validation
- [ ] PBIR-Legacy report live create/no-op/update validation

## Phase 7: Real-Time Intelligence

- [x] Eventhouse manifest validation and authenticated discovery
- [x] Eventhouse guarded create/update/no-op apply and LRO recovery
- [x] Eventhouse immutable minimum-consumption drift blocking
- [x] Eventhouse disposable live create/no-op/update validation
- [x] KQL Database manifest validation and logical Eventhouse parent binding
- [x] KQL Database guarded create/update/no-op apply and LRO recovery
- [x] KQL Database immutable parent and database-type drift blocking
- [x] KQL Database disposable live create/no-op/update validation
- [x] Eventstream definition deployment and guarded create/update/no-op apply
- [ ] KQL Queryset and KQL Dashboard adapters

## Phase 8: Data Warehouse adapter

- [x] Warehouse manifest validation and authenticated discovery
- [x] Warehouse guarded create/update/no-op apply and LRO recovery
- [x] Warehouse immutable collationType drift blocking
- [x] Warehouse disposable live create/no-op/update validation
- [ ] WarehouseTables T-SQL DDL companion (deferred — requires separate TDS/ODBC
  auth channel distinct from the Fabric REST API; see
  [implementation notes](PHASE5_PLAN.md))
- [ ] Warehouse guarded deletion (deferred — requires confirming hardDelete
  behaviour through the warehouse-specific DELETE endpoint)

## Phase 9: Copy Job adapter

- [x] Copy Job definition loader, validator, and semantic hasher (`copyjob-content.json`, optional `.platform`)
- [x] Managed desired definition limited to `properties.jobMode` (`Batch` or `CDC`); extra fields are rejected to prevent hidden normalization drift
- [x] Folder semantics: `folderId` accepted at creation; folder moves blocked because `UpdateCopyJobRequest` has no `folderId`
- [x] Immutable `jobMode` drift blocking; `resetCopyJob` is never called automatically
- [x] `.platform` `config.logicalId` sentinel policy: only absent or the zero GUID is accepted, and the sentinel is stripped before hashing
- [x] Existing Copy Jobs use metadata PATCH only; `updateDefinition` is never called, with or without `.platform`
- [x] `.platform` and other unapplyable definition drift is blocked and requires recreation
- [x] Configured service readback is projected to the managed `jobMode` surface before hashing, excluding portal-managed activities, connections, and policies
- [x] Checkpointed create and metadata-update recovery
- [x] Copy Job planning, apply, verification, and guarded `desiredState: absent` deletion support
- [x] Schema and example fixture support
- [ ] Dataflow adapter

See [the Fabric platform expansion plan](PHASE5_PLAN.md) for the prioritized
Real-Time Intelligence, warehouse/database, Data Factory, platform,
application, additional Power BI, and service-principal-blocked item inventory.

### API-confirmed constraint: Data Pipeline folder moves

The Fabric `UpdateDataPipelineRequest` schema (authoritative source:
[`microsoft/fabric-rest-api-specs:dataPipeline/definitions.json`](https://github.com/microsoft/fabric-rest-api-specs/blob/main/dataPipeline/definitions.json))
contains only `displayName` and `description` — there is **no `folderId` field**.
Folder placement is fixed at creation and cannot be changed via
`PATCH /dataPipelines/{id}`.

The planner correctly classifies folder drift as `action: "blocked"` with a
descriptive error that names both the current and target folder and cites the
API limitation. A future lifecycle-management PR could implement folder move
via item recreation (delete + create in target folder), but this carries
data-loss risk and requires an explicit manifest-level acknowledgement flag.
