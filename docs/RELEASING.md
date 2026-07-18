# Marketplace releases

Marketplace releases are built only from reviewed commits on the default
branch. The committed `dist/index.js` is the action runtime; release automation
rebuilds it and fails if the generated file differs.

## Release preparation

1. Update `package.json` and `package-lock.json` to the intended semantic
   version.
2. Run `npm run check` and `npm run package`.
3. Review and commit the source and generated `dist/index.js`.
4. Create and push an annotated immutable tag matching the package version:

   ```bash
   git tag -a v1.2.3 -m "Microsoft Fabric Deploy v1.2.3"
   git push origin v1.2.3
   ```

Do not reuse or move an immutable `vMAJOR.MINOR.PATCH` tag.

## Automated release

[`release.yml`](../.github/workflows/release.yml) verifies that the annotated
tag:

- Uses exact `vMAJOR.MINOR.PATCH` syntax
- Matches the package version
- Resolves to the workflow commit
- Is reachable from the default branch

The workflow then runs the full check, rebuilds the distribution, creates a
release archive and CycloneDX SBOM, generates SHA-256 checksums, attests build
provenance with GitHub artifact attestations, publishes the GitHub release,
and moves the corresponding Marketplace major tag, such as `v1`, to the
verified release commit. Release jobs are globally serialized, and an older
rerun cannot move the major tag behind the highest published semantic version.
An existing GitHub release is repaired only when its recorded target commit
matches the immutable tag commit.

The `marketplace-release` GitHub Environment can require reviewers and restrict
which branches and tags may deploy.

## Verification

Download the release archive, SBOM, and `SHA256SUMS`, then verify checksums:

```bash
sha256sum --check SHA256SUMS
```

Verify GitHub provenance with the GitHub CLI:

```bash
gh attestation verify fabric-deploy-v1.2.3.tar.gz \
  --repo OWNER/REPOSITORY
```

Consumers should pin an immutable version for maximum reproducibility. The
moving major tag is provided for standard Marketplace usage.
