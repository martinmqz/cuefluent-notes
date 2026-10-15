Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.15.1 guards Claude processing launches against incomplete host
authentication, adds explicit reinspection of retained drafts after storage changes,
and clarifies which evidence caveats belong in a note.

## Claude processing authentication

Claude hosts declaring managed authentication through
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` or `CLAUDE_CODE_HOST_AUTH_ENV_VAR` now need
an accepted credential handoff before launching a separate processor. Missing or
unsupported handoffs return `PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE`; the plugin
does not fetch host secrets or switch accounts. Status, pending-proposal review,
existing activity responses and exact completed control replies remain available
without launch credentials.

The [Claude launch settings contract](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#claude-launch-settings)
defines accepted locator names, inherited routing and profile settings. Some
nonempty credential variables cannot serve as the locator. If the host cannot
supply a supported handoff, use an independently authenticated Claude terminal or
an explicitly selected uncaptured standalone chat; do not unset the managed-auth
markers to force another account. See the upgrade warning below for model selection.

## Retained drafts after storage changes

A retained draft blocked by `PROCESSING_BINDING_CHANGED` can now be explicitly
reinspected when it was fully inspected and published before any write transaction
or receipt. The user chooses whether to adopt the currently inspected storage;
the helper separately verifies unchanged placement, policy, evidence, draft text
and destinations. Reinspection preserves the text in a new unread operation.
It writes no notes and transfers no previous inspection or Save approval.

Follow the [reinspection workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing.md#reinspect-a-retained-draft-after-storage-changes)
for eligibility, the default limit of one active unpublished claim and the 1 MiB
cancellation record limit, then use its linked CLI commands. Fresh evidence
inspection and exact proposal approval are required before Save. A pending transfer blocks new
processing, direct writes, writer maintenance and capture pruning until completed
or safely abandoned. Started saves under changed storage remain conflicts;
reinspection does not repair them.

Completed transfers retain draft archives indefinitely, including after Save or
Cancel. Abandonment before a replacement claim exists instead removes only verified
archived draft copies while preserving the original durable draft and claim archive.
Capture pruning does not remove completed transfer archives, and capture
`storage-status` does not count them. The workflow documents retention and
interruption handling; these are explicit CLI controls, not automatic repair.

Separately, exact-hash `processing-recover` can now finish metadata for recorded
`cancelled`, `skipped` or `unchanged` outcomes after a storage identity change at
the same configured placement. See
[non-writing outcome recovery](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing.md#outcomes-and-recovery).
Neither recovery path migrates historical handled inputs, frozen worksets, budgets
or native chat bindings. Reconcile the affected scope before processing captures
that appear pending in a new namespace. Collection inventory also keeps missing
intake selections visible as conflicts while unrelated healthy drafts remain
discoverable.

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

When upgrading from v0.15.0 with host-managed Claude authentication, profile `env`
model selections such as `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_*_MODEL` no
longer fill missing host values. The resolved model, cost or quality can change,
and controller status does not report that model. Check the host's model selection
or supported structured profile model preferences under native precedence; see
[Claude launch settings](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#claude-launch-settings).

When upgrading from before 0.15.0, plain `process` now selects a bounded portion
across the configured collection, including its repositories and clients, and can
consume model usage across that scope. One request does not drain the backlog.
Use `process chat` for the previous per-chat scope, `resume` for the frozen unfinished
selection, and `process` again for later portions. See
[shortcut scopes and continuation](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/processing-chat.md#shortcut-scopes-and-continuation).

The MCP server offers `2025-11-25`, including when the host initially requests an
older protocol. A host unable to accept it disconnects from the server and loses
native status, processing and review controls. Use the
[explicit CLI processing workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/workflow-cli.md#processing-selected-captures)
from an uncaptured context instead. Hosts that accept the protocol but lack form
support leave review proposals pending. Edited or normalized preview content
other than line endings returns `PROCESSING_REVIEW_PREVIEW_CHANGED`; reopen review
or use the supported CLI proposal/save commands if the host cannot preserve it.

Existing settings, captures and engine operations are preserved; no fresh setup
or state reset is required. Mixed-version access and downgrades are unsupported.
The installed [storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.15.1/references/setup.md#storage-compatibility)
records the v0.15.1 transfer-reservation boundary, v0.15.0 shortcut boundary and
earlier reader/state changes for skipped-version upgrades.

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
