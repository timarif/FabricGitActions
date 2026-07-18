# Security policy

## Supported versions

Security fixes are applied to the latest published release. Upgrade to the
latest immutable `vMAJOR.MINOR.PATCH` tag before reporting a problem that may
already be fixed.

## Reporting a vulnerability

Use the repository's **Security** tab to submit a private vulnerability report
through GitHub Security Advisories. If private reporting is unavailable,
contact the repository maintainers without disclosing exploit details in a
public issue.

Include the affected action version, impact, reproduction steps, and any
suggested mitigation. Remove Fabric tenant data, credentials, tokens, and
confidential workload definitions from the report unless a maintainer provides
an approved private transfer method.

If a credential or token was exposed, revoke or rotate it immediately. Do not
wait for the vulnerability investigation to complete.
