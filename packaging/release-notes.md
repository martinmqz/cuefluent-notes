Capture and organize your knowledge for fast recall—right on cue.

This update improves session-format compatibility and private raw-folder setup.

**Breaking storage compatibility change:** v0.9.0 writes capture provenance and
reader-suspension formats that v0.8.0 cannot read. Before updating, stop collection
entrypoints and processing, close affected client sessions, and let running
workers finish. Update every client plugin/helper sharing the collection to
v0.9.0, including both Codex and Claude when used, before starting fresh sessions
or resuming collection or processing. Mixed v0.8.0/v0.9.0 access and downgrading
a collection used by v0.9.0 to v0.8.0 are unsupported. The newer reader accepts
existing v0.8.0 captures; this does not make new captures readable by the old one.

- Codex and Claude readers accept supported native record shapes across client
  version labels, including sessions continued after a client update. Native
  identity, ownership, selected boundaries and supported formats remain required;
  this does not guarantee support for every future client format.
- Paused Claude selections recheck stale reader caches within their saved capture
  boundary. Updating does not extend those selections or read later session data.
- New collections use `.cuefluent-raw`. On Windows, explicit storage preparation
  also attempts to set and verify the raw folder's Hidden attribute after all
  private storage passes permission checks. Hidden folders still require the
  same private permissions; a visibility warning does not waive a privacy failure.
- Storage preparation rejects conflicting raw/intake pairings and concurrent
  changes. Lock cleanup attempts to restore missing owner metadata after removal
  failures, while preserving competing owners and reporting unsafe cleanup.

**Upgrading from v0.8.0:** existing settings, capture filenames and configured paths
are preserved. Updating does not move or rename raw folders or rerun storage
preparation; fresh setup is not required. To hide an existing Windows raw folder,
explicitly request `storage-prepare` for that collection after the coordinated
upgrade. A running worker or another lock owner can cause `INTAKE_BLOCKED` on
healthy storage: let the owner finish, then retry. An abandoned or uncertain lock
requires inspection and explicit offline recovery; never delete it or change
storage paths to bypass it. Existing macOS/Linux folders retain their names and
visibility. Do not replace an existing collection's paths with new defaults; see
[setup](https://github.com/martinmqz/cuefluent-notes/blob/v0.9.0/references/setup.md#existing-settings)
and [offline recovery](https://github.com/martinmqz/cuefluent-notes/blob/v0.9.0/references/session-workflow.md#blocked-intake-and-explicit-recovery).

**Upgrading from v0.7.1 or earlier:** fresh setup is required for the replacement
workflow introduced in v0.8.0. Old private files are preserved but not imported or
activated. Keep unfinished old journals with the v0.7.1 reference helper.

Collection and Markdown processing retain independent consent. Installation and
hook trust enable neither. Collection starts at its registered boundary and does
not read earlier session history by default; historical capture requires an
explicit fixed range and selected units. Pruning and abandoned-lock recovery
require explicit commands, with an offline window for lock recovery. Reader
rebuild, automatic lock reclamation and a desktop Node override remain deferred.
Node.js must be available on the client's launch PATH.

Claude capture still covers proven human input only,
with unconfirmed coverage. Live current-turn transport remains unverified, so
automatic Markdown processing and conversational current-turn controls remain
unavailable; use explicit session/unit selection and processing commands. Native
Save / Skip rendering, Cuefluent recursive note loading and search ranking remain
unverified.

Complete Codex and Claude packages require Node.js 22+. Consult the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.9.0/references/verification.md)
for automated coverage and live-client limitations.

**Marketplace branch migration:** new releases use `main`. Existing registrations
pinned to `marketplace` do not switch automatically and will remain on their old
version after an ordinary refresh. Follow the
[one-time migration instructions](https://github.com/martinmqz/cuefluent-notes#switch-an-older-marketplace-registration-to-main)
for Codex and Claude. Keep notes, workflow settings and evidence storage; the
branch change does not require fresh setup.

After release publication, **Publish marketplace** opens a package-update PR and
starts its CI checks. Wait for that PR to be reviewed and merged into `main`
before updating through the marketplace. Review any changed hooks; run **Set up Cuefluent Notes**
for a fresh installation or an upgrade from v0.7.1 or earlier.
`SHA256SUMS` covers all four plugin ZIPs and the marketplace snapshot. Publishing
does not update an installed plugin; update it through your client after the
marketplace is ready.
