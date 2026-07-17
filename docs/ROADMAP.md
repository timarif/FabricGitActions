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
- [ ] Live sandbox validation with OIDC

## Phase 3: core data engineering adapters

- [x] Environment definition and publish
- [ ] Notebook definition deployment
- [ ] Spark Job Definition deployment
- [ ] Logical reference resolution
- [ ] Data Pipeline definition deployment

## Phase 4: production hardening

- [ ] Explicit deletion and Lakehouse data-loss guard
- [ ] OneLake staging for supported libraries
- [ ] Live sandbox E2E suite
- [ ] Reusable dev/test/prod workflow
- [ ] Marketplace release automation, provenance, and support documentation
