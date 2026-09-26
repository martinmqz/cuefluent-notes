# Setup and status

Cuefluent Notes has two independent processes: deterministic collection of selected
session evidence, and agent processing into searchable Markdown. Both start inactive:
collection disabled, processing Manual. A direct request to save selected material
can proceed without setup. Installation or trusting hooks supplies no capture consent.

## Inspect before changing

Run `node scripts/workflow.mjs status` from the installed package. Use an explicit
`--config` when one was selected; otherwise the helper respects
`CUEFLUENT_WORKFLOW_CONFIG` and its platform default. Status reads settings and bounded package diagnostics and
creates nothing. Report existing collections, routes, collection selection, processing
mode, destinations and transport limits; preserve settings unrelated to the request.
Use [workflow-cli](workflow-cli.md) for JSON request formats and inspected hashes.

For a bare “Use Cuefluent Notes”, ask which operation is wanted. For setup, establish
only missing choices: the project or explicit sessions; the finished-note destination;
whether future session collection should be enabled; and Manual, Prompted or Automatic
processing with its subject scope. Do not ask the user to classify notes. Infer note
type from context when saving; new folder destinations default to type folders.
A chosen explicit file remains exact. Multiple projects/collections are supported;
route ambiguity requires a specific selection, never a guessed destination.

Explain the choices in ordinary terms:

- **Collection** makes sensitive local JSON copies of selected native session
  evidence using scripts, with no model calls. It starts from its saved boundary,
  not historical sessions. Raw material can include secrets and private remarks;
  there is no automatic redaction. Raw captures are not finished Cuefluent notes.
- **Manual processing** runs only when requested. **Prompted** prepares useful
  changes for approval. **Automatic** uses the approved scope without a separate
  save question when there is a verified trigger. Collection does not select a
  processing mode, and processing existing captures does not require collection on.
- **Current limit:** live processing context transport is unverified. Processing
  requires an explicit request and native selection in every mode. Trusted hooks
  can wake collection, but a saved Automatic preference does not make Markdown
  processing run automatically. Do not promise native prompt rendering without
  verifying it in the actual client.

## Save the chosen settings

Use the complete configuration described by [session-workflow](session-workflow.md)
and the synthetic [example](../examples/workflow.json). `defaults` with a collection
ID suggests platform-specific private paths. The user selects the Markdown location;
private raw/intake/writer storage uses machine-local paths outside projects, notes,
and the plugin. Do not place private state in a sync folder or the repository.

The default raw folder is `.cuefluent-raw`. Its leading dot hides it from normal
macOS/Linux browsing; after privacy validation, explicit `storage-prepare` attempts
to set and verify the Hidden attribute on Windows, including custom paths. Only the raw root
gets that attribute, not individual captures, finished notes, or state folders.
Hidden folders retain the same private-storage permission requirements. Existing
configured paths are preserved; setup never moves captures or renames a directory.
For a custom raw location on macOS/Linux, choose a dot-prefixed folder name if you
want it hidden.
If Windows blocks the attribute change, setup returns `storage-ready` with a
`STORAGE_VISIBILITY_FAILED` warning; report that the folder remains visible.
Privacy, identity and policy failures still stop setup. Already-hidden roots
require no attribute change.

For a fresh collection:

1. Inspect settings and retain the exact `configHash` (null for absent settings).
2. Submit the complete proposed configuration through `configure`, initially with
   collection disabled and processing Manual. This validates every route and path;
   unsupported/newer settings and stale hashes are refused.
3. Run explicit `storage-prepare` for the selected collection using the returned
   settings hash. It creates and verifies private roots, without enabling anything
   or repairing existing directory permissions. Existing unsafe roots need a user
   decision. Never create category folders during setup.
4. If the user authorized activation, use a second guarded `configure` to apply
   the chosen collection and processing settings after privacy verification. Read
   status back and report the actual state and transport limit.

The selected notes root must exist before proposal inspection; create a missing
root only within an explicit setup/destination authorization. Existing notes and
permissions remain intact. Category creation belongs to the approved note plan.
All overlapping note routes must share one writer state; do not create per-category
or per-session writers. A custom raw directory does not relocate intake state.

## Existing settings

For the v0.8.0-to-v0.9.0 upgrade, preserve the existing workflow settings and
storage paths; fresh setup is not required. Before updating, stop collection
entrypoints and processing, close affected client sessions, and let running
workers finish. Update every client plugin/helper sharing the collection to
v0.9.0 before starting fresh sessions or resuming work, including both Codex and
Claude when used. A worker may process registrations from either client.

The new reader accepts v0.8.0 captures, but writes `reader.headerClientVersion`
provenance and version-2 suspensions with `readerRulesRevision`; v0.8.0 rejects
these formats. Mixed-version access and downgrading a collection used by v0.9.0
to v0.8.0 are unsupported. Existing immutable capture bytes are preserved;
reader caches can be replaced under the current reader's rules.

An upgrade does not rerun storage preparation. Existing Windows collections keep
their visibility until an explicit `storage-prepare`; offer that operation when
the user wants an existing raw folder hidden. Existing macOS/Linux `raw` folders
keep their names and visibility. Do not replace an existing collection's paths
with new defaults: preparation refuses a missing raw root paired with nonempty
intake state (`PRIVATE_SETUP_CONFLICT`). Restore the original raw/state pairing
after lost settings, or select fresh paths for a separate collection. Moving an
existing collection needs a separately authorized migration.

Preparation holds the shared intake lock through the empty-state check and raw
folder setup. An active or unfamiliar owner blocks preparation (`INTAKE_BLOCKED`).
If a known worker or other live owner is still running, let it finish and then
retry preparation; contention alone does not mean storage is damaged.
If interrupted setup cannot safely clean up, preserve the remaining files and
owner metadata and follow [explicit intake recovery](workflow-cli.md); do not
delete the lock or select different paths to bypass it.

Change only the requested fields in a complete inspected proposal and use its exact
old hash. Collection and processing preferences remain independent. Preserve explicit
flat organization until the user requests type folders; such a request authorizes
setting `organization: "by-type"`. Omitted organization defaults to by-type in this
replacement. Do not move or rename existing notes when changing the setting.

An excluded route wins over a broader route. A session allowlist is not equivalent
to all project sessions. Native IDs must come from an explicit selection; never
choose the latest session by cwd or copy a transcript record UUID as a prompt ID.
The replacement does not import the old v0.7.1 capture configuration or support
mixed-version operation. Old settings are not permission to enable new collection.

## Boundaries and diagnostics

Future start/resume freezes source identity and EOF. The worker seeks from that
floor rather than scanning previous history. The first later verified native unit
establishes the boundary and is excluded; later full eligible units can be captured.
State retains this coverage loss, exclusions and pauses. A missing source or boundary
stays pending. Resume, compact or clear events cannot silently restart a paused
selection or adopt a replacement file.

One-time current/historical capture uses explicit native IDs and an explicitly
selected byte window; it works with ongoing collection off. Missing IDs, unsupported
structure, excessive ranges and incomplete records are unresolved boundaries,
not permission to read a larger range. The active agent never mines archives.

Use `capture-status` for one selected session and `processing-pending` for bounded
metadata discovery. A busy/blocked intake is shown even when processing is Manual
or collection is paused. `storage-status` is an explicit deeper inventory that
may inspect raw captures; do not poll it during ordinary turns. Pruning, offline
lock recovery and processing recovery are separate reviewed operations.

Node.js 22+ must be available on the client's launch PATH. Desktop clients may not
inherit a terminal's runtime-manager PATH. Report missing Node, unavailable hooks,
policy restrictions and untrusted hooks without changing profiles, machine PATH or
trust. The host's feature/trust settings need direct host evidence; helper settings
alone do not prove that hooks execute. See [hooks](hooks.md) and
[verification](verification.md) for client and platform evidence limits.
