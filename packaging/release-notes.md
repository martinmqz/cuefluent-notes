Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.15.0 adds collection-wide processing shortcuts, resumable evidence
selections, and clearer processing status. The existing engine continues to own
claims, proposals, exact approval, note writes and recovery.

## Processing shortcuts

Select Cuefluent Notes in Codex and enter an action, or append the action to
`/cuefluent-notes:cuefluent-notes` in Claude:

| Action | Behavior |
| --- | --- |
| `process` | Draft from pending retained captures across the existing collection, including its configured repositories and clients. |
| `process repo` | Limit new selection to the current verified Git checkout, excluding separate nested repositories. |
| `process chat` | Limit new selection to the invoking native chat. |
| `resume` | Continue the saved unfinished selection and inspection checkpoints without adding later captures. |
| `status` | Show execution state, bounded collection inventory, unfinished operations and drafts awaiting review. |
| `review` | Choose a pending draft when needed, then review its exact proposed changes. |
| `cancel` | Stop verified owned execution and cancel the saved selection's unapplied operations, including unsaved proposals; leave unhandled captures pending. |

**Plain `process` now uses collection scope instead of the invoking chat's scope.**
Use `process chat` for the narrower behavior. These actions use an existing
verified collection binding and preserve its routes, consent and capture settings.
They do not create a second collection or writer for a nested project.

- **Resumable, bounded work:** `process` resumes saved unfinished work first and
  reports its actual scope. A conflicting narrower request is refused. After
  that work finishes, it can select a fresh bounded portion in the requested scope.
  Exact input hashes, page checkpoints and outcomes survive interruptions.
  Handled revisions are not admitted again; a changed head remains new evidence.
- **Reusable processing session:** bounded batches run sequentially in the existing
  isolated native session. Processing stops for a draft review, unfinished
  operation, conflict, recovery requirement, lack of progress or run limit.
  Use `resume` for the frozen remainder and `process` for later inventory portions;
  a single request does not promise to drain an arbitrary backlog.
- **Clear status:** accepted requests, an already active run, current processing,
  unfinished work and no pending evidence have distinct responses. An inactive
  processor does not imply an empty backlog. Bounded inventory, selection progress
  and unknown source completeness remain separate.
- **Safe review and cancellation:** currently authorized pending drafts can be
  selected for exact review. Known active collection processing blocks a duplicate
  run across native sessions. Cancellation requires verified ownership and stopped
  execution; standalone claims without that proof remain for explicit CLI handling.
  Recovery and unknown outcomes require inspection, never discarded state.

`process` and `resume` prepare drafts; they never approve or save them. Saving
requires the exact proposal's review decision. Collection settings remain unchanged;
only an approved Save writes the proposed notes. Cancelling a proposal makes it
unavailable for Save; regenerating it requires processing again and can incur model
usage. Choose Later in review to keep a proposal pending. Cancellation retains
evidence and operation history rather than deleting their files. See
[shortcut scopes and continuation](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/processing-chat.md#shortcut-scopes-and-continuation)
and the versioned
[CLI checkpoint contract](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/workflow-cli.md#processing-shortcut-checkpoints).

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/distribution.md#verify-a-selected-package).

## Updating and native-host compatibility

For recognized `cuefluent-workflow` settings with collections and routes, preserve
settings, paths, captures and active operations; fresh setup is not required. Stop
collection entrypoints and processing, close affected client sessions, and let
workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.15.0 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

The MCP server offers `2025-11-25`, including when the host initially requests an
older protocol. A host unable to accept it disconnects from the server and loses
native status, processing and review controls. Use the
[explicit CLI processing workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/workflow-cli.md#processing-selected-captures)
from an uncaptured context instead. Hosts that accept the protocol but lack form
support leave review proposals pending. Edited or normalized preview content
other than line endings returns `PROCESSING_REVIEW_PREVIEW_CHANGED`; reopen review
or use the supported CLI proposal/save commands if the host cannot preserve it.

This release adds private shortcut checkpoints and control receipts, collection-wide
ownership checks, and explicit inventory/shortcut CLI commands. Existing settings,
captures and engine operations are preserved; no fresh setup or state reset is
required. Older helpers do not implement these shortcut controls. Keep all clients
and helpers sharing a collection on this release; mixed-version access and
downgrades are unsupported. Earlier workflow releases still cross the historical
reader and processing-state boundaries documented in the installed
[storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/setup.md#storage-compatibility).

Unfinished standalone operations, or older archived operations without native
ownership proof, can block new shortcut selections across the collection. Inspect
and finish or safely cancel that work through the explicit CLI after confirming
its previous processor has stopped; shortcut `cancel` cannot supply missing
ownership proof. Existing authorized proposals can still be reviewed. See
[unfinished operation ownership](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/processing-chat.md#unfinished-operation-ownership).

Legacy capture settings without recognized workflow settings require fresh setup,
with old files preserved without import. Missing, ambiguous, invalid or unsupported
settings need inspection before replacement setup. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/processing-chat.md).

Keep the source client and its MCP host open until processing reaches a review or
terminal state. Closing a one-shot source host after admission can interrupt its
processing run. An accepted request is not proof that the model has started reading evidence or
finished a note. Use the skill action `status` for current progress and the
documented recovery commands after an interruption. Replaying an older exact
control call can retain its original `busy` wording.

Sequential batches consume native processing history. `PROCESSING_CHAT_HISTORY_FULL`
requires the guarded CLI command `processing-chat-rollover` once the session is
idle and review is resolved; there is no rollover skill action. Resume after the
rollover preserves the same chat and archived request history. See
[processing chat controls](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/workflow-cli.md#processing-chat-controls).

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
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/setup.md#windows-storage-selection).
See the installed
[product limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.0/references/verification.md)
for the supported workflow's remaining boundaries.
