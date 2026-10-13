Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.14.2 fixes collection and native processing controls rejecting
independent Codex chats created through the app's task-creation action. It also
makes source-binding refusals more precise without changing collection or
processing consent.

- **Independent Codex chats:** the reader accepts the supported app-created
  origin while retaining root identity, parent, fork and inherited-history checks.
  Delegated and inherited sessions remain unsupported.
- **Resumed source verification:** native processing controls validate resumed
  session metadata encountered within their authorized read range. Changed
  ownership, project identity or history mode stops verification.
- **Actionable source diagnostics:** controls distinguish an exact unverified hook
  registration from a missing source binding. Registration alone neither grants
  processing authority nor proves the worker is still pending. A stale collection
  grant requests review only while collection remains authorized; intentionally
  disabled collection uses independent processing authority and source binding.
- **Preserved capture boundaries:** existing consent, registration floors,
  selections, captures and operations remain intact. The update does not import
  earlier history or enable collection. A valid source binding takes precedence
  over unrelated registration hints; explicit source lookup retains guarded
  private-storage checks.

For recovery from source-binding and native verification errors, follow the
installed [processing entry guidance](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/processing-chat.md#entry-and-reuse).
Do not reset consent, edit transcripts or discard state to clear a refusal.
Formal processing still selects the invoking source session; it does not expand
the selection to every session in a collection.

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/distribution.md#verify-a-selected-package).

## Updating and native-host compatibility

For recognized `cuefluent-workflow` settings with collections and routes, preserve
settings, paths, captures and active operations; fresh setup is not required. Stop
collection entrypoints and processing, close affected client sessions, and let
workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.14.2 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

The MCP server offers `2025-11-25`, including when the host initially requests an
older protocol. A host unable to accept it disconnects from the server and loses
native status, processing and review controls. Use the
[explicit CLI processing workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/workflow-cli.md#processing-selected-captures)
from an uncaptured context instead. Hosts that accept the protocol but lack form
support leave review proposals pending. Edited or normalized preview content
other than line endings returns `PROCESSING_REVIEW_PREVIEW_CHANGED`; reopen review
or use the supported CLI proposal/save commands if the host cannot preserve it.

There are no storage-format or standalone workflow CLI schema changes from
v0.14.1. Earlier workflow releases still cross the historical reader and
processing-state boundaries documented in the installed
[storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/setup.md#storage-compatibility).
Mixed-version access and downgrading across those boundaries are unsupported.

Legacy capture settings without recognized workflow settings require fresh setup,
with old files preserved without import. Missing, ambiguous, invalid or unsupported
settings need inspection before replacement setup. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/processing-chat.md).

Keep the source client and its MCP host open until processing reaches a review or
terminal state. Closing a one-shot source host after admission can interrupt its
processing run. An admitted `busy` response is not a rejection; use
`processing_status` for progress and the documented recovery commands after an
interruption.

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
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/setup.md#windows-storage-selection).
See the installed
[product limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.2/references/verification.md)
for the supported workflow's remaining boundaries.
