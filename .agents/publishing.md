# Maintaining and preparing Cuefluent Notes packages

Repository maintenance guidance; excluded from installed plugins. Product setup
and native registration are documented in [distribution](../references/distribution.md)
and [setup](../references/setup.md).

## Source and published artifacts

V2 source is `src/`, the root skill, and the seven installed workflow references.
`packaging/v2/source-files.json` is the explicit runtime input list. Update it when
adding a runtime module; build checks reject missing relative imports. Client
descriptors live under `packaging/v2/{codex,claude}/`. Both packages contain one
native skill at `skills/cuefluent-notes/SKILL.md`; Claude has no duplicate command
file. Development tools, tests, repository guidance, and private planning are not
part of either plugin.

The source package version is separate from the historical published version in
`release.json`. Preserve published `plugins/`, `claude/`, their checksums, tags,
and release assets byte-for-byte. Candidate builds never update those paths or
reconstruct a historical release using today's source list. Missing historical
assets may be recovered only when their original trusted checksums match.

Keep real notes, conversation data, private configuration, secrets, credentials,
and authentication caches outside the checkout. Commit synthetic fixtures only.
Use ignored `.local/` for repository-owned audits and implementation notes; it
does not authorize copying private conversations into the repository. Before
changing repository visibility, inspect history and retained Actions artifacts as
well as the current tree. Visibility and repository security changes require
separate authorization.

## Local verification and fresh builds

Use Node **26.12.1** or a newer supported Node 26 patch. Full maintenance checks
also require npm, Git, Bash, `tar`, and `unzip`. PowerShell users can invoke
`npm.cmd` when required by their shell policy.

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
npm run check:examples
node tools/packaging.mjs build /absolute/fresh-output
```

The output directory must not exist and must be outside the source checkout.
Choose a new name for another build. The builder reads the exact production
dependency graph in lockfile v3, verifies each cached npm tarball against its
SHA-512 integrity, and includes the package's complete distributed files and
license notices. It does not run dependency lifecycle scripts or fetch packages.
`npm ci --ignore-scripts` prepares the cache. For a custom cache, supply
`--cache-root /absolute/npm-cache`; npm cache environment overrides are also
honored. Missing or corrupt tarballs fail before output publication.

Each build contains:

```text
codex/cuefluent-notes/              # Complete detached plugin
claude/cuefluent-notes/             # Complete detached plugin
cuefluent-notes-VERSION-codex.{zip,tar.gz}
cuefluent-notes-VERSION-claude.{zip,tar.gz}
cuefluent-notes-VERSION-tools.{zip,tar.gz}
build.json                        # Version, lock digest, inventory/archive hashes
```

Plugin trees include root runtime dependencies, a production-only lockfile,
third-party notices, source modules, client descriptors, and installed guidance.
The companion tools archive contains `install.mjs`, `packaging.mjs`, and usage
instructions; its closure uses Node built-ins only. It is separate from the
installed plugin. Sorted paths, fixed archive timestamps and permissions, and a
normalized gzip header make archive bytes deterministic for the pinned runtime.

## Verify and copy an explicit package

Obtain the archive and inventory hashes from an independently trusted build or
release receipt. An inventory by itself proves internal consistency, not release
authenticity. Verify downloaded archive hashes before executing companion tools.

```sh
node tools/packaging.mjs verify /absolute/package --expected-inventory-sha256 HASH
node tools/install.mjs /absolute/package /absolute/FRESH-destination --expected-inventory-sha256 HASH --client codex
```

The standalone companion uses the same arguments with `node packaging.mjs` and
`node install.mjs`. A copied package retains all verified bytes and dependencies.
The destination is mandatory, its parent must exist, and the final destination
must be absent. Existing files, folders, and prior versions are never overwritten
or removed. A failed partial copy remains inspectable and is refused on retry;
choose a fresh destination. No client locations are guessed, no native plugin is
registered, and no hook trust, project settings, or authentication is changed.
Native registration and hook review are separate explicit user actions. Copying
a package enables neither tracking nor note processing.

## CI evidence limits

[Checks](../.github/workflows/ci.yml) pins Node 26.12.1 and exact upstream action
commits. It runs the complete synthetic source suite on native Linux, macOS, and
Windows. It does not waive queue, gate, worker, or filesystem tests on Windows.
Tests may explicitly exercise an unsupported native adapter or skip an actual
platform-specific primitive. CI does not establish native client isolation, MXC
sandbox availability, model access, or public-file security privileges. Separate
Windows native checks cover the explicit Codex MXC floor and a complete Claude
owned-worker draft → review → save flow; see the platform limits in
[verification](../references/verification.md).

Every platform builds fresh candidates and runs `tools/ci.mjs build`: package
verification, the actual detached `settings` command against a new absent private
store, and checksum-bound copying. The unconfigured command must create no store.
The reproducibility job verifies every retained archive against its receipt and
compares all three receipts, including companion tools. Guidance checks run in a
separate job and are omitted for an explicitly selected release tag. No native
client downloads, credentials, model calls, installations, or hook-trust changes
are part of artifact-producing jobs.

Passing CI establishes the tested synthetic and packaging behavior. It does not
prove native desktop command rendering, live hook activation, native processing
isolation on an unaudited platform, reboot recovery, Cuefluent corpus admission,
or search ranking. Report local checks, current-revision CI results, pending jobs,
and separate native acceptance evidence distinctly. Product limits belong in
[verification](../references/verification.md).

## Manual release preparation

Pushing a branch or tag does not publish a v2 release or update a marketplace.
The former release-published marketplace writer is removed. The
[release preparation workflow](../.github/workflows/release.yml) has only a manual
`workflow_dispatch` trigger, requires dispatch from `main` and an explicit
confirmation. It accepts an
existing exact v2 tag, verifies that the tag matches `package.json`, and requires
its commit to be on `main` history before executing source tools. It runs the
three-platform checks and uploads candidate artifacts with read-only repository
permissions. It creates no GitHub release, commit, branch, PR, or marketplace
update.

Review those artifacts and native acceptance evidence before requesting a
separate publication action. Any future publication must be explicitly
authorized, preserve immutable historical bytes, use reviewed checksums, and keep
GitHub releases, native marketplace registration, public directory submissions,
and repository visibility as distinct actions. Create package-update PRs as
drafts; never merge, mark ready, or bypass repository rules without authorization.
