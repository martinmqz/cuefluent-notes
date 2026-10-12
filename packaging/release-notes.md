Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.13.2 fixes native processing handoffs that could fail when
Claude had not yet saved its tool-use record or Codex invoked the MCP tool inside
a code-mode exec.

- **Claude:** briefly waits for missing native records, then performs a bounded
  search of already registered sessions if needed. After `/clear`, a stopped
  capture, over-limit tail or changed selection in the old session or an unrelated
  candidate no longer blocks the matching session. Invalid matching calls and
  replaced source files still fail verification.
- **Codex:** uses a verification handshake for nested code-mode calls. The skill
  repeats the same control with an opaque token in a separate exec; processing
  starts only after the completed native call and exact response are verified.
  Restricted processing execution also recognizes supported code-mode records.
- **Consent and retries:** source-exclusion warnings require current collection
  permission, independently of processing consent. Expired or cancelled handshakes
  cannot dispatch, and status checks do not repeat processing requests.

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/distribution.md#verify-a-selected-package).

## Updating

For recognized `cuefluent-workflow` settings with collections and routes, preserve
settings, paths, captures and active operations; fresh setup is not required. Stop
collection entrypoints and processing, close affected client sessions, and let
workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.13.2 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

There are no storage-format or standalone workflow CLI schema changes from
v0.13.1. Native MCP controls can now return `verification-required` and accept its
`retryToken`; the updated skill handles that exchange. Earlier
workflow releases still cross the historical reader and processing-state
boundaries documented in the installed
[storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/setup.md#storage-compatibility).
Mixed-version access and downgrading across those boundaries are unsupported.

Legacy capture settings without recognized workflow settings require fresh setup,
with old files preserved without import. Missing, ambiguous, invalid or unsupported
settings need inspection before replacement setup. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/processing-chat.md).

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

Protocol exchanges and client registration do not establish Desktop hook delivery,
native review-form usability or physical user approval. Controller status does not yet report the resolved model. The complete
fresh Windows Desktop/CLI workflow and Cuefluent rendering/search remain unverified.

Reader rebuild, automatic lock reclamation and a desktop Node override remain
deferred. Pruning and abandoned-lock recovery require explicit commands. Existing
Windows package stores retain their documented limits on additions; see
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/setup.md#windows-storage-selection).
The [verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.2/references/verification.md)
describes general coverage and product limits.
