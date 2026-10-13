Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.14.1 fixes restricted Claude processing losing supported
provider settings from the native user profile. Processing uses the existing
native client and shared writer; it does not add a model runner or change capture
consent.

- **Supported Claude configuration:** eligible processing runs and resumes read
  bounded user-profile settings for supported provider, authentication, deployment
  and connection environment values, plus model preferences, mappings and
  allowlists. This preserves configured Foundry, Bedrock/Mantle, Vertex and
  first-party/gateway setups without loading unrelated settings.
- **Host-aware precedence:** processing invoked from Claude preserves values
  already supplied by its host environment. A standalone CLI launch outside
  Claude applies supported user-profile environment values over shell values.
  The native profile locator keeps its original spelling and credential namespace.
- **Restricted execution remains intact:** hooks, plugins, slash commands and
  arbitrary tools stay disabled. Authentication values remain in the child process
  environment, outside command arguments, receipts and plugin diagnostics.
- **Actionable settings errors:** malformed, unavailable, changing, oversized or
  explicitly unsupported settings stop processing before native admission.
  Existing-proposal review and status do not parse these launch settings, though
  their registry still requires a resolvable native profile directory.

Configured Claude credential-helper commands are refused without execution.
Project-specific structured settings are not read. Stored structured effort preferences are not restored; use
`CLAUDE_CODE_EFFORT_LEVEL` through the host environment or supported user-profile
`env` settings when needed. Otherwise the native client resolves effort without
those stored preferences.

The user file is reread for each eligible run, but inherited host values still
win. After rotating a credential in the profile, restart the source client and
reconnect its plugin MCP server to refresh an inherited value. Keep processing
state and captures intact. An interrupted or unknown run still requires the
existing recovery controls; this update does not reset it. See the installed
[Claude launch settings and recovery guidance](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/processing-chat.md#claude-launch-settings).

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/distribution.md#verify-a-selected-package).

## Updating and native-host compatibility

For recognized `cuefluent-workflow` settings with collections and routes, preserve
settings, paths, captures and active operations; fresh setup is not required. Stop
collection entrypoints and processing, close affected client sessions, and let
workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.14.1 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

The MCP server offers `2025-11-25`, including when the host initially requests an
older protocol. A host unable to accept it disconnects from the server and loses
native status, processing and review controls. Use the
[explicit CLI processing workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/workflow-cli.md#processing-selected-captures)
from an uncaptured context instead. Hosts that accept the protocol but lack form
support leave review proposals pending. Edited or normalized preview content
other than line endings returns `PROCESSING_REVIEW_PREVIEW_CHANGED`; reopen review
or use the supported CLI proposal/save commands if the host cannot preserve it.

There are no storage-format or standalone workflow CLI schema changes from
v0.14.0. Earlier workflow releases still cross the historical reader and
processing-state boundaries documented in the installed
[storage compatibility guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/setup.md#storage-compatibility).
Mixed-version access and downgrading across those boundaries are unsupported.

Legacy capture settings without recognized workflow settings require fresh setup,
with old files preserved without import. Missing, ambiguous, invalid or unsupported
settings need inspection before replacement setup. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/processing-chat.md).

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
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/setup.md#windows-storage-selection).
See the installed
[product limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.14.1/references/verification.md)
for the supported workflow's remaining boundaries.
