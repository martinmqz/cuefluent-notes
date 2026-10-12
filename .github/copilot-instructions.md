<!-- agent-guidance-sync:generated:v1 source=".agents/guide.md" target=".github/copilot-instructions.md" -->

# Repository guidance

This guidance is for developing Cuefluent Notes. Installed product instructions
live in [SKILL.md](/SKILL.md); setup is in the [README](/README.md). Keep detailed
user workflows in the skill and its references. Paths and links beginning with
`/` in this guidance are relative to the repository root, not the filesystem root.

## Load the relevant rules

Apply the relevant rules before implementation or review. Path scopes live only
in each rule's `paths` frontmatter; apply all matching rules when scopes overlap.
If a generated copy is already in context, use it without loading the canonical
duplicate. Otherwise read the relevant canonical rule below. Codex and Claude
must load these explicitly; `.agents/rules/` is not automatically loaded.

- [Runtime and storage](/.agents/rules/runtime.md): runtime, consent, evidence
  integrity, and private storage.
- [Note guidance and examples](/.agents/rules/note-guidance.md): product
  instructions, advisory note checks, and synthetic examples.
- [Distribution and releases](/.agents/rules/distribution.md): self-contained
  packages, installation, CI, and immutable releases.

When editing a rule's canonical source or its generated adapters, read that rule
and check its frontmatter against the affected repository paths.

## Shared boundaries

- Preserve independent collection and processing consent. Collection starts off;
  processing starts Manual. Prompted requires approval, and Automatic stays within
  the approved scope. Installation and hook trust enable neither. Read-only
  requests and opt-outs override policy; keep interaction rules in `SKILL.md`.
- Register bounded native metadata only where current policy allows it, including
  processing-only bindings. Launch deterministic collection workers only after
  fresh collection consent. Synchronous hooks must never scan transcripts, call
  models, write notes, block a prompt, or request a continuation. Automatic ingress
  for unconfigured projects and entirely disabled workflows must produce zero
  filesystem writes.
- Validate complete proposed settings on writes and refuse unsupported newer
  schemas. The replacement workflow has no legacy migration or mixed-version
  compatibility requirement; do not restore obsolete policy or completion-marker
  code. The v0.7.1 tag preserves the reference implementation.
- Preserve exact inspected hashes, bounded reads, path and link checks, locks,
  and journal recovery. Never bypass a conflict by refreshing hashes, discarding
  state, or choosing another lock directory. Preserve user edits.
- Maintain one writer state per notes collection, including overlapping routes.
  Preserve explicit file destinations and folder routing. Keep authored and
  derived ownership separate, including during interrupted updates.
- Keep both client packages self-contained, including runtime dependencies and
  license notices. Change `SOURCE_FILES` in `scripts/package-inputs.mjs` only for intended
  shipped content. Exclude repository guidance, development tools, tests, and
  private planning from installed packages.
- Keep real user notes, private evidence, and private capture configuration outside
  the repository. Use synthetic fixtures and disposable test locations by default;
  test a user's installed plugin or capture settings only when explicitly
  authorized.
- Keep plans, review notes, evidence, and machine-specific paths out of source
  control. Keep secrets and credentials out of source, tests, logs, and evidence.
- Development and build work does not authorize installation, hook trust,
  capture configuration changes, merging, publication, or visibility changes.
  Perform those actions only within the user's explicit authorization.

## Development and verification

Use native Windows, macOS, or Linux with Node.js 22+ and npm. The full source suite
also needs Bash, Git, `unzip`, and `tar`; these maintenance tools are not installed
plugin requirements. In PowerShell use `npm.cmd` if needed. PowerShell 7 and Git
Bash hook checks skip locally when unavailable; Windows CI requires both. The
hook test locates Bash from Git for Windows rather than a possible WSL launcher.

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
npm run check:examples
```

Run relevant tests while iterating and the full suite for runtime changes.
Changes to `SKILL.md` or workflow references can change product behavior: review
the affected consent and workflow rules and run relevant checks even when no
JavaScript changes. For editorial or repository-guidance changes, verify factual
claims, links, scope routing, and whitespace; do not add tests that merely mirror
prose. Review staged and new files too: plain `git diff --check` covers only
unstaged tracked changes.
CI runs Node 22 on Windows, Linux, and macOS and compares release checksums across
all three. Keep test discovery and fixtures independent of POSIX paths, shebangs,
chmod privacy, shell globbing, and directory listing order. Isolate temporary Git
fixtures from user configuration and hooks. Keep CI permissions narrow and actions
pinned. Guidance checks run separately from artifact-producing jobs and are
skipped for tag releases.

Report what was actually verified. Emitted hook context and package validation do
not prove live client behavior, native prompt rendering, or Cuefluent search
ranking. Keep coverage and evidence limits in
[verification](/references/verification.md). Check CI for the current PR revision;
separate local results, pending checks, and checks from an earlier commit.

## Change and review workflow

- Use Conventional Commits: `<type>(<scope>): <description>` with a scope, or
  `<type>: <description>` without one; omit the parentheses when no scope is needed.
  Choose an appropriate type, such as `feat`, `fix`, `docs`, `refactor`, `test`, or
  `chore`. Apply this convention to squash commit messages too. Use `!` before the
  colon for a breaking change, for example `feat!: change the storage schema`.
- Name branches `<type>/<short-kebab-case-description>` with a matching purpose
  prefix, such as `fix/hook-context-limit` or `docs/agent-guidance`.
- Follow the requested branch and PR scope. Keep unrelated work separate. Do not
  introduce PR cross-references, dependencies, or new process steps unless asked.
- Self-review each slice, validate findings against the current code, fix confirmed
  issues, and complete relevant checks before committing. Read both review
  summaries and inline PR comments; a summary alone is not the full review.
  Follow the user's requested review workflow without adding extra review sweeps.
- When asked to commit and push, verify the remote result. Keep behavior
  documentation aligned with code and link to canonical guidance instead of
  duplicating detailed rules across files.
- Edit source templates rather than generated `dist/` or marketplace content.
  Preserve immutable published versions and checksums; follow
  [publishing](/references/publishing.md) for release changes.

## Maintaining this guidance

Edit [the canonical guide](/.agents/guide.md), [adapter configuration](/.agents/config.yaml),
and the scoped rules linked above. The exact generator version is pinned in
`package.json` and `package-lock.json` as a development dependency.

```sh
npm run guidance:sync -- --dry-run
npm run guidance:sync
npm run check:guidance
```

Commit the source and generated outputs together. `AGENTS.md`,
`.github/copilot-instructions.md`, `.cursor/rules/agent-guidance/*.mdc`, and
`.github/instructions/agent-guidance/*.instructions.md` are generated; do not edit
them directly. There is no `CLAUDE.md` adapter or nested guidance. Claude Code must
support reading `AGENTS.md` when `CLAUDE.md` is absent; see its
[changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).
Cursor uses root `AGENTS.md` plus scoped rules; Copilot keeps its repository-wide
instructions for GitHub.com consumers as well as scoped rules.
The [VS Code workspace settings](/.vscode/settings.json) select Copilot instruction
files for the Local agent, disabling its additional `AGENTS.md` and linked-file
auto-loading. Other agent harnesses use their own discovery rules; see
[VS Code instruction support](https://code.visualstudio.com/docs/agent-customization/custom-instructions).

`check:guidance` detects generated-file drift; it does not validate routing prose,
links, factual claims, or live client activation. Review those separately. Keep
the combined UTF-8 size of root `AGENTS.md` and all canonical scoped rules below
32 KiB to leave room for client instruction loading. Contributor-guidance changes
alone do not require a product version bump or release.
