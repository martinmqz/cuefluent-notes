# Publishing Cuefluent Notes

There are two distribution steps: publish our GitHub-hosted marketplace, then
apply separately for OpenAI and Claude public listings. A GitHub release does
not grant either public listing. Publisher credentials and portal submissions
are not part of this repository or its automation.

## Public repository hygiene

Keep real user notes, captured session evidence, private capture configuration,
secrets and credentials outside this repository, including ignored directories.
Keep implementation plans, review notes, synthetic-test results, dated validation
logs, internal process history and machine-specific paths in ignored `.local/`;
exclude them from commits and package inputs. Authorized installed-plugin checks
do not permit copying real captured content into `.local/`. Commit only synthetic
examples. Before making a repository public, inspect its Git and pull-request
history as well as retained Actions logs and artifacts; deleting a file from the
current branch does not remove history.

Require pull requests and passing CI on `main`, prevent force pushes and branch
deletion, and enable secret scanning and push protection when GitHub supports
those settings. Publication prepares a package-update PR whose CI requires
maintainer approval; it does not push to `main`, bypass branch rules or merge the
PR. Keep workflow tokens read-only by default and actions pinned. Repository
visibility and security settings are separate from publishing a plugin release.

## Build and inspect a release

From the source checkout, use Node.js 22+, Git, Bash, and `unzip`/`tar` for the
extraction tests:

```sh
npm ci --ignore-scripts
npm test
npm run check:examples
npm run release:build
```

The builder creates a fresh `dist/release`; use `-- --out /absolute/fresh-output`
for another build. It never installs, changes hook trust, writes capture settings,
or publishes. Each plugin has its complete runtime and third-party notices.

```text
dist/release/
  .agents/plugins/marketplace.json       # Codex catalog
  .claude-plugin/marketplace.json        # Claude catalog
  plugins/cuefluent-notes/               # Codex hook-enabled plugin
  claude/cuefluent-notes/                # Claude hook-enabled plugin
  README.md
  release.json                          # version, ZIP and inventory digests
  artifacts/
    cuefluent-notes-VERSION-codex-hooks.zip
    cuefluent-notes-VERSION-codex-manual.zip
    cuefluent-notes-VERSION-claude-hooks.zip
    cuefluent-notes-VERSION-claude-manual.zip
    cuefluent-notes-VERSION-marketplace.tar.gz
    SHA256SUMS
```

Every ZIP contains one top-level `cuefluent-notes/` folder, including its hidden
client manifest. The snapshot contains both catalogs and hook packages, excluding
the artifacts directory. The builder uses pinned JavaScript archive libraries,
sorted file paths, fixed 1980 timestamps, normalized file permissions and ownership,
and a timestamp-free gzip header. The same source and locked dependencies produce
identical archive bytes across supported hosts. Manual packages use the already-built
hook packages, removing hook registration and updating their generated README.
Build-only dependencies are excluded from every plugin runtime.

Builds capture validated source and dependency inputs once for both clients.
Shared manifest descriptions/authors and their corresponding Codex labels must
agree, as must the Claude catalog description. Client-specific interface details
remain separate. Release verification compares the complete shared skill trees,
both inventories and their recorded digests before producing the marketplace
archive. Manual archives receive a new inventory for their own README and file set.
Marketplace verification requires inventories for 0.11.0 and later, with identities
matching the enclosing client, release version and hooks variant. Older published
packages retain their original ZIP digests, without reconstructing them using
today's shipping list. See [package verification](distribution.md#verify-a-selected-package)
for an explicit read-only check of a built or installed package.

Keep the reviewed artifacts and `SHA256SUMS` together. If an asset is lost, a rebuild
from the unchanged tag can recover it only when its checksum matches the original;
never replace the checksum record to make a different build appear unchanged.

Validate with `claude plugin validate --strict --json dist/release` and
`claude plugin validate --strict --json dist/release/claude/cuefluent-notes`.
Use the Plugin Creator validator for the Codex package when that tooling is
available. Test fresh-client installation against the prepared local catalog,
including first-use setup and hook trust, before advertising a release. The
[verification scope](verification.md) describes general coverage and product limits.

## Publish the GitHub marketplace

1. Merge the release changes into `main`. Ensure `package.json`, both version
   fields in `package-lock.json`, and `packaging/{codex,claude}/plugin.json`
   all have the same stable `major.minor.patch` version. Each update needs a
   higher version so installed clients discover it. The project license is a
   publisher decision; dependency licenses do not license the project itself.
2. Enable GitHub Actions and allow it to create pull requests. The publication
   job uses `GITHUB_TOKEN` with `contents: write` for its temporary branch and the
   old branch's README notice and `pull-requests: write` for the draft PR.
   No main-branch bypass or extra secret is required. Keep the default branch as
   `main`.
3. From the reviewed commit on `main`, create and push `v` followed by that exact
   version (for example, `v0.5.0` when all manifests say `0.5.0`). Do not move or
   reuse an existing version tag. **Prepare release** runs the Node 22 test
   matrix and release builds on Windows, Linux, and macOS, verifies that their archive
   checksums match, and creates a **draft** GitHub Release using those exact Linux
   CI artifacts: all five archives and `SHA256SUMS`. Preparation does not rebuild.
4. Open that draft on GitHub. Review the files, smoke-test the plugin ZIPs, and
   add version-specific changes to the prepared release notes. Keep the snapshot
   and its checksums together. Use GitHub's **Publish release** action when ready.
5. **Publish marketplace** downloads that release's snapshot, verifies its
   checksum, layout and package digests, and prepares `chore/publish-vVERSION`
   from current `main`. It opens a **draft package-update PR**. GitHub creates its
   **Checks** run in an approval-required state because the PR uses `GITHUB_TOKEN`.
   After reviewing the generated changes, a maintainer with write access selects
   **Approve workflows to run** in the PR. Publication does not dispatch a second run.
6. Verify that PR's current commit's checks and merge it through the
   normal protected-main process. Only then are the packages available through
   the [installation commands](../README.md#from-the-marketplace). There is no
   automatic merge or direct main push.

Both release paths require the source tag to belong to `main` history. Only
stable releases prepare marketplace updates. The canonical path list is
`scripts/marketplace-layout.mjs`. Publication replaces only these paths in its
review branch:

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`
- `plugins/cuefluent-notes/`
- `claude/cuefluent-notes/`
- `release.json`

The snapshot's README is for the downloadable archive; it does not replace the
source README. Source files, unrelated package paths, history, and the checkout's
index are preserved. Never edit generated packages directly. Their installed
version follows `release.json`, independently of unreleased source changes.
Unexpected snapshot entries are rejected instead of silently discarded; the
archive README is the sole deliberate omission. The package digests are checked
against the actual staged Git bytes before creating a commit. The former
`marketplace` branch receives a final README migration notice, retaining its
existing packages and catalog bytes. Existing users must
[switch their registration](../README.md#switch-an-older-marketplace-registration-to-main)
to receive future releases.

Ordinary source PRs run checks and upload preview artifacts. Merging the generated
package-update PR makes its already-published release installable from main.
Neither kind of merge creates a GitHub Release or updates an installed plugin.
Publishing a draft manually triggers the publication event. A release published
with `GITHUB_TOKEN` does not trigger that follow-on workflow. Bot-created PRs have
a separate approval-required exception; see
[GitHub token workflow triggers](https://docs.github.com/en/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs).

## Recovery and subsequent releases

- Rerun preparation only after a transient failure or a fix to runner access,
  permissions, or other external configuration. Reruns use the tag's original
  commit. A source fix (including manifests, scripts, or release notes) requires
  a new version committed to `main` and a new version tag; never move the old tag.
  If a draft already exists, inspect its assets before using it; preparation
  refuses to overwrite a release with the same tag.
- If publication fails, users keep the prior packages on `main`. Fix permissions,
  missing/corrupt assets, or PR creation access, then rerun **Publish marketplace**
  against that published release. Retain the original reviewed assets.
- A retry of an already-published snapshot is a no-op. Same-version replacement
  with different archive digests or a changed marketplace tree is refused, as
  is publishing an older version.
  An identical prepared branch and its existing PR are reused; retrying publication
  does not start another CI run. Use the existing run's approval or rerun controls
  when appropriate. If the branch differs from the update prepared
  against current main, the publisher refuses to overwrite the existing PR;
  review and update that PR through the normal process. Concurrent publication
  branch updates reject the non-force push. Required checks and merge rules
  govern source changes landing on main while the PR is open.
- To roll back behavior, publish a **newer version** containing the corrected
  implementation. Do not force-push `main` or replace existing assets.

## Public listing materials

Use the existing product wording:

- Name: **Cuefluent Notes**.
- Short description: **Capture and organize your knowledge for fast recall—right on cue.**
- Details: **Collect selected parts of Codex and Claude sessions as private evidence,
  then turn reviewed sources into clear, searchable Markdown. Capture decisions,
  meeting summaries, tasks and knowledge-base notes with independent collection
  and processing controls. Direct saves are also supported.**
- Category: **Productivity**.
- Starter prompts: **Set up Cuefluent Notes for this project.**;
  **Check these notes for evidence and useful search vocabulary.**;
  **Update this note while preserving my edits and its history.**
- Source and support: [repository](https://github.com/martinmqz/cuefluent-notes)
  and [issues](https://github.com/martinmqz/cuefluent-notes/issues).

Before public submission, the publisher still needs to select the verified
individual/business identity, final logo, website, public privacy-policy and
terms URLs, project license, and supported countries/regions. Do not invent
those details or treat the current contributor label as a verified identity.
Any privacy statement must describe local note/configuration handling separately
from the hosting agent's data processing. This package supplies no hosted MCP
service; it should not claim that the host keeps all conversation data local.

## OpenAI submission

Use the [OpenAI plugin portal](https://platform.openai.com/plugins), create a
**Skills only** submission, and upload the complete client plugin archive.
The submitter needs Apps Management write access and a verified publisher
identity in the same Platform organization/project. Complete listing fields,
starter prompts, at least five positive and three negative cases, availability,
release notes, and review. Approval precedes public publication.

Describe the supported runtime accurately: bundled helpers need Node.js 22+,
and command hooks need the Codex runtime, its environment, and trust. Hooks do
not run in ordinary Chat. Test the imported package in its actual target surface;
this repository does not certify ordinary Chat compatibility. A Claude-compatible
archive can also be imported through the documented conversion path, but review
the converted hook commands before submission.

Official sources: [submission requirements](https://developers.openai.com/plugins/deploy/submission)
and [Claude-to-OpenAI package support](https://developers.openai.com/plugins/guides/submit-claude-plugin).

## Claude submission

Validate the complete Claude package, then use the
[Claude Console submission form](https://platform.claude.com/plugins/submit).
Supply the released plugin location on `main` at
`claude/cuefluent-notes`, with its exact commit, when asked for source details;
the repository root is a marketplace, not an individual installable plugin.
Follow the form's supported repository/ref/subdirectory fields rather than substituting a source-only URL.

Approved third-party submissions enter **claude-community**. Users add
`anthropics/claude-plugins-community` before installing from that catalog.
**claude-plugins-official** is separately curated by Anthropic and has no
application process. See [Claude's submission guidance](https://code.claude.com/docs/en/plugins#submit-your-plugin-to-the-community-marketplace).

## Suggested review scenarios

These are submission scenarios to run and record against the final upload,
not claims that a marketplace reviewer or every model has already passed them.
Use a disposable private project and notes directory outside the source/plugin.
All facts and people below are fictional. Replace `<notes>` with that directory.

| Positive case | Prompt / fixture | Expected behavior |
| --- | --- | --- |
| Manual onboarding | With no existing policy: “Set up Cuefluent Notes in Manual mode.” | Save a disabled preference; create no note; do not enable automatic capture. |
| Capture a decision | “Record in `<notes>/orchid.md`: on 2026-09-01 the fictional Orchid team chose a 30-minute cache TTL for its prototype; production behavior is untested.” | Preserve the decision date, prototype scope, and uncertainty in searchable Markdown. |
| Meeting summary | “Summarize this fictional meeting into `<notes>/meeting.md`: on 2026-09-02 Maya agreed to test Orchid's cache invalidation by September 4; deployment remains undecided.” | Capture the owner, action, due date, and unresolved decision without inventing approval. |
| Maintain an existing note | Seed an Orchid note with an unrelated manually written paragraph. Ask to add the verified fact “the prototype cache expires after 30 minutes.” | Inspect the note, preserve the manual paragraph, and apply a guarded update without making a duplicate document. |
| Fast-recall vocabulary | “Check `<notes>/orchid.md` for the lookup ‘Orchid cache expiry’; explain whether its headings or aliases support that lookup.” | Inspect headings/aliases and report useful vocabulary gaps; do not claim app ranking or alter the note during Check. |

| Negative case | Prompt / fixture | Expected behavior |
| --- | --- | --- |
| Read-only opt-out | “Summarize the Orchid note here only. Do not save or capture this.” | Return the summary without writing notes or changing capture configuration. |
| Unsupported evidence | “Record that Orchid's cache is production-proven,” while the only evidence says prototype behavior and no production tests. | Do not state production readiness as verified; explain the evidence gap or clearly preserve the claim as unverified. |
| Concurrent manual edit | Prepare a guarded update, then edit the target before applying that inspected-hash plan. | Reject the stale update, preserve the manual edit, and require reinspection rather than overwriting it. |
