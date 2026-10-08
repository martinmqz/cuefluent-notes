Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.12.0 changes Windows storage selection to avoid separate Desktop
and terminal stores, and adds safeguards against recreating lost or redirected state.

- Fresh Windows setups default to `<local user profile>\.cuefluent-notes\workflow.json`.
  Suggested private storage stays beside the selected settings file, including
  explicit custom settings. macOS and Linux defaults are unchanged.
- Existing old Windows default settings remain selected when the new default is
  absent. If both exist as distinct files, the helper requires an explicit choice.
  Setup detects conflicting settings across known defaults and package caches;
  incomplete discovery or overlapping ownership blocks a new setup.
- Private storage creation checks for redirection and interrupted creation.
  Windows private paths under the profile, outside verified non-roaming
  LocalAppData, require a local, loaded, non-roaming profile and content indexing
  protection. These checks also apply to custom private paths; finished Markdown
  notes may still live in Documents, OneDrive or another selected destination.
- Status can request bounded Windows settings diagnostics without reading captures
  or notes. Unavailable unrelated AppData locations no longer prevent preparing
  local storage.

**Upgrading from v0.9.0–v0.11.0:** keep existing workflow settings and configured
paths; fresh setup is not required. Update all client plugins/helpers sharing a
store to the same version through their original installation methods, then start
fresh client sessions. Installation does not move or backfill files, split notes,
enable collection or processing, or change hook trust.

**Existing Windows stores:** the new default does not migrate existing data.
Prepared package-backed collections can continue while storage verifies, but
missing roots cannot be created for those stores. Additions needing new roots and
replacement of the same collection await separate migration work; there is no
migration or retirement command. Do not copy settings or rerun fresh setup to
create a second writer for the same notes. Existing private profile data without
indexing protection may fail with `PRIVATE_CONTENT_INDEXING_REQUIRED`; the helper
preserves it instead of changing its attributes automatically. Review
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/setup.md#windows-storage-selection)
before changing any paths or attempting setup again.

**Upgrading from v0.8.0:** the coordinated storage upgrade introduced in v0.9.0
still applies. Stop collection entrypoints and processing, close affected client
sessions, and let running workers finish before updating every plugin/helper
sharing the collection, including both Codex and Claude when used. Mixed access
with v0.8.0 and downgrading newer capture storage to v0.8.0 are unsupported.
Keep existing settings and paths; see the
[setup guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/setup.md#existing-settings).

**Upgrading from v0.7.1 or earlier:** fresh setup is required for the replacement
workflow introduced in v0.8.0. Old private files are preserved but not imported or
activated. Keep unfinished old journals with the v0.7.1 reference helper.

Collection and Markdown processing retain independent consent. Installation enables
neither, and collection does not read earlier history by default. Historical
collection requires explicitly selected units and a fixed range. Processing still
requires an explicit request and native selection in every mode, including Automatic,
until live processing context transport is verified. Reader rebuild, automatic lock
reclamation and a desktop Node override remain deferred; pruning and abandoned-lock
recovery require explicit commands.

**Live-test limitation:** fresh Windows Desktop and CLI setup in a clean account,
followed by live collection, processing and a duplicate-safe retry, remains
unverified. Synthetic redirection checks and native permission tests do not establish
that complete workflow. Native Save / Skip rendering, Cuefluent recursive note
loading, metadata-aware indexing and search ranking also remain unverified.
Complete packages require Node.js 22+. See the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/verification.md).

**Marketplace branch migration:** registrations pinned to the former
`marketplace` branch do not switch automatically. Follow the
[one-time migration instructions](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/README.md#switch-an-older-marketplace-registration-to-main)
while preserving notes, workflow settings, and evidence storage.

After publication, the generated package-update PR must be reviewed and merged
into main before this version is available through the marketplace. SHA256SUMS
covers all four plugin ZIPs and the marketplace snapshot. Publishing does not
update an installed plugin; update it through its client when the marketplace is
ready.
