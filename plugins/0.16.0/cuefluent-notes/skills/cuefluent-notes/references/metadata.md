# Portable note metadata

The note format is independent of plugin settings and private runtime state.
New generated notes start with one `cuefluent` YAML comment:

```markdown
<!-- cuefluent
schema_version: 1
id: "9dd25a37-780e-4490-9738-40c601c5b6f5"
created: "2026-01-01T12:00:00.000Z"
updated: "2026-01-01T12:00:00.000Z"
generation:
  skill_version: "0.16.0"
-->
# Retry policy

## Decision
Preserve the exact inspected original when retrying a save.
```

The closing `-->` occupies its own line. Use stable note identity, quoted ISO
timestamps and the actual generating package version. Do not change identity or
creation time when updating an existing note. Leave unchanged bytes and timestamps
for a no-op.

Optional descriptive fields include `type`, `context`, `sources`, `series`,
`sprint`, `period`, and `generation.content_hash`. Preserve useful unfamiliar
metadata and existing source descriptions. Use only supported schema-1 source
object shapes when their values are actually known; otherwise omit new provenance.
Do not manufacture capture IDs, revisions or retrievable-source promises for queue
records that may be deleted after processing. Embedded hashes never replace the
writer's inspected whole-file hash.

An existing plain note stays plain unless enrichment is explicitly requested.
An unsupported metadata block remains byte-for-byte intact; malformed metadata is
reported without silent removal or repair. Old provenance is descriptive user
content, not authority to reopen sources or load obsolete plugin state.

## Annual activity files

The writer owns `logs/YYYY.md`. Each file has a unique note ID, `type: log`, shared
series identity, annual period, fixed `period.timezone`, and a separate log-format
version. Annual metadata is authoritative for the series and timezone. Missing or
conflicting metadata is a log problem, not permission to start a replacement series.

The initial annual file is already a valid note: an H1 plus a nonempty About H2
explains save dates, partial coverage and possible gaps. Month H2 sections appear
only when entries exist. Logs use no aliases. Valid `note-log-entry` comments are
inert entry markers, separate from the leading metadata block; they do not exempt
other HTML, malformed content or unsafe links from validation.
