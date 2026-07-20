# Support

Fabric Deploy is a community-maintained GitHub Action. Support is
provided through this repository without a guaranteed response or resolution
time.

## Before opening an issue

Use the latest published release and review the
[roadmap](docs/ROADMAP.md), [promotion guide](docs/PROMOTION.md), and action
inputs in [`action.yml`](action.yml). Confirm whether the failure occurred
during validation, planning, preflight, mutation, or recovery.

## Reporting a problem

Open a GitHub issue with:

- The immutable action version, such as `v1.2.3`
- The workflow run URL and failing step
- The affected Fabric item types and deployment mode
- Sanitized plan, checkpoint, and result artifacts
- Fabric HTTP status, error code, and request ID when available
- Minimal manifest and item metadata needed to reproduce the problem

Never post access tokens, client secrets, GitHub OIDC assertions, connection
strings, credentials embedded in URLs, or confidential item definitions.
Rotate any credential disclosed in an issue or workflow log.

Questions about Fabric tenant settings, capacity, licensing, or service
availability may require Microsoft Fabric support. Problems in this action,
its schemas, examples, or release artifacts belong in this repository.

## Security reports

Do not report suspected vulnerabilities in a public issue. Follow
[`SECURITY.md`](SECURITY.md).
