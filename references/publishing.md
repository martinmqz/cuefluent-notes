# Publishing Cuefluent Notes

There are two distribution steps: publish our GitHub-hosted marketplace, then
apply separately for OpenAI and Claude public listings. A GitHub release does
not grant either public listing. Publisher credentials and portal submissions
are not part of this repository or its automation.

## Public repository hygiene

Keep real notes, capture configuration, credentials, and private planning outside
this repository. Commit only synthetic examples. Before making a repository
public, inspect its Git and pull-request history as well as retained Actions logs
and artifacts; deleting a file from the current branch does not remove history.

Require pull requests and passing CI on `main`, prevent force pushes and branch
deletion, and enable secret scanning and push protection when GitHub supports
those settings for the repository. Keep workflow tokens read-only by default and
require actions to use full commit pins. Repository visibility and security
settings are separate from publishing a plugin release.

## Build and inspect a release

From the source checkout, use Node.js 22+, Git, and `unzip`/`tar` for the extraction tests:

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
  release.json                          # version and plugin ZIP digests
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

Keep the reviewed artifacts and `SHA256SUMS` together. If an asset is lost, a rebuild
from the unchanged tag can recover it only when its checksum matches the original;
never replace the checksum record to make a different build appear unchanged.

Validate with `claude plugin validate --strict --json dist/release` and
`claude plugin validate --strict --json dist/release/claude/cuefluent-notes`.
Use the Plugin Creator validator for the Codex package when that tooling is
available. Test fresh-client installation against the prepared local catalog,
including first-use setup and hook trust, before advertising a release. The
[verification record](verification.md) distinguishes automated checks from live tests.

## Publish the GitHub marketplace

1. Merge the release changes into `main`. Ensure `package.json`, both version
   fields in `package-lock.json`, and `packaging/{codex,claude}/plugin.json`
   all have the same stable `major.minor.patch` version. Each update needs a
   higher version so installed clients discover it. The project license is a
   publisher decision; dependency licenses do not license the project itself.
2. Enable GitHub Actions for this repository and allow the release jobs'
   `contents: write` permission. Branch rules must allow the automation to
   create/update `marketplace`. The jobs use `GITHUB_TOKEN`; no extra secret is
   required. Keep the default branch as `main`.
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
   checksum and versions, then advances the generated `marketplace` branch.
   Wait for success before advertising the [installation commands](../README.md#from-the-marketplace).

Both release paths require the source tag to belong to `main` history. Only
stable releases update the marketplace. The generated branch contains only its
catalogs, complete packages, README, and release manifest; source history and
the source checkout's index are not replaced. Never edit generated files there.

Ordinary PRs only run checks and upload preview artifacts. Neither merging a PR
nor running `release:build` creates a public release or installs anything.
Publishing a draft manually triggers the publication event; if publishing via
automation, remember that events produced with `GITHUB_TOKEN` generally do not
start another workflow. See [GitHub workflow triggering](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow).

## Recovery and subsequent releases

- Rerun preparation only after a transient failure or a fix to runner access,
  permissions, or other external configuration. Reruns use the tag's original
  commit. A source fix (including manifests, scripts, or release notes) requires
  a new version committed to `main` and a new version tag; never move the old tag.
  If a draft already exists, inspect its assets before using it; preparation
  refuses to overwrite a release with the same tag.
- If publication fails, users keep the prior marketplace branch. Fix permissions,
  missing/corrupt assets, or branch access, then rerun **Publish marketplace**
  against that published release. Retain the original reviewed assets.
- A retry of an already-published snapshot is a no-op. Same-version replacement
  with different archive digests or a changed marketplace tree is refused, as
  is publishing an older version.
  A concurrent branch change makes the non-force push fail; inspect it and retry.
- To roll back behavior, publish a **newer version** containing the corrected
  implementation. Do not force-push the marketplace or replace existing assets.

## Public listing materials

Use the existing product wording:

- Name: **Cuefluent Notes**.
- Short description: **Capture and organize your knowledge for fast recall—right on cue.**
- Details: **Turn work, meetings, and ideas into clear, searchable Markdown.
  Capture decisions, create summaries, and maintain documentation and knowledge-base
  notes—Cuefluent-ready, with smart search keywords and optional automatic capture
  across sessions.**
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
Supply the released plugin location on the `marketplace` branch at
`claude/cuefluent-notes`, with its exact commit, when asked for source details;
the source `main` root is not an installable plugin. Follow the form's supported
repository/ref/subdirectory fields rather than substituting a source-only URL.

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
