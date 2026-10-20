# Setup and status

Cuefluent Notes has two independent processes: deterministic capture of selected
session evidence, and agent processing into searchable Markdown. Both start inactive:
capture mode Manual (collection disabled in settings) and processing Manual. A direct
request to save selected material can proceed without setup. Installation or
trusting hooks supplies no capture consent.

## Inspect before changing

Run `node scripts/workflow.mjs status` from the installed package. Use an explicit
`--config` when one was selected; otherwise the helper respects
`CUEFLUENT_WORKFLOW_CONFIG` and its platform default. Status reads settings and
creates nothing; request `diagnostics: true` for bounded Windows package inventory. Report existing collections, routes, collection selection, processing
mode, destinations and transport limits; preserve settings unrelated to the request.
Use [workflow-cli](workflow-cli.md) for JSON request formats and inspected hashes.

For a bare “Use Cuefluent Notes”, ask which operation is wanted. For setup, establish
only missing choices: the project folder or explicit sessions; the notes folder or
file for finished notes; the capture mode; and the processing mode with its subject
scope. Do not ask the user to classify notes. Infer note
type from context when saving; new folder destinations default to type folders.
A chosen explicit file remains exact. Multiple projects and notes folders are
supported; route ambiguity requires a specific selection, never a guessed destination.

Explain the choices in ordinary terms, using the
[words people see](../SKILL.md#words-people-see):

- **Capture mode: Manual or Automatic.** Manual, the default, captures nothing on
  its own: typing `capture` in a chat captures its finished turns since the last
  capture. Automatic lets the hooks capture later turns of the route's clients'
  sessions in the project folder (a narrower excluded folder stays out), or of
  listed sessions only; `pause chat` stops it for one chat and `resume chat`
  restarts it. Capturing makes sensitive local JSON copies using scripts, with no
  model calls. It starts from its saved boundary, never earlier history: each
  session's first prompt after that boundary marks it and is not captured.
  Captured sessions can include secrets and private remarks; there is no automatic
  redaction. They are not finished Cuefluent notes.
- **Processing mode: Manual or Prompted.** Manual runs only when requested.
  Prompted prepares useful changes for approval. The capture mode does not select
  a processing mode, and processing existing captured turns does not require
  Automatic capture.
- **Automatic processing is not offered.** Its live trigger is unverified
  (`status.transport.automaticProcessing: false`): processing in a chat still
  needs an explicit request, and the drafts it prepares still go to review. It is
  not the same as Manual: a standalone CLI processing run may save without a
  review question (see [processing](processing.md)). Save it only when the user
  explicitly asks, and then confirm it as below.
- **Current limit:** live processing context transport is unverified. Processing
  requires an explicit request and native selection in every mode. Trusted hooks
  can capture automatically, but no mode makes Markdown processing run on its own.
  Do not promise native prompt rendering without verifying it in the actual client.

## Confirm Automatic processing

When setup or a mode change saves Automatic processing, give a concise confirmation
after the save succeeds, for each affected route/project. For example: “Automatic
processing is saved for [project], limited to [approved processing subject scope],
but it does not run on its own: processing in a chat still needs an explicit
`process`, and its drafts still go to review; a standalone CLI processing run may
save without a review question. Capture mode: Automatic for [N listed sessions].” Direct saves of supplied material retain their separate workflow.

Ground the processing limitation in the existing
`status.transport.automaticProcessing: false` result. Saving the preference does
not change that capability. Take each route's capture mode and session selection
from the `config` returned by `configure`, or its post-save status read-back.
Report Manual, Automatic for every session of the route's clients in the project
folder, or Automatic for N listed sessions; explicitly say “no sessions selected” for an empty list. Include
any known pause or exclusion, and do not describe an excluded route as capturing.
The processing subject scope limits note content; the capture mode belongs
to the route and may differ between projects.
Keep the confirmation in ordinary language; this reports the result of the save
and adds no approval question. Existing processing scope and save-consent rules
remain in [processing](processing.md).

## Windows storage selection

Fresh Windows setups use `<local user profile>\.cuefluent-notes\workflow.json`.
The raw, intake and writer suggestions share the selected settings file's
`collections\<collectionId>` folder. Explicit custom settings and aliases retain
that same base instead of creating storage at an unrelated implicit default.
The Markdown destination remains a separate user choice. The same resolver is used
by setup, the CLI and hooks; installation does not create this storage.

An explicit `--config` takes precedence over `CUEFLUENT_WORKFLOW_CONFIG`.
Without either override, an existing old
`%LOCALAPPDATA%\CuefluentNotes\workflow.json` stays selected when the new default
is absent. If both default files exist as distinct objects, the helper reports
`WORKFLOW_CONFIG_SELECTION_REQUIRED`; inspect them and explicitly select the
intended settings. `--config` selects only that command, not future hooks.
While both defaults exist, commands that need workflow settings and hook collection
require an explicit selection. For hooks, `CUEFLUENT_WORKFLOW_CONFIG` must be present
in the launching client's environment.
Verify the value in that client context; setting it in a separate terminal does
not establish what Desktop hooks inherit. Creating an explicit disjoint setup at
the other default location introduces this ambiguity for existing hooks too.
Equal contents do not make two stores interchangeable. Errors
or unreadable paths are not treated as missing settings. A network profile cannot
become the new default; an existing local setup remains selectable.

Before a fresh setup or ownership change, the helper checks known old/new defaults
and package-cache locations for conflicting settings. Incomplete discovery blocks
setup. It reads bounded settings for this comparison, never captures or notes.
Implicit fresh setup stops whenever other settings exist, even without overlap.
An explicit new path does not bypass an overlapping project, note destination or
private store. An explicitly selected, provably disjoint setup is permitted; empty package shadows alone
do not block the new profile default. See [Windows diagnostics](workflow-cli.md#windows-settings-discovery).

Windows package-backed stores are preserved. Existing prepared collections can
continue while their storage verifies, but missing roots cannot be created for
those stores. Additions that need new roots and replacement of the same collection
require separate migration work; this release has no migration or retirement
command. Do not copy settings to another host view, create another writer for the
same notes, or rerun fresh setup to work around that freeze.

Private settings and storage under the native profile, outside verified
non-roaming LocalAppData, require a local, loaded, non-roaming profile and content
indexing protection. This applies to custom private profile paths too. New empty
private directories get the NotContentIndexed attribute before private writes;
children must retain it. Existing unmarked data fail with
`PRIVATE_CONTENT_INDEXING_REQUIRED` and are not modified. Preserve the files and
review the storage configuration rather than moving them or recursively changing
attributes as an automatic repair. The native profile location is checked from
registry metadata. The WMI profile policy query runs only for private paths inside
that profile outside verified LocalAppData; failures block those paths, without
gating unrelated local stores. Read-only status does not grant that verification. These rules do not restrict finished notes in Documents, OneDrive or
other user-selected document locations. The indexing attribute is separate from
the raw folder's optional Hidden attribute and does not control every third-party
indexer or synchronization tool.

## Save the chosen settings

Use the complete configuration described by [session-workflow](session-workflow.md)
and the synthetic [example](../examples/workflow.json). `defaults` with a collection
ID suggests platform-specific private paths for a fresh collection. Never use
those defaults to replace existing bindings during an upgrade.
The user selects the Markdown location;
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
   status back and report saved preferences, verified storage, observed hook
   execution and completed capture as separate outcomes, including the transport limit.

The selected notes root must exist before proposal inspection; create a missing
root only within an explicit setup/destination authorization. Existing notes and
permissions remain intact. Category creation belongs to the approved note plan.
All overlapping note routes must share one writer state; do not create per-category
or per-session writers. A custom raw directory does not relocate intake state.

## Existing settings

Keep all client plugins/helpers sharing a store on the same released version.
Inspect the selected settings through `workflow.mjs status` before choosing a
setup path:

- **Recognized workflow settings** use `format: "cuefluent-workflow"` with
  collections and routes. Preserve them and follow the upgrade steps below.
- **Legacy capture settings only**, without a recognized workflow configuration,
  require fresh setup with separate collection and processing consent. Preserve
  the old settings and files without importing them.

An unexpectedly missing, ambiguous, invalid or unsupported configuration needs
inspection before setup. A filename, installed plugin version or failed status
command does not establish that the settings are legacy.

For recognized workflow settings:

1. Stop collection entrypoints and processing, close affected client sessions,
   and let their running workers and processing clients finish before replacing
   packages. Preserve unfinished operations; do not delete claims, locks or journals.
2. Keep the inspected workflow settings, storage paths, notes and consent choices.
   Do not rerun fresh setup or move storage unless the selected release explicitly
   requires it.
3. Update every client plugin and standalone helper using that collection to
   the selected release before any of them resumes access, including Codex and
   Claude when used. A worker can process registrations from either client.
4. Start fresh client sessions. Review hook or `cuefluent_control` MCP registration
   and permission changes when prompted, then inspect existing operations and
   resume them through their supported processing/recovery commands.

Review the [storage compatibility boundaries](#storage-compatibility) below and
the selected release notes for any additional changes. Configuration recognition
does not prove that older helpers can read newer captures, reader caches or
processing state. A patch does not necessarily introduce a new storage boundary.
Preserve existing immutable captures, packets and active operations; do not
rebuild them or discard state to bypass a revision conflict. See
[processing recovery](processing.md#outcomes-and-recovery).

Both hook and manual packages include the MCP server. It starts when loaded by
the client; an explicit `process` request can launch or resume a restricted native
client session using its normal authentication and model resolution. When
processing is enabled with collection off, trusted hooks may still store source
identity and byte-boundary metadata. Explicit native controls can read bounded
recent source records to verify their call. This creates no collection interval or
worker. Review [processing chat prerequisites and privacy boundaries](processing-chat.md)
before using the handoff. Installation grants neither collection nor processing
consent, and Automatic still needs an explicit processing request.

For Claude Desktop, explain the processor's authentication options during setup
and let the user choose. Do not start processing or inspect credentials to
verify that choice. If Desktop cannot pass its managed credential to
subprocesses, the user can explicitly select an already authenticated CLI
profile using the [processor authentication
setting](processing-chat.md#select-the-processors-authentication). Regular
native account logins and supported providers use this same choice; do not
assume a matching provider means the same account or change the setting
automatically after an error. This choice does not enable collection or
processing.

For Windows storage changes, follow
[Windows storage selection](#windows-storage-selection) and preserve existing
paths and consent; the profile default is not a migration.

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
The replacement does not import legacy capture configuration or support
mixed-version operation. Old settings are not permission to enable new collection.

### Storage compatibility

The following historical boundaries still matter when skipping releases. Keep
all helpers sharing a collection on the same release, including both clients
when used; a worker can process registrations from either client.

The release after v0.15.1 publishes new Codex captures with reader version 5,
which knows the `capture`, `pause chat` and `resume chat` actions. Helpers
through v0.15.1 do not know version 5 and fail when they re-read a turn captured
with it. Upgrade every helper sharing the collection together; downgrading after
version 5 captures exist is unsupported.
Version 1-4 captures keep their own rules and replay unchanged.

v0.15.1 adds retained-draft transfer state and the shared writer's
`reinspection.json` reservation. Helpers through v0.15.0 do not enforce that
reservation and can write notes or perform maintenance during a pending transfer.
Upgrade every shared helper before using
[draft reinspection](processing.md#reinspect-a-retained-draft-after-storage-changes).
Mixed-version access and downgrading after using this state are unsupported;
preserve the reservation and finish or safely abandon the exact transfer with
the matching helper.

v0.15.0 adds private shortcut checkpoints and control receipts, plus collection-wide
ownership checks for native processing. Earlier helpers do not implement these
controls. Mixed-version access and downgrading after using them are unsupported.
Plain `process` also changed from chat scope to bounded collection scope; use
`process chat` for the previous scope and follow
[shortcut continuation](processing-chat.md#shortcut-scopes-and-continuation)
for unfinished selections and later backlog portions.

v0.13.0 changed reader rules, including Claude reader-rules revision 2, Codex
per-kind tool budgets and verified processing-control exclusions, and added
processing state for worksets and reusable chats. Old and new helpers can produce
different capture revisions or disagree about that state. Mixed-version access
across this boundary, and downgrading a collection written by v0.13.0 or later to
a version before v0.13.0, are unsupported.

The v0.9.0 format change also applies when upgrading directly from v0.8.0.
Current readers accept v0.8.0 captures, but write `reader.headerClientVersion`
provenance and version-2 suspensions with `readerRulesRevision`; v0.8.0 rejects
these formats. Mixed-version access and downgrading a collection used by v0.9.0
or later to v0.8.0 are unsupported. Existing immutable capture bytes are preserved;
reader caches can be replaced under the current reader's rules.

Preserve immutable captures, packets and active operations across these upgrades.
Do not rebuild or discard them to bypass a conflict; use
[processing recovery](processing.md#outcomes-and-recovery).

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
