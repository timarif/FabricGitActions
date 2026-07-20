# Contributing

Thank you for contributing to Fabric Deploy.

## Development setup

1. Install Node.js 24.
2. Run `npm ci`.
3. Create a focused branch from `main`.
4. Make the smallest complete change that addresses the issue.

## Required checks

Run the repository checks before opening a pull request:

```bash
npm run check
npm run package
git diff --exit-code -- dist/index.js
git diff --check
```

`dist/index.js` is the committed GitHub Action runtime. Include an updated
bundle whenever source changes affect the action.

## Pull requests

- Add or update tests for behavior changes.
- Update schemas, examples, and documentation when their public contract
  changes.
- Keep mutation safeguards disabled by default.
- Do not include tenant data, workspace or capacity identifiers, credentials,
  tokens, connection strings, or confidential Fabric definitions.
- Keep unrelated refactoring out of feature and bug-fix pull requests.

Security vulnerabilities must be reported privately as described in
[`SECURITY.md`](SECURITY.md), not through a public issue.
