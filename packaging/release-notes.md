Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.11.0 adds package integrity verification and consistent client builds.

- Codex and Claude packages use the same captured source and dependency bytes.
  Release checks reject mismatched shared content, manifest metadata, catalog
  descriptions and hook/manual identities.
- Each client and hook/manual variant includes a file inventory with sizes and
  SHA-256 hashes. Release records include the corresponding inventory digests.
- An explicit read-only verifier reports missing, changed and unexpected package
  files. Matching the included inventory proves internal consistency; verifying
  release identity also requires a digest from separately trusted release material.
  See [package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.11.0/references/distribution.md#verify-a-selected-package).
- Package checks reject symlink roots, unsafe portable paths and detected changes
  during inspection. Older published packages retain their original ZIP digest
  checks; published files are not rewritten to add inventories.

**Upgrading from v0.9.0 or v0.10.0:** existing workflow settings, configured paths, evidence,
and notes are preserved. Installation does not backfill or split existing notes,
move files, enable collection or processing, or change hook trust. Update through
the original installation method and start a fresh client session afterward.

**Upgrading from v0.8.0:** the coordinated storage upgrade introduced in v0.9.0
still applies. Stop collection entrypoints and processing, close affected client
sessions, and let running workers finish before updating every plugin/helper
sharing the collection, including both Codex and Claude when used. Mixed access
with v0.8.0 and downgrading newer capture storage to v0.8.0 are unsupported.
Keep existing settings and paths; see the
[setup guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.11.0/references/setup.md#existing-settings).

**Upgrading from v0.7.1 or earlier:** fresh setup is required for the replacement
workflow introduced in v0.8.0. Old private files are preserved but not imported or
activated. Keep unfinished old journals with the v0.7.1 reference helper.

Collection and Markdown processing retain independent consent. Package verification
enables neither. Historical collection still requires explicit
selected units and a fixed range. Native Save / Skip rendering, Cuefluent recursive
note loading, metadata-aware indexing, and search ranking remain unverified; the
related-note series behavior remains skill guidance, not a claim about Cuefluent app indexing.
Complete packages require Node.js 22+. See the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.11.0/references/verification.md).

**Marketplace branch migration:** registrations pinned to the former
`marketplace` branch do not switch automatically. Follow the
[one-time migration instructions](https://github.com/martinmqz/cuefluent-notes#switch-an-older-marketplace-registration-to-main)
while preserving notes, workflow settings, and evidence storage.

After publication, the generated package-update PR must be reviewed and merged
into main before this version is available through the marketplace. SHA256SUMS
covers all four plugin ZIPs and the marketplace snapshot. Publishing does not
update an installed plugin; update it through its client when the marketplace is
ready.
