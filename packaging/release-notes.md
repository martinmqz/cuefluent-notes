Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.13.1 fixes a Claude processing-launch failure introduced in
v0.13.0. The default CLI and `cuefluent_control` MCP paths could reject the native
Node environment before launching Claude, reporting `INVALID_PROCESSING_CLIENT`
or `PROCESSING_CONTROL_FAILED`.

The launch adapter now copies the inherited host environment, including copies
passed by a controller. Custom environment overrides still receive strict
validation. Engine credentials remain environment data, and the child launch removes the
inherited Claude nested-session sentinel without changing the parent environment.

## Runtime, license and downloads

Requires **Node.js 22+** on the client's PATH and the matching native client CLI
for processing. Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/LICENSE.md),
not an OSI-approved open-source license. See the
[licensing summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/README.md#license).

Assets include Codex and Claude plugin ZIPs in hook-enabled and manual variants,
a marketplace snapshot, and `SHA256SUMS` for verifying the downloaded archives.
Choose one variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/references/distribution.md#verify-a-selected-package).

## Updating

For existing v0.8.0–v0.13.0 workflows, preserve settings, paths, captures and active
operations; fresh setup is not required. Stop collection entrypoints and processing,
close affected client sessions, and let workers and processing clients finish.
Update every Codex/Claude plugin and standalone helper sharing the collection to
v0.13.1 before resuming. Start fresh sessions and review changed hook or MCP
permissions when prompted. Installation and hook trust grant neither collection
nor processing consent.

There are no storage-format or command-schema changes from v0.13.0. Upgrades from
before v0.13.0 still cross its reader-rule and processing-state changes;
mixed-version access and downgrading after that boundary are unsupported.
Upgrades from v0.7.1 or earlier require fresh setup, with old files preserved
without import. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/references/setup.md#existing-settings).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See the
[marketplace update commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/README.md#update-a-marketplace-installation).

## Processing boundaries and remaining limits

Processing remains an explicit request using the matching native client's normal
authentication and model resolution, which can incur model usage. Collection
does not import earlier history by default; Automatic does not schedule processing.
The processing engine retains its single writer, exact-proposal approval and
recovery rules. See
[processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/references/processing-chat.md).

Synthetic launch tests do not prove live hook binding, native exclusion proofs,
physical approval, desktop sidebar visibility or the complete desktop workflow.
Unverified attribution still leaves exclusions disabled; inline processing in a
captured chat can create more captures. Controller status does not yet report the
resolved model. Fresh Windows Desktop/CLI acceptance on a clean account and
Cuefluent rendering/search remain unverified.

Reader rebuild, automatic lock reclamation and a desktop Node override remain
deferred. Pruning and abandoned-lock recovery require explicit commands. Existing
Windows package stores retain their documented limits on additions; see
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/references/setup.md#windows-storage-selection).
The [verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.1/references/verification.md)
distinguishes automated coverage from live-client acceptance.
