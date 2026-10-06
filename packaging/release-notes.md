Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.10.0 adds portable note metadata and related-note series.

- New generated notes receive a lean hidden HTML comment with a stable note ID,
  supplied source references, generation details, and useful retrieval context.
  Summaries, decisions, findings, action items, attribution, and uncertainty stay
  visible in Markdown. Raw session evidence remains the source of truth.
- Metadata preparation and guarded updates validate the supported schema and
  preserve existing note identity, creation time, source history, and unknown
  fields. Authoring guidance requires reconciliation of human edits. Source
  references and hashes are descriptive provenance;
  they do not grant access or saving permission.
- Recurring notes can share a stable series ID while retaining separate note IDs
  and natural file boundaries, such as one standup log per agreed sprint. Series
  guidance helps select the current member for current-work questions and the
  relevant historical members for older questions. Existing continuing notes stay
  in place unless the user chooses another boundary.
- Both Codex and Claude packages include the metadata helpers, series guidance,
  and synthetic examples. Existing plain notes stay plain unless explicitly
  enriched, and users can request plain Markdown for new notes.

**Upgrading from v0.9.0:** existing workflow settings, configured paths, evidence,
and notes are preserved. Installation does not backfill or split existing notes,
move files, enable collection or processing, or change hook trust. Update through
the original installation method and start a fresh client session afterward.

**Upgrading from v0.8.0:** the coordinated storage upgrade introduced in v0.9.0
still applies. Stop collection entrypoints and processing, close affected client
sessions, and let running workers finish before updating every plugin/helper
sharing the collection, including both Codex and Claude when used. Mixed access
with v0.8.0 and downgrading newer capture storage to v0.8.0 are unsupported.
Keep existing settings and paths; see the
[setup guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.10.0/references/setup.md#existing-settings).

**Upgrading from v0.7.1 or earlier:** fresh setup is required for the replacement
workflow introduced in v0.8.0. Old private files are preserved but not imported or
activated. Keep unfinished old journals with the v0.7.1 reference helper.

Collection and Markdown processing retain independent consent. Metadata and
series preparation enable neither. Historical collection still requires explicit
selected units and a fixed range. Native Save / Skip rendering, Cuefluent recursive
note loading, metadata-aware indexing, and search ranking remain unverified; the
series behavior above is skill guidance, not a claim about Cuefluent app indexing.
Complete packages require Node.js 22+. See the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.10.0/references/verification.md).

**Marketplace branch migration:** registrations pinned to the former
`marketplace` branch do not switch automatically. Follow the
[one-time migration instructions](https://github.com/martinmqz/cuefluent-notes#switch-an-older-marketplace-registration-to-main)
while preserving notes, workflow settings, and evidence storage.

After publication, the generated package-update PR must be reviewed and merged
into main before this version is available through the marketplace. SHA256SUMS
covers all four plugin ZIPs and the marketplace snapshot. Publishing does not
update an installed plugin; update it through its client when the marketplace is
ready.
