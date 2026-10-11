Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.13.0 adds bounded, resumable processing and an explicit handoff
to a reusable Codex or Claude processing chat.

## Processing changes

- **Reusable processing chat:** invoke the Cuefluent Notes skill with `process`
  in Codex, or `/cuefluent-notes:cuefluent-notes process` in Claude. The bundled
  `cuefluent_control` MCP server creates or resumes a restricted native client
  session for the selected collection. Invoke the skill with `review` to request
  the host's exact-proposal review form. The existing engine remains the single
  owner of claims, proposals, safe writes and recovery; Cuefluent is not required.
- **Resumable, bounded work:** metadata-only inventory distinguishes unread work,
  inspection progress, pending proposals, conflicts and completed outcomes.
  Frozen worksets and byte/input limits bound a backlog; existing operations resume
  before another batch is claimed. Reading every retained page does not establish
  that the original source was complete, and many captures can yield one note or
  no change.
- **Processing feedback prevention:** the dedicated client disables inherited
  collection hooks and restricts tools before processing. Verified formal controls
  and exact native execution records can support narrow exclusions. Genuine work
  and corrections in mixed messages stay eligible for capture. Arbitrary copies
  printed in ordinary chats are not automatically identified or removed.
- **Fairer Codex tool evidence:** separate per-call and per-kind allowances keep
  one large tool result from consuming the entire tool-text budget. Explicit
  omissions distinguish clipped text and retained descriptors. These rules apply
  to new evidence; they cannot recover output already omitted from old captures.
- **Clearer outcomes and recovery:** bounded operation and controller diagnostics
  expose blocking claims, unknown execution outcomes and capacity limits. Saved
  Automatic settings now receive a confirmation that processing still needs an
  explicit request. Unfinished work remains inspectable rather than being replaced
  with another claim or chat.

See [processing chats](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/processing-chat.md)
and [bounded processing](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/processing.md)
for supported controls, approval, correction and recovery behavior. Standalone
agents can still use the CLI from an uncaptured context.

## Before upgrading

**Coordinate every helper sharing a collection.** Stop collection entrypoints and
processing, close affected sessions, and let running workers and processing clients
finish. Update every Codex/Claude plugin and standalone helper using that store to
v0.13.0 before resuming. Keep existing v0.8.0–v0.12.0 settings, paths, captures and
active operations; fresh setup is not required. Reader rules and processing state
have changed. Mixed-version access and downgrading after v0.13.0 writes to a store
are unsupported. Follow the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/setup.md#existing-settings).
Upgrades from v0.7.1 or earlier still require fresh setup; old private files remain
preserved without import.

**Review the new MCP server as well as changed hooks.** Both hook and manual
packages register `cuefluent_control` through `.mcp.json`; the host can start it
when loading the plugin. An explicit processing request uses the matching native
CLI's normal authentication and model resolution, and can incur model usage under
that account. A desktop installation alone does not prove the CLI is available.

**Collection off does not forbid all processing metadata.** When processing is
enabled, trusted hooks can register source identity and a byte boundary without
starting a collection worker or copying transcript content. An explicit native
control verifies source records using bounded recent reads (up to 2 MiB per
candidate source after its boundary, plus native header/boundary checks). See the
[entry and privacy boundaries](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/processing-chat.md#entry-and-reuse).
Unconfigured and entirely disabled hooks still write nothing. Installation and
hook trust grant neither collection nor processing consent. Collection does not
import earlier history by default, and Automatic does not schedule processing.

**Windows storage:** existing prepared package stores remain usable while they
verify, but additions needing missing roots remain frozen pending separate
migration work. Do not create a second writer or change paths to bypass a refusal.
See [Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/setup.md#windows-storage-selection).

## License and distribution

This release identifies Cuefluent as publisher and is source-available under the
Sustainable Use License 1.0 (`SUL-1.0`), not an OSI-approved open-source license.
Personal, non-commercial and internal business use are permitted; redistribution
must be free and non-commercial. Commercial redistribution or selling access
requires permission from the applicable copyright holders. Your own inputs,
captures and authored notes are not relicensed by using the plugin; copied code
and third-party material retain their applicable licenses. Review the
[license and usage summary](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/README.md#license).
Both packages include project and dependency license notices and require Node.js 22+.

The GitHub release provides four plugin ZIPs, a marketplace snapshot and
`SHA256SUMS`. Marketplace installation becomes available after the package-update
PR merges into `main`; publishing alone does not update an installed plugin.
Registrations pinned to the old `marketplace` branch need the
[one-time switch to main](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/README.md#switch-an-older-marketplace-registration-to-main)
after the catalogs are available.

## Verification limits

Native protocol fixtures and disposable-client checks do not establish processing
chat visibility in the desktop sidebar, physical user approval, or the complete
live desktop workflow. Controller status does not yet report the resolved model.
Arbitrary generated-copy attribution, fresh Windows Desktop/CLI acceptance in a
clean account, and Cuefluent file loading, rendering and search ranking remain
unverified. Inline processing in captured chats can still create another backlog.
Reader rebuild, automatic lock reclamation and a desktop Node override remain
deferred; pruning and abandoned-lock recovery require explicit commands.
See the [verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.13.0/references/verification.md)
for automated coverage and the distinction between disposable CLI validation and
checks of the exact release assets.
