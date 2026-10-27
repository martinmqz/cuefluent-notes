# Maintaining and preparing Cuefluent Notes packages

Repository maintenance guidance; excluded from installed plugins. Product setup
and native registration are documented in [limits](../references/limits.md)
and [setup](../references/setup.md).

## Source and published artifacts

The source is `src/`, the root skill, and the four installed references.
`packaging/plugin/source-files.json` is the explicit runtime input list. Update it when
adding a runtime module; build checks reject missing relative imports. Client
descriptors live under `packaging/plugin/{codex,claude}/`. Both packages contain one
native skill at `skills/cuefluent-notes/SKILL.md`; Claude has no duplicate command
file. Development tools, tests, repository guidance, and private planning are not
part of either plugin.

The source package version is separate from the historical published version in
`release.json`. Preserve published `plugins/`, `claude/`, their checksums, tags,
and release assets byte-for-byte. Candidate builds never update those paths or
reconstruct a historical release using today's source list. Missing historical
assets may be recovered only when their original trusted checksums match.

Keep real notes, conversation data, private configuration, secrets, credentials,
and authentication caches outside the checkout. Commit synthetic fixtures only,
and never copy private conversations into the repository. Before changing
repository visibility, inspect history and retained Actions artifacts as well
as the current tree. Visibility and repository security changes are separate
maintainer actions.

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

## Marketplace snapshots

The Codex and Claude catalogs select the released 0.19.0 packages at
`plugins/0.19.0/cuefluent-notes/` and `claude/0.19.0/cuefluent-notes/`.
`packaging/releases/0.19.0/build.json` is the unchanged build receipt from the
[published release](https://github.com/martinmqz/cuefluent-notes/releases/tag/v0.19.0).
Its inventory hashes bind every catalog package file, including dependencies.
The versioned 0.16.0, 0.17.0 and 0.18.0 snapshots and receipts remain intact. The
unversioned package folders and root `release.json` retain the 0.15.1 release.

For a catalog update, verify the published archive and receipt digests against
the published release, extract into a fresh temporary directory, and use the
verified copy tool above to add new versioned folders. Copy the published receipt
unchanged under `packaging/releases/VERSION/build.json`. Add its independently
verified SHA-256 to `published.releases` in `test/marketplace.test.mjs`; preserve
all earlier pins and snapshots. Point both catalogs at the same new version.
A receipt and inventory edited together are not independent release evidence.

The directory-wide `.gitattributes` rules preserve every release's bytes, while
`.gitignore` excludes `plugins/` and `claude/` from ordinary source searches.
New versions need no additional attribute or ignore rules. Plain `git add` can
omit ignored bundled dependencies, so force-stage only the exact new package
folders. For example, when adding the 0.19.0 release:

```sh
git add -f -- plugins/0.19.0/cuefluent-notes claude/0.19.0/cuefluent-notes
git add -- .agents/plugins/marketplace.json .claude-plugin/marketplace.json packaging/releases/0.19.0/build.json test/marketplace.test.mjs
node --test test/marketplace.test.mjs
```

Substitute the actual new version in these paths and inspect the staged diff
before committing. The test requires catalog files, receipts and complete package
contents to be staged. It checks every retained release, including historical
0.15.1, against pinned receipts and inventories, and verifies that tracked working
bytes equal their Git blobs. Missing dependencies, changed retained files and
mixed catalog versions fail locally. Untracked OS housekeeping files are ignored;
if staged, extra package files fail the inventory check.

These offline checks protect the reviewed release pins; they do not query GitHub
or authenticate a newly added pin. Check each new pin against the published asset
before committing it. The tests do not install a native plugin, change trust, or
activate tracking. Native registration remains a separate user action.

## CI evidence limits

[Checks](../.github/workflows/ci.yml) pins Node 26.12.1 and exact upstream action
commits. For ready PRs, a short planning job classifies the exact merge change
against the checked-out merge commit's first parent. The checkout must match
the run's `GITHUB_SHA` and its second parent must match the event's PR head.
The event's base SHA can be stale and is not used to select the diff base.
Both planning and final verification execute the classifier and its tool imports
from that first parent's tree in a temporary directory. A PR cannot grant itself
an exemption by changing its classifier or allowlist. A base without the
classifier selects full checks, as do manual runs and non-main targets. Workflow
changes themselves still require review; this is not protection against arbitrary
rewrites of the Actions workflow. The Git readers ignore inherited repository
redirection, replacement refs, global/system configuration, hooks and fsmonitor.
Source, dependency, runtime guidance, package version,
build-tool, test and workflow changes run the complete synthetic suite on native
Linux, macOS, and Windows. The two marketplace test files and development
guidance have a separate distribution-only path described below. Ready PRs are
checked when opened, updated, reopened, or marked ready for review.
Draft PR events skip every job before runner allocation. Converting a PR back to
draft cancels its active Checks run. Merging into `main` does not repeat the matrix.
Required PR checks protect ordinary merges. The separate
[Main evidence workflow](../.github/workflows/main-evidence.yml) also checks every
push to `main`, including direct pushes and administrator bypass merges. Its one
read-only Ubuntu job verifies successful Checks evidence for the exact pushed
tree using the retained source receipt and one digest-verified primary artifact.
A complete valid full artifact set takes precedence over path classification,
including after a multi-commit rebase merge. Its source receipt still must bind
the tested and merged trees exactly. Partial, expired or malformed artifacts fail.
Only artifact-free runs may use distribution ancestry: it verifies each merged
PR's focused checks and first-parent diff, then walks at most ten such commits
to the last full-check tree. The PR gate allows at most nine existing hops,
reserving the tenth for its pending merge. Selection records retain changed-file
counts instead of full path lists. Independent API reads run concurrently and
workflow metadata is fetched once per walk; verification starts a fresh walk and
rechecks current PR, run, job and artifact facts.
Every intermediate commit needs its own evidence; a multi-commit rebase of
an artifact-free PR can require an explicit full Checks dispatch for recovery.
It never substitutes an older green run for a newer failed or pending run.
It runs no tests, native clients, or builds. Missing or mismatched evidence fails
visibly; explicitly run Checks for that commit, then rerun the failed Main evidence
job. Release preparation independently verifies the tested source against the
release tag. Manual Checks dispatch remains available.
Linux and macOS each run one source job; Windows runs four shards on
independent runners. Per-platform duration weights place the longest Windows
test files first into the least-loaded shard. Both `npm test` and CI use `tools/test.mjs`
for recursive test discovery. Test discovery determines coverage; new files
without measurements still run with a file-size estimate. Windows runs test files
sequentially within each shard to limit native helper contention; concurrency
exercised by the tests is preserved.
Guidance starts alongside planning. After planning, all source shards and client
smoke jobs can start concurrently; no platform waits for another platform. The
required reproducibility gate waits for every shard and smoke job and rejects
failed or unexpectedly skipped checks. It does not waive queue, gate, worker,
or filesystem tests on Windows.
Tests may explicitly exercise an unsupported native adapter or skip an actual
platform-specific primitive. CI does not establish native client isolation, MXC
sandbox availability, model access, or public-file security privileges. Separate
Windows native checks cover the explicit Codex MXC floor and a complete Claude
owned-worker draft → review → save flow; see the platform limits in
[limits](../references/limits.md).

One primary shard per platform runs `tools/ci.mjs build` after its tests. This
builds fresh candidates, verifies packages, exercises the actual detached
`settings` command against a new absent private store, and checks checksum-bound
copying. The unconfigured command must create no store. Timing weights cover
test work; dependency setup, the primary shard's build and artifact upload, and
final reproducibility add to total runtime. Hosted runner availability also
affects elapsed time.
The reproducibility job verifies every retained archive against its receipt and
compares all three receipts, including companion tools. Each primary build also
records the actual checked-out commit and Git tree, run identity, PR identity,
and build receipt digest in a separate `source.json`. This provenance stays out
of the deterministic receipt. Candidates are retained for 30 days. Guidance
checks run in a separate job. Separate
macOS and Windows client smoke jobs exercise Claude Code 2.1.309 and Codex CLI
0.163.0, with exact archive integrity pins in `tools/client-smoke.mjs`. The
[adapter compatibility contract](../references/limits.md) describes the
Claude Code 2.1.307 baseline and capability admission for newer stable 2.x clients.
Smoke checks use disposable profiles without authenticated sessions or model
calls. They do not establish plugin installation, hook trust, or end-to-end
client acceptance.
These required smoke checks
download native archives from `registry.npmjs.org`; a transient registry or
network failure fails the smoke check and required gate and may require a rerun.
No native client downloads, credentials, model calls, installations, or
hook-trust changes are part of artifact-producing jobs.

The retained artifact identities are `candidate-ubuntu-24.04`,
`candidate-macos-14`, and `candidate-windows-2025`. Reproducibility, Main evidence,
PR base evidence, and release preparation require this one exact set and a
successful `plan` job. Plan-less runs are ineligible even if they contain the
expected artifacts. Retained artifacts with other names cannot satisfy these
checks; they are neither renamed nor deleted. The first full Checks run with these names establishes evidence for
its tested tree. It does not establish evidence for earlier trees. Distribution-only
base reuse must reach a full run with these names through its verified ancestry.
Rerunning an unchanged historical workflow that emits different names cannot
repair the mismatch. Published archives, snapshots, tags, and receipt pins remain
immutable and keep their existing verification protections.

### Distribution-only changes

A ready PR targeting `main` and confined to published snapshots, catalogs, release
receipts, the two marketplace test files, and development guidance runs
`check:guidance` plus `test/marketplace.test.mjs` on Linux, macOS, and Windows. It runs no source suite,
native client download, candidate build, or artifact upload. The exact allowlist
is in `tools/ci-plan.mjs`. Shipped skill/reference files, README, package/lock
versions, workflow/build tools, `.gitattributes`, and `.gitignore` require full
checks. Other target branches, manual dispatch and empty changes also select full
checks: evidence reuse is defined only for main history.
The three native marketplace rows use only Node built-ins and skip dependency
installation. Unsupported or undecodable Git paths select full checks; portable
paths use the same validation as package paths. Only the final gate receives
Actions and pull-request read permissions; other jobs retain contents read only.

All existing required check names remain present. Unneeded secondary shards and
smoke jobs report why no native work ran on lightweight Ubuntu runners. Their
success is accepted only by a final gate that independently reclassifies the
change, requires all three native marketplace checks and guidance to pass, and
verifies successful full-check evidence for the actual PR base. Missing, expired,
failed or mismatched evidence fails that gate; it never silently starts a matrix.
For a base-evidence failure, refresh full Checks evidence for the base on main
(updating the PR to that tested base if main has advanced), then rerun the failed
PR Checks job. Rerunning Main evidence alone does not repair a failed PR gate.
These runs have no candidate artifacts and cannot be selected for release
preparation. Previously published bytes and independently verified receipt pins
retain their existing marketplace protections.

Passing CI establishes the tested synthetic and packaging behavior. It does not
prove native desktop command rendering, live hook activation, native processing
isolation on an unaudited platform, reboot recovery, Cuefluent corpus admission,
or search ranking. Local checks, current-revision CI results, pending jobs, and
native acceptance evidence are separate kinds of evidence. Product limits belong
in [limits](../references/limits.md).

## Manual release preparation

Set the next release's final version in the first ordinary feature or fix PR of
the cycle, updating `package.json` and both root lockfile version fields together.
For example, use `0.17.0` throughout its development cycle, then `0.17.1` for a
patch or `0.18.0` for the next minor cycle. Do not create a separate preparation
PR or use a development suffix merely to change it before publication. Real
prerelease versions such as `0.17.0-rc.1` remain supported.

Once an implementation PR is merged and its Checks and Main evidence succeed:

1. Select that green main commit and its retained full Checks run.
2. Create the exact version tag on that commit.
3. Dispatch the release preparation workflow below to reuse its tested archives.
4. Review the candidate and publish the release from those same bytes.
5. Open a marketplace PR using the verified published archives and receipts.
   That PR runs the focused distribution checks, then Main evidence on merge.

There is no release-purpose local suite, rebuild, or repeated detached-package
check: the retained native CI candidates provide that evidence. Marketplace
copying still checks published digests and runs its targeted test locally before
pushing. A forgotten version bump requires a normal checked change before a new
tag can be created; existing tags and published packages are never replaced.

Pushing a branch or tag does not publish a release or update a marketplace.
The former release-published marketplace writer is removed. The
[release preparation workflow](../.github/workflows/release.yml) has only a manual
`workflow_dispatch` trigger, requires dispatch from `main` and an explicit
confirmation. Supply an existing exact version tag (`v` plus the tagged
`package.json` version, for example `v0.16.0`) and a successful Checks run ID.
The single Ubuntu job verifies tag/package agreement and main-history ancestry,
then downloads the three exact retained artifact IDs with GitHub digest checking.
It verifies every archive hash, identical platform receipts, the tagged lockfile,
and the actual tested Git tree. It neither rebuilds nor reruns the test matrix.

A PR run must come from this repository, have merged into `main`, and match the
recorded PR head and tested merge checkout. The PR head and tested checkout trees
must both equal the tagged tree; this conservative rule refuses reuse when the
PR head had different files even if its merge result matched. A manual Checks
run on `main` or the exact release tag must match the tag commit. Push events are
not accepted as source evidence. Every expected job, including `plan` and
all Windows shards, must have succeeded. Earlier successful artifact-producing
attempts remain valid when only failed jobs are rerun. The selected run, tag, and
artifact identities are checked again before accepting the candidate. The verifier
pins the supported GitHub API representation that includes the merged commit SHA.
Failures report their verification stage and a bounded reason code, including HTTP
status and ancestry failures, without printing tokens or downloaded payloads.

Missing, expired, incompatible, or incomplete evidence stops preparation. When
fresh evidence is required, explicitly dispatch Checks on the existing release
tag. This tests the tagged commit even after `main` advances; the tag must contain
the current candidate artifact names, successful planning, and source-recording
support. A historical tag whose workflow emits different artifact names is ineligible for current
automated preparation, including after a rerun; do not move the tag or relabel its
retained evidence. A dispatch on `main` is also accepted when its tip is
exactly the tagged commit. Preparation verifies main-history ancestry and never
silently launches another full matrix. Candidates created before source provenance
was recorded are not eligible for this automated reuse.
Keep the intended package version in the ordinary implementation PR so its full
checks already cover the exact release bytes. Tag a commit with full candidate
artifacts, not a later distribution-only merge.

Verification tools come from the `main` dispatch checkout. Downloaded
candidate code is never executed. The output preserves the verified archives and
`build.json`, with a `release-evidence.json` identifying the tag, source run, and
artifact digests. Repository permissions remain read-only. The workflow creates
no GitHub release, commit, branch, PR, or marketplace update.

Publication is a separate maintainer action that follows review of those
artifacts and native acceptance evidence. It preserves immutable historical
bytes, uses reviewed checksums, and keeps GitHub releases, native marketplace
registration, public directory submissions, and repository visibility as
distinct actions. Merges follow the repository's branch protection.

## Revisions

### 2026-10-23

- Set the next final package version during ordinary development, reuse verified
  artifacts at release time, and use focused checks for distribution-only PRs.
- Evaluate exemptions with the base revision's policy, keep permissions scoped
  to the jobs that need them, and omit dependency installs from marketplace rows.
- Preserve complete full evidence after rebase merges; bound distribution walks
  and reserve capacity for a pending merge. Keep evidence records compact and
  revalidate current facts before accepting reuse.

### 2026-10-24

- Point both catalogs at the verified 0.17.0 release snapshots and retain the
  independently verified receipt pin alongside all historical release pins.
- Use neutral CI artifact and concurrency names, with one exact candidate set
  shared by producers and evidence readers. Existing artifacts under other names
  remain retained but cannot supply current automated evidence.
- Advance both catalogs to the verified 0.18.0 release snapshots and add its
  independently verified receipt pin, preserving all earlier snapshots and pins.

### 2026-10-26

- Advance both catalogs to the verified 0.19.0 release snapshots and add its
  independently verified receipt pin, preserving all earlier snapshots and pins.
