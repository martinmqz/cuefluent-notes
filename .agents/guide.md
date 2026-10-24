# Cuefluent Notes

Instructions for coding agents working in this repository. Cuefluent Notes is a
Claude Code and Codex plugin that saves assistant-prepared Markdown notes and
processes explicitly tracked chats. `SKILL.md` and `references/` specify the
user-facing behavior: commands, setup, notes, metadata, storage, distribution,
and verification limits. Read the file that covers a behavior before changing
it.

## Commands

Node 26.12.1 or a later 26.x release is required (`.node-version`, `engines`).
Run `node --version` in the shell that runs the tests. Older builds fail with
`GATE_UNSUPPORTED_RUNTIME`, or on macOS with `PRIVATE_ACCESS_UNVERIFIED`
caused by a missing `node:ffi` module.

```sh
npm ci --ignore-scripts
npm test                           # complete suite
node --test test/<name>.test.mjs   # one file while iterating
npm run check:examples             # validates examples/ with the note parser
npm run check:guidance             # generated guidance matches its source
node tools/packaging.mjs build /absolute/new-dir   # new directory outside the checkout
```

There is no linter, formatter, or type checker.

## Definition of done

- Changes confined to guidance (`.agents/` and its generated outputs),
  marketplace catalogs, release receipts, or published snapshots (the
  allowlist in `tools/ci-plan.mjs`):
  `npm run check:guidance` and `node --test test/marketplace.test.mjs` pass.
  For such pull requests to `main`, CI runs only these checks.
- Any other change: the complete `npm test` and `npm run check:examples` pass.
  CI runs both on Linux, macOS, and Windows. A change to `packaging/`,
  `tools/packaging.mjs`, `tools/install.mjs`, or dependencies also needs a
  fresh candidate build.
- A change to user-visible behavior or limits updates `SKILL.md` or
  `references/` in the same change.
- A new runtime module is listed in `packaging/v2/source-files.json`; the build
  rejects unlisted relative imports.
- A dependency change pins an exact version after checking the current release
  and updates `package-lock.json`. The build refuses unpinned dependencies and
  packages without license files.

## Repository layout

- `plugins/` and `claude/` hold published release snapshots. They are tracked
  but excluded from ordinary searches by `.gitignore`. Their bytes are
  immutable; `test/marketplace.test.mjs` checks them against pinned receipts.
- `.agents/plugins/marketplace.json` (Codex) and
  `.claude-plugin/marketplace.json` (Claude) each select a published snapshot;
  both select the same version.
- `packaging/v2/` holds client descriptors and the shipped-file list.
  `packaging/releases/<version>/build.json` holds published checksums.
- `tools/` holds build, CI, and release tooling; none of it ships in a plugin.
- [Publishing](/.agents/publishing.md) is the maintainer procedure for builds,
  snapshots, CI evidence, and release preparation.
- `AGENTS.md` and `.github/copilot-instructions.md` are generated from
  `.agents/guide.md`. Several Copilot features read only the Copilot copy.

## Authorization model

Installing the plugin, trusting its hooks, developing it, discussing a command,
and reading notes authorize no saving, tracking, or processing. Explicit user
authorization is required to install, register, or trust a plugin or hook; to
change client authentication, profiles, or installed settings; and to use an
existing login for a client check. It is also required to merge, tag,
publish, replace a published package, checksum, or release asset, or change
repository visibility or settings. Git history and published bytes are
preserved even when source versions differ.

## Product invariants

- A new project defaults to tracking `manual` and saving `review`. Activity
  logging defaults to on for a directory destination and stays off for a
  single-file destination. The three settings are independent. Preserve
  explicit opt-outs and loaded settings. Tracking `auto` enrolls eligible new
  native chats only, and processing is always explicit.
- Bind tracking and processing commands from native current-chat and
  invocation context. Cwd, the newest transcript, an agent-supplied identity,
  and ordinary command mentions are not identity evidence. Synchronous hooks
  may dispatch bounded native metadata but never scan transcripts, call models,
  write notes, block prompts, or ask to continue. Unconfigured and ineligible
  automatic ingress makes zero filesystem writes.
- Direct notes save explicitly requested assistant-authored content to a chosen
  configured destination under its saving mode. They claim no native chat
  provenance, enroll no chat, and select no queue input.
- Collect complete chronological exchanges: prompts, assistant text, and tool
  arguments as ordered parts. Clip tool output only with an explicit notice.
  EOF or Stop does not prove every row persisted; keep durable late-output
  reconciliation and retries that need no further prompt.
- One owner per native chat, assigned to the nearest configured project at
  first binding and stable thereafter. One pending run per project. Validate
  whole settings documents and reject unsupported schema versions. Refuse
  changes that orphan work or redirect a pending run's destination or saving
  mode. Pin logging preferences per run.
- Queued processing runs in a separate untracked session with only bounded
  note reads and private draft tools: no shell, network, tracking, or note-save
  capability, with hooks and unrelated plugins effectively disabled.
- Preserve exact inspected hashes, root and parent identities, source
  checkpoints, and journal state. Never refresh a hash to bypass a conflict,
  discard queued input, break a live lock by age, or choose a new lock
  directory to evade an owner. Use OS-owned liveness and attempt fencing. Keep
  mutation gates short so collection continues during model work and review.
- Note writes go through the safe writer under the store-wide writer gate,
  which also serializes overlapping folder and file routes. A new target must
  be absent. An update requires the exact inspected whole-file hash and
  preserves useful content, metadata, aliases, and manual edits; reconcile
  conflicts instead of forcing an old draft over changed content. Saving
  writes the exact approved draft bytes. Stage under names ending in `.tmp`,
  never `.md`. An unchanged note keeps its bytes and timestamps. Cleanup
  removes handled private input and completed drafts, never notes or native
  transcripts.

## Runtime and storage

- `src/core/` is pure: settings, ownership, run transitions, and validation.
  It validates complete loaded state and freezes independent snapshots.
- `src/storage/` owns private paths, bounded reads, atomic publication, gates,
  queues, and attempts, independent of client transcript shapes and models.
  Metadata contains no conversation; only queue files hold selected
  conversation.
- Client adapters resolve native identity and normalize main-conversation rows.
  Commands are recognized from invocation evidence, not prose. Resume, fork,
  and compaction preserve source identity.
- Synchronization appends durable complete records before advancing its source
  checkpoint, and processing consumes nothing until that checkpoint is durable.
  Exact retained records may deduplicate an interrupted append; conflicting
  data or a malformed complete line is an error. Repair a torn tail only from
  verified uncommitted source, preserving ordinary conversation bytes.
- Processing freezes selected record identities, hashes, and context-sized
  ranges, not a whole live queue hash. New appends survive cleanup. Completed
  drafts are reused on retry, and a durable saved outcome authorizes cleanup
  without redrafting. Skip preserves selected input and written notes unless
  saving is durably complete and only cleanup remains.
- Private stores live on a supported local filesystem outside repositories and
  note destinations. Validate links, hard links, ownership, parent identities,
  and macOS and Windows ACLs; refuse unverifiable locations. Read and status
  operations never create a store, gate, transcript registration, or model
  session.
- SQLite gate files are persistent rendezvous paths, not data. Reach them only
  through `src/storage/gates.mjs` and its process-wide registry; never unlink,
  replace, hash, or open them with generic file helpers. Closing another
  descriptor for the same inode in that process can release its POSIX locks.
  Worker threads never acquire gates. A missing, corrupt, or replaced gate is
  an error, never a stale owner.
- Acquire short gates in settings, project, writer order. The worker process
  holds its project worker gate for the whole attempt and acquires it before
  publishing an active attempt. Every draft, save, and cleanup publication
  rechecks the current run and attempt under the same short gates. Parent death
  before activation releases the unstarted worker; a detached active worker
  may finish and publish a truthful result.
- The latest result holds status, paths, counts, and warnings only. It never
  authorizes writes and contains no conversation or input receipts. Runtime
  failures preserve queue data, pending state, and manual note edits.
- Give every new failure a stable `code` through the module's existing error
  helper, usually `fail()` from `src/core/errors.mjs`. Error messages never
  include conversation content.

## Notes and examples

- Portable notes use a topic H1 and visible H2 sections. Preserve existing
  plain notes, aliases, identity, creation timestamps, sources, and unfamiliar
  metadata. Leave unsupported metadata exactly unchanged and report malformed
  metadata instead of repairing it. The schema-1 note format is independent of
  the plugin version.
- Honor explicit file destinations and update a matching existing note in
  place. Otherwise route new notes by purpose to `meetings/`, `tasks/`,
  `knowledge-base/`, `decisions/`, or the notes root. `logs/` is reserved from
  ordinary drafts even when logging is off; preserve existing content there.
- Activity logging is directory-only and best effort. Setup records an IANA
  timezone, defaulting to the system timezone for a new series; existing series
  keep theirs. Writer-managed annual logs share series identity and timezone,
  start with a nonempty About section, and get one entry per changed note.
  Retry details stay in the current run. A log failure never blocks successful
  cleanup or reserves a project after completion.
- Log entries only locate notes; the assistant reads a note before making
  claims about it.
- Validate output against the supported Cuefluent parser and a versioned
  compatibility profile before saving. Never truncate content, raise app safety
  limits, or invent provenance to pass validation; preserve an over-limit draft
  and its input.
- `SKILL.md` and `references/` ship in the plugin, so repository build and
  release instructions stay out of them.

## Distribution and releases

- Packages are built from current source and the explicit shipped-file list,
  without tests, tooling, or repository guidance. Each client package includes
  its runtime dependency closure and license notices.
- The source version in `package.json` is separate from published releases.
  Root `release.json` records only the historical 0.15.1 release.
- Builds write only to a new output directory outside the checkout and refuse
  to overwrite. An inventory proves internal consistency, not provenance;
  release authenticity depends on trusted checksums and an authorized
  publication.
- Verify a new receipt pin against the published release before adding it.

## Security and privacy

- Never commit credentials, real notes, conversation data, or private
  configuration. Tests, fixtures, and examples use synthetic data in disposable
  locations.
- Dependency lifecycle scripts never run, and the builder verifies each
  tarball against its lockfile integrity.
- GitHub Actions are pinned to full commit SHAs with minimal job permissions.
  Third-party client downloads stay out of artifact-producing jobs.
- Client checks use disposable profiles. Never copy credentials into fixtures
  or change authentication, installed plugins, capture settings, or trust as a
  side effect. Fixtures never inherit user hooks or Git configuration.

## Tests and verification

- Exercise observable failure cases: concurrent writers, interruption, crash
  boundaries, stale attempts, path replacement, malformed or torn records, and
  preserved manual edits. Do not add tests that only assert documentation
  wording.
- Keep fixtures and test discovery portable across Windows, macOS, and Linux.
  Windows privacy requires ACL verification; chmod is not evidence. Keep native
  client tests separate from deterministic tests.
- Passing tests do not establish other operating systems, reboot recovery,
  desktop command rendering, live hook activation, native processing isolation,
  or Cuefluent search ranking. Native CLI envelopes do not prove production
  adapters, and per-file validation does not prove admission into a full app
  corpus.
- Verification claims name the platform they ran on and what remains
  unverified, and CI status refers to the run for the exact commit.
  `references/verification.md` states supported behavior and limits.

## Conventions

- Conventional Commits, with branches named `<type>/<short-kebab-description>`.
  Keep unrelated changes separate.
- Edit sources, never published snapshots or build output.
- Edit guidance only in `.agents/guide.md`, then run `npm run guidance:sync`
  and commit the source with both outputs. `npm run check:guidance` fails
  when an output drifts from its source; it does not check links or facts.
  Use root-relative links (`/path`) so both outputs resolve, and keep
  `AGENTS.md` under 32 KiB, the default Codex instruction limit.
