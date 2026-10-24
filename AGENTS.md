<!-- agent-guidance-sync:generated:v1 source=".agents/guide.md" target="AGENTS.md" -->

# Repository guidance

This repository develops Cuefluent Notes v2. Paths beginning with `/` below are
repository-relative. Product instructions belong in `SKILL.md` and `references/`;
development guidance belongs here. Keep private plans and verification records
in ignored `.local/`, organized by purpose.

## Load the relevant rules

Read all matching canonical rules before implementation or review. Their `paths`
frontmatter owns routing. Codex and Claude must load them explicitly; an already
loaded generated copy is sufficient.

- [Runtime and storage](/.agents/rules/runtime.md): new source, settings, queues,
  attempt ownership, filesystem integrity, and runtime tests.
- [Note guidance and examples](/.agents/rules/note-guidance.md): installed workflows,
  Markdown compatibility, and synthetic examples.
- [Distribution and releases](/.agents/rules/distribution.md): dependencies,
  packages, installation, CI, and immutable releases.

When changing a canonical rule, check its scopes and regenerate its adapters.

## Product and integrity boundaries

- V2 is a fresh implementation in `src/` with tests in `test/`. Reviewed history
  may inform design; do not copy legacy modules, import the former runtime, or add
  migration, compatibility modes, deprecated aliases, or old capture state.
  Preserve Git history and immutable published packages and checksums.
- Tracking defaults to `manual`, saving to `review`, and activity logging to on
  for new directory destinations. Preserve explicit logging opt-outs and loaded
  settings; single-file destinations keep logging off.
  They are independent. Tracking `auto` enrolls eligible new native chats;
  processing is always explicit. Installation and hook trust authorize neither.
  Explicit opt-outs and read-only requests take precedence.
- Bind tracking and processing commands from native current-chat and invocation context. Cwd, a newest
  transcript, an agent-supplied identity, and ordinary command mentions are not
  identity evidence. Synchronous hooks may dispatch bounded native metadata but
  never scan transcripts, call models, write notes, block prompts, or ask to continue.
  Unconfigured and ineligible automatic ingress must make zero filesystem writes.
- Direct notes accept explicitly requested assistant-authored content for
  a chosen configured destination. They claim no native chat provenance, enroll no
  chat and select no queue input. Keep review/auto saving, one pending run, exact
  draft bytes and the safe writer. New targets must be absent; existing-note updates
  require the exact inspected whole-file hash and preserve useful content, metadata,
  aliases and manual edits. Reconcile conflicts instead of refreshing hashes to
  force an old draft over changed content.
- Collect complete chronological exchanges, preserving prompts, assistant text,
  and tool arguments through ordered parts. Clip tool output only with explicit
  notices. Do not treat EOF or Stop as proof that every row has persisted. Retain
  durable late-output reconciliation and retries without requiring another prompt.
- Keep one owner per native chat, assigned to the nearest configured project at
  first binding and stable thereafter. Keep one pending run per project. Validate
  whole settings documents and reject unsupported schema versions. Refuse changes
  that orphan work or redirect a pending run's destination or saving mode. Pin
  logging preferences for each run.
- Queued processing uses a separate untracked session with only bounded note reads and
  private draft tools. It has no shell, network, tracking, or note-save capability.
  Hooks and unrelated plugins must be effectively disabled for that session.
- Preserve exact inspected hashes, root and parent identities, source checkpoints,
  and journal state. Never refresh a hash to bypass a conflict, discard queued input,
  break a live lock by age, or choose a new lock directory to evade an owner.
  Use OS-owned liveness and attempt fencing. Keep mutation gates short so collection
  continues during model work and review. Coordinate overlapping note routes.
- Preserve user Markdown and manual edits. Stage writes under names ending in
  `.tmp`, never `.md`. A new unread target must be absent. An unchanged note keeps
  its bytes and timestamps. Cleanup removes successfully handled private input
  and completed drafts, never notes or native transcripts.
- Private state, real notes, conversation evidence, and credentials stay outside
  this checkout, including `.local/`. Tests use synthetic data and disposable
  locations. Installed profiles, settings, plugin trust, and authentication may
  be used or changed only within the user's explicit authorization.
- Development does not authorize installation, merging, publication, release
  replacement, or visibility changes. Preserve published copies even when source
  versions differ.

## Development and verification

Use the latest supported Node 26 patch and npm; `.node-version` and `engines` pin
the tested baseline. Check current library releases when adding dependencies and
pin exact versions with licenses. Foundation storage uses Node's built-in SQLite.

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
```

Run relevant tests while iterating and the complete v2 suite for runtime changes.
Use observable failure cases: concurrent writers, interruption, stale attempts,
path replacement, malformed/torn records, and preservation of manual edits. Do not
add tests that restate editorial prose. Keep fixtures and discovery portable
across Windows, macOS, and Linux. Windows privacy requires ACL verification;
chmod is not evidence. Keep native client tests separate from deterministic tests.

Report actual coverage. Local macOS tests do not establish Windows/Linux behavior,
reboot recovery, client desktop rendering, or Cuefluent search ranking. Native CLI
envelopes do not prove production adapter correctness. Record dated validation in
ignored `.local/`; public documentation describes supported behavior and limits.
Check CI for the current revision when reporting it.

## Change and review workflow

- Use the existing checkout and requested branch. Create worktrees only on an
  explicit user request. Keep unrelated changes separate.
- Use Conventional Commits and branches named `<type>/<short-kebab-description>`.
  Open pull requests as drafts; never mark ready without a user request.
- Self-review each slice, fix confirmed findings, and run relevant checks. Follow
  the user's independent-review workflow without extra broad sweeps. Review new
  and staged files as well as tracked unstaged diffs.
- Follow explicit commit/push scope and verify remote results when authorized.
  Do not add AI attribution to commits, pull requests, or published material.
- Edit canonical source and templates, never generated packages. Keep installed
  product references separate from repository build and publication instructions.

## Maintaining this guidance

Edit [this guide](/.agents/guide.md), [adapter configuration](/.agents/config.yaml),
and canonical rules. Regenerate `AGENTS.md` and Copilot instructions through the
pinned generator; do not edit those outputs directly.

```sh
npm run guidance:sync -- --dry-run
npm run guidance:sync
npm run check:guidance
```

Commit source and generated adapters together. There is no `CLAUDE.md` adapter or
nested guidance. Keep root `AGENTS.md` plus canonical rules below 32 KiB. Generator
checks detect drift; review links, scopes, factual claims, and native activation
separately. Contributor guidance alone does not require a product release.
