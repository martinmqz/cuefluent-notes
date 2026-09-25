# Repository guidance

This file guides development of Cuefluent Notes. The installed product's
instructions live in [SKILL.md](SKILL.md). Keep this file focused on maintaining
the repository; keep detailed user workflows in the skill and its references.

## Repository map

- `SKILL.md`, `references/`, and `examples/`: product guidance, compatibility
  limits, and synthetic examples. Follow the [README](README.md) for setup.
- `scripts/check-notes.mjs`: advisory Markdown structure and vocabulary checks.
- `scripts/safe-update.mjs`, `scripts/file-io.mjs`, and
  `scripts/runtime-paths.mjs`: inspected hashes, filesystem boundaries, writer
  locks, journals, and recovery. See [safe updates](references/refresh.md).
- `scripts/install.mjs`, `scripts/package*.mjs`, `scripts/release*.mjs`,
  `packaging/`, and `.github/workflows/`: installation, packages, releases, and CI.
  See [distribution](references/distribution.md) and
  [publishing](references/publishing.md).
- `scripts/*.test.mjs`: Node's built-in test suite, including detached packages
  and disposable filesystem fixtures.
- `scripts/workflow-*.mjs` and `scripts/capture-contract.mjs`: session-workflow
  contracts and guarded private settings. See [session workflow](references/session-workflow.md) for the current
  implementation boundary and independent collection/processing consent.
- `scripts/capture-selection.mjs` and `scripts/intake-*.mjs`: selection
  intervals, guarded intake state, immutable publication and recovery.
  Native-order proofs come from trusted readers; they are not user JSON commands.
- `scripts/session-jsonl.mjs`, `scripts/capture-evidence.mjs`,
  `scripts/codex-reader.mjs`, and `scripts/claude-reader.mjs`: bounded native session reads and selected capture
  extraction. Keep the verified client-format matrix in the session reference.
  `scripts/reader-checkpoint.mjs` bounds metadata-only incremental carry;
  `scripts/reader-pages.mjs` persists authenticated pages with finite cumulative
  allocation. Preserve full hashes and native identity metadata, fresh permission
  checks around cached bytes, and exact cursor/root publication. Claude pause
  freezes automatic inspection at its saved EOF; suspension is not finality. Schema-2
  captures are immutable revisions; activate heads only with fresh selection and
  expected hashes. Claude ordinary assistant parentage does not prove prompt ownership.
- `scripts/workflow-storage.mjs`, `scripts/storage-platform.mjs`, and
  `scripts/capture-maintenance.mjs`: current private-storage capabilities and
  explicit whole-unit pruning. Preserve exact tombstones and processing evidence;
  use intake-then-sorted-writer lock order for maintenance and processing.

- `scripts/collection-*.mjs`, `scripts/workflow-budget.mjs`, and
  `scripts/process-identity.mjs`: metadata-only hook ingress, bounded detached
  collection, and native owner probes. `scripts/intake-recovery.mjs` requires an
  externally established offline window; never infer it from a dead PID alone.
- `scripts/processing*.mjs` and `scripts/writer-protocol.mjs`: exact input claims,
  bounded evidence pages, immutable proposals, dispositions and coordinated
  Markdown receipts. See [processing](references/processing.md). Hold intake then
  writer locks only during helper calls. Never bypass pending transactions through
  the public writer, infer page acknowledgment from delivery, or rewrite notes in
  recovery after a durable save receipt exists.
- `scripts/workflow.mjs`, `scripts/workflow-settings.mjs`, and
  `scripts/capture-controls.mjs`: explicit CLI operations, settings CAS and native
  selection controls. Never accept serialized reader proofs or infer current
  identity from cwd. Pending discovery reads metadata only; full preparation is
  the evidence integrity gate. See [workflow CLI](references/workflow-cli.md).

## Development and verification

Use native Windows, macOS, or Linux with Node.js 22+ and npm. The full source
suite also needs Bash, Git, `unzip`, and `tar`; these maintenance tools are not
requirements for an installed plugin. In PowerShell use `npm.cmd` if needed.
PowerShell 7 and Git Bash hook checks explicitly skip locally when unavailable;
Windows CI requires both. The hook test locates Bash from Git for Windows rather
than using a possible WSL launcher on PATH.

```sh
npm ci --ignore-scripts
npm test
npm run check:examples
```

Run relevant tests while iterating and the full suite for runtime changes.
Run vocabulary checks when changing the checker, note guidance, or examples.
Changes to instructions in `SKILL.md` or workflow references can change product
behavior: review the affected consent and workflow rules and run relevant checks.
For editorial or repository-guidance changes, verify factual claims, links, and
whitespace; do not add tests that merely mirror prose. Include staged and new
files in review: plain `git diff --check` covers only unstaged tracked changes.

For packaging changes, verify detached packages and run `npm run release:build`.
Builders refuse existing output directories: use a fresh destination with
`-- --out /absolute/fresh-output` instead of deleting prior artifacts.
CI runs Node 22 on Windows, Linux, and macOS and compares all three release
checksum sets. Keep test discovery and fixtures independent of POSIX paths,
shebangs, chmod privacy, and shell globbing. Real-client smoke checks download
locked CLIs without lifecycle scripts into temporary profiles; run them explicitly with
`node scripts/client-smoke.mjs`. They must never use the user's real profile,
authentication, capture settings, or hook trust.
Report what was actually verified: emitted hook context and package validation
do not prove live client behavior, native prompt rendering, or Cuefluent search
ranking. Keep current coverage and evidence limits in
[verification](references/verification.md). Keep implementation plans, review
reports, dated test logs and internal process history in ignored `.local/`, not
in committed documentation or installed packages.

## Code review rules

- Preserve independent collection and processing consent. Collection starts off;
  processing starts Manual. Prompted requires approval, and Automatic stays within
  the approved scope. Installation/trust enables neither. Read-only requests and
  opt-outs override policy; keep interaction rules in `SKILL.md`.
- The workflow may register bounded native metadata where current
  policy authorizes the operation, including processing-only bindings. Launch
  a deterministic collection worker only after fresh collection consent.
  Synchronous hooks must never scan transcripts, call models, write notes, block a prompt,
  or request a continuation;
  automatic ingress for unconfigured projects and entirely disabled workflows
  must produce zero filesystem writes.
- Preserve exact inspected hashes, bounded reads, path and link checks, locks,
  and journal recovery. Never bypass a conflict by refreshing hashes, discarding
  state, or choosing another lock directory. Preserve user edits.
- Maintain one writer state per notes collection, including overlapping routes.
  Preserve explicit file destinations and folder routing. Keep authored and
  derived ownership separate, including during interrupted updates.
- Validate complete proposed settings on writes and refuse unsupported newer
  schemas. The replacement workflow has no legacy migration or mixed-version
  compatibility requirement; do not restore obsolete policy or completion-marker code.
  The v0.7.1 tag preserves the reference implementation.
- Keep both Codex and Claude packages self-contained. Update the explicit
  `SOURCE_FILES` list in `scripts/package.mjs` only for intended shipped content;
  keep repository-maintenance guidance out of installed packages. Preserve
  runtime dependency closure and license notices.
- Keep real user notes, private evidence, private capture configuration,
  credentials, and private planning outside the repository. Use synthetic
  fixtures and disposable test locations by default; test a user's installed
  plugin or capture settings only when explicitly authorized. Keep CI permissions
  narrow and actions pinned.

## Change and delivery workflow

- Use Conventional Commits: `<type>(<optional-scope>): <description>`, omitting
  the parentheses when no scope is needed. Choose the type for the change, such
  as `feat`, `fix`, `docs`, `refactor`, `test`, or `chore`; use `!` before the
  colon for a breaking change. Apply this convention to squash commit messages
  too. Examples: `fix(hooks): preserve the context size limit` and
  `docs(agents): document repository conventions`.
- Name working branches `<type>/<short-kebab-case-description>` with a matching
  purpose prefix, for example `feat/native-suggestion-prompts`,
  `fix/hook-context-limit`, or `docs/agent-guidance`.
- Follow the requested branch and PR scope. Keep unrelated work separate. Do not
  introduce PR cross-references, dependencies, or new process steps unless requested.
- Self-review each slice, fix confirmed findings, and complete relevant checks
  before committing. When asked to commit and push, verify the remote result.
- Keep behavior documentation aligned with code and link to canonical guidance
  instead of duplicating detailed rules across files.
- Edit source templates rather than generated `dist/` or marketplace content.
  For version changes, keep `package.json`, `package-lock.json`, and both client
  plugin templates aligned. Follow the publishing guide for releases; preserve
  immutable published versions and checksums.
- Development and build work does not authorize installation, hook trust,
  capture configuration changes, merging, publication, or visibility changes.
  Perform those actions only within the user's explicit authorization.
