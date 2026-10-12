---
applyTo: "package*.json,packaging/**,.github/workflows/**,.agents/plugins/**,.claude-plugin/**,plugins/**,claude/**,release.json,README.md,LICENSE.md,.gitignore,.gitattributes,scripts/*package*.mjs,scripts/release*.mjs,scripts/install*.mjs,scripts/marketplace*,scripts/publish-marketplace*,scripts/published-marketplace*.mjs,scripts/check-release-source.sh,scripts/plugin-manifest*.mjs,scripts/client-fixture/package*.json,scripts/client-smoke*.mjs,scripts/smoke-environment*.mjs,references/distribution.md,.agents/publishing.md,references/verification.md"
---

<!-- agent-guidance-sync:generated:v1 source=".agents/rules/distribution.md" target=".github/instructions/agent-guidance/distribution.instructions.md" -->

# Distribution and releases

`scripts/install.mjs`, `scripts/package*.mjs`, `scripts/release*.mjs`,
`scripts/publish-marketplace.sh`, `scripts/marketplace-notice.sh`,
`scripts/check-release-source.sh`, `packaging/`, and `.github/workflows/` implement
installation, packages, releases, and CI.
Follow [distribution](/references/distribution.md) and
[publishing](/.agents/publishing.md), together with the shared boundaries in
the root [repository guidance](/AGENTS.md).

## Package and release boundaries

- `scripts/marketplace-layout.mjs` defines generated-package paths on `main`.
  Publish changed product content as a new version only when authorized. See the
  [publication boundary](/.agents/publishing.md#publish-the-github-marketplace).
- For version changes, align `package.json`, `package-lock.json`, and both client
  plugin templates. Update release notes and release links for that version.
  Distinguish the development source version from the published marketplace
  version recorded in `release.json`; they can legitimately differ before
  publication. Do not rewrite the published version to match development source.
- An inventory verifies internal file consistency, not release provenance. An
  inventory and its payload can be changed together. Use trusted release
  checksums and the publication process when making authenticity claims.
- Follow the publishing guide's privacy and repository-history checks before an
  authorized publication.

## Verification

For packaging changes, verify detached packages and run `npm run release:build`.
Builders refuse existing output directories: use a fresh destination with
`-- --out /absolute/fresh-output` instead of deleting prior artifacts. Check
generated inventories and archives, including the absence of maintenance-only
files and development dependencies. Source dependency changes must not leak tools
into runtime dependency closure.

Real-client smoke checks download locked CLIs without lifecycle scripts into
temporary profiles; run them explicitly with `node scripts/client-smoke.mjs`.
They must never use the user's real profile, authentication, capture settings, or
hook trust. Preserve the CI separation between these third-party client checks
and artifact-producing jobs. Apply the root
[development and verification rules](/AGENTS.md#development-and-verification)
for CI portability and evidence limits.
