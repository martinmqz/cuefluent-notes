Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.15.1 guards Claude processing launches against incomplete host
authentication, adds explicit reinspection of retained drafts after storage changes,
and clarifies which evidence caveats belong in a note.

## Claude processing authentication

Hosts that declare managed authentication must hand the separate processor an
explicit credential locator and its nonempty inherited value. Missing or unusable
handoffs return `PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE` before new processing
is admitted. The plugin does not fetch host secrets, substitute profile credentials,
or switch providers. In host-managed mode, inherited routing and authentication own
even absent fields. Profile provider selectors, endpoints, model environment
values, credentials and client certificates are ignored. Only supported proxy, CA,
timeout, output, thinking and effort defaults can fill missing fields. Supported
structured profile model preferences still pass as settings under native policy.
Profile credential-helper commands and otherwise unsupported provider switches
are ignored in this mode rather than refused.

Status, pending-proposal review, existing activity responses and exact completed
control replies remain available without launch credentials. Authentication is
required before acknowledging a finished review when starting another run.
Credential presence permits launch but does not establish credential validity or
expiry. Existing unknown outcomes still require recovery.

If a host cannot supply the supported handoff, use an independently authenticated
Claude terminal or the standalone workflow in an explicitly selected uncaptured
chat. Do not unset host authentication markers to force another account. See the
[authentication and settings contract](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#claude-launch-settings).

## Retained drafts after storage changes

`PROCESSING_BINDING_CHANGED` means an operation no longer has authority over the
current storage identity. Matching paths or note text are not enough to restore it.
Unapplied claims can be explicitly cancelled with their inspected hashes at the
same configured placement, leaving their inputs unhandled. A writer journal or
receipt prevents cancellation; storage changes after writing starts require
conflict resolution and preserve the writer state.

For a fully inspected, published draft **before any write transaction or receipt**,
the standalone reinspection workflow can preserve its exact text and create a
replacement operation. It requires the user's explicit decision to adopt the
currently inspected storage, unchanged configured placement and policy, exact
source heads and lineage, retained draft bytes and original destination content.
Changed evidence, settings, note text or unsafe paths remain conflicts.

Review the read-only preview, then transfer using its exact hash. Transfer archives
the original claim and draft text, creates a new unread claim and cancels the old
operation without marking its inputs handled. It writes no notes and carries no
old page acknowledgments or Save approval forward. Reinspect the replacement's
evidence and destinations, stage its proposal and review that exact proposal before
Save. Interrupted transfers reserve the shared writer until their metadata is
completed or safely abandoned; never remove their state to bypass a conflict.

This recovers only the selected draft. It does not migrate completed history,
frozen worksets, charged budgets or native chat bindings. Previously handled
revisions may appear pending in a new storage namespace: reconcile the affected
scope before starting more backlog work. Transfer archives retain draft text
indefinitely, including after Save or Cancel, with no automatic cleanup command.
Capture pruning does not remove them, and capture `storage-status` does not count
them. Missing intake selections now appear as operation conflicts in collection
inventory, while unrelated healthy drafts remain discoverable.

These are explicit CLI recovery commands, not a new skill shortcut or automatic
repair. See the
[reinspection requirements and limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing.md#reinspect-a-retained-draft-after-storage-changes)
and [command contract](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/workflow-cli.md#draft-reinspection).

## Note content and provenance

Authoring guidance keeps useful facts, decisions and material uncertainty visible,
with technical source bookkeeping in hidden provenance. Secondhand reports retain
their attribution. Testing or deployment caveats belong beside claims they actually
limit; a policy decision does not need an unrelated testing disclaimer. Unknown
meeting dates are omitted when immaterial; when chronology or the reporting period
matters, state the uncertainty. This guides agent judgment; it does not add a
semantic enforcement check. See
[note authoring](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/authoring.md)
and [date and verification evidence](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/evidence.md#dates-reports-and-verification).

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/distribution.md#verify-a-selected-package).

## Updating and native-host compatibility

For recognized `cuefluent-workflow` settings with collections and routes, preserve
settings, paths, captures and active operations; fresh setup is not required. Stop
collection entrypoints and processing, close affected client sessions, and let
workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.15.1 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

When upgrading from before 0.15.0, plain `process` now selects pending captures
across the whole configured collection, including its repositories and clients,
and can consume model usage across that scope. Use `process chat` for the previous
per-chat scope. See
[shortcut scopes and continuation](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#shortcut-scopes-and-continuation).

The MCP server offers `2025-11-25`, including when the host initially requests an
older protocol. A host unable to accept it disconnects from the server and loses
native status, processing and review controls. Use the
[explicit CLI processing workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/workflow-cli.md#processing-selected-captures)
from an uncaptured context instead. Hosts that accept the protocol but lack form
support leave review proposals pending. Edited or normalized preview content
other than line endings returns `PROCESSING_REVIEW_PREVIEW_CHANGED`; reopen review
or use the supported CLI proposal/save commands if the host cannot preserve it.

This release adds private draft-transfer records and standalone reinspection
commands. Existing settings, captures and engine operations are preserved; no
fresh setup or state reset is required. Older helpers do not enforce the new
transfer reservation. Keep all clients and helpers sharing a collection on this
release; mixed-version access and downgrades are unsupported. Earlier workflow
releases still cross the historical reader and processing-state boundaries
documented in the installed
[storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/setup.md#storage-compatibility).

Unfinished standalone operations, or older archived operations without native
ownership proof, can block new shortcut selections across the collection. Inspect
and finish or safely cancel that work through the explicit CLI after confirming
its previous processor has stopped; shortcut `cancel` cannot supply missing
ownership proof. Existing authorized proposals can still be reviewed. See
[unfinished operation ownership](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#unfinished-operation-ownership).

Legacy capture settings without recognized workflow settings require fresh setup,
with old files preserved without import. Missing, ambiguous, invalid or unsupported
settings need inspection before replacement setup. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md).

Keep the source client and its MCP host open until processing reaches a review or
terminal state. Closing a one-shot source host after admission can interrupt its
processing run. An accepted request is not proof that the model has started reading
evidence or finished a note. Use the skill action `status` for current progress and the
documented recovery commands after an interruption. Replaying an older exact
control call can retain its original `busy` wording.

Sequential batches consume native processing history. `PROCESSING_CHAT_HISTORY_FULL`
requires the guarded CLI command `processing-chat-rollover` once the session is
idle and review is resolved; there is no rollover skill action. Resume after the
rollover preserves the same chat and archived request history. See
[processing chat controls](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/workflow-cli.md#processing-chat-controls).

Codex's brief code-mode control exchange remains collectible and reports
`PROCESSING_EXCLUSION_UNVERIFIED` when collection is authorized. The restricted
processing chat's verified exclusion remains independent. Unverified attribution
leaves exclusions disabled, and inline processing in a captured chat can still
create more captures.

Protocol fixtures and package validation do not establish live host negotiation,
Desktop hook delivery, review-form rendering, physical approval or the complete
desktop workflow. Native review requires a host that preserves the preview and
supports the form contract. Durable authoring remains an agent judgment, not a
semantic guarantee of the Markdown checker. Controller status does not yet report
the resolved model. Fresh Windows Desktop/CLI acceptance on a clean account and
Cuefluent rendering/search remain unverified.

Reader rebuild, automatic lock reclamation and a desktop Node override remain
deferred. Pruning and abandoned-lock recovery require explicit commands. Existing
Windows package stores retain their documented limits on additions; see
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/setup.md#windows-storage-selection).
See the installed
[product limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/verification.md)
for the supported workflow's remaining boundaries.
