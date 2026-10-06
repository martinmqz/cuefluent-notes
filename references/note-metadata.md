# Portable note metadata

An optional HTML comment stores descriptive Cuefluent metadata in the Markdown
source without displaying it in ordinary rendered Markdown. Keep summaries,
decisions, findings, action items, source attribution and meaningful occurrence
dates in visible sections. Metadata does not replace the useful document.

The standalone checker supports this contract. The recorded app compatibility
baseline still searches headings and aliases only: these fields do not establish
app ingestion, identity, ranking, series expansion or recursive discovery. See
[authoring](authoring.md) and [retrieval](retrieval.md).

## Envelope and interpretation

Use at most one block before all visible content and other comments. Leading
blank lines and a UTF-8 BOM are allowed. The opening line is exactly
`<!-- cuefluent` (up to three leading spaces and trailing whitespace allowed).
The closing `-->` occupies its own line. LF, CRLF and CR line endings are
accepted without changing source bytes. Use one YAML 1.2 core mapping inside.
For example, these are fictional identifiers and dates:

```markdown
<!-- cuefluent
schema_version: 1
id: note_example
created: "2026-10-01T07:42:00-07:00"
context:
  project: workbook-plugin
  topics: [maestro, hackathon]
-->

# Workbook plugin

## October 1 planning decision

The fictional team agreed to review the prototype before scheduling a rollout.
```

`schema_version: 1` and a stable string `id` are required when a block is
present. YAML core numeric spellings such as `1.0`, `0x1` and `1e0` also
resolve to version 1; interpretation uses the numeric value, not its spelling.
All other defined fields are optional, subject to their own complete
shapes below. A note without metadata remains valid ordinary Markdown.

The parser is read-only. Fenced and indented code examples are inert. Repeated,
misplaced, unterminated or malformed metadata produces checker errors while
visible Markdown is still inspected. A structurally safe unsupported schema
produces a warning and an opaque block, not interpreted fields. Preserve its
bytes; do not silently downgrade it, regenerate it or infer write permission.
The writer and processing proposal checks require an existing unsupported block
to remain byte-for-byte unchanged, including its line endings and formatting.
Visible body updates can proceed while preserving that block.
Unknown fields in schema 1 retain their values and have no defined behavior.

The `cuefluent` comment marker is reserved, including malformed single-line
variants, case/spacing mistakes such as `<!--Cuefluent`, punctuation after the
keyword such as `<!-- cuefluent?`, and markers inside raw HTML wrappers,
link/image titles, reference definitions or named footnote labels and bodies,
including unused or overwritten definitions. Letters, numbers, combining marks
and underscore continue the name, including Unicode characters: `cuefluently`,
`cuefluent_extension` and `cuefluent文` are separate comment names. Use fenced or indented code
for literal examples. Metadata errors also block shared-writer saves and processing
proposals; a malformed tracked output can block a derived collection refresh.
Report an existing malformed block for the user to resolve and preserve its
bytes; do not repair or remove it just to make a save pass. Unsupported-schema
warnings alone do not block an otherwise valid document. If a marker occurs
beyond the Markdown parser’s nesting limit, its context cannot be verified and
the check fails closed rather than assuming the skipped content is inert.

The following safety envelope applies to every schema, including unsupported
future versions; an unsafe future block is an error, not an opaque warning.
Metadata is limited to 64 KiB in a note of at most 2 MiB UTF-8. Parsing permits
at most 4,096 AST nodes, depth 8, 128 items per mapping or sequence and 2,048
characters per scalar string. Keys are 1–64 ASCII letters/digits/underscore/dot/
hyphen, starting with a letter or underscore. Prototype-related keys are
rejected. Values are finite numbers, booleans, null, strings, lists and mappings.
Numeric scalars must round-trip through JavaScript numbers without changing
their decimal value; quote large integers or high-precision decimals to retain
them exactly as strings. Validation never returns a silently rounded value.
Reject duplicate keys, YAML directives/document markers, anchors, aliases,
explicit tags, merge keys, complex keys, forbidden controls (including DEL and
the C1 range U+0080–U+009F) and embedded HTML
comment delimiters. Unknown fields must obey these same bounds. Errors never
include metadata field values or raw parser excerpts.

## Fields and identity

Dotted table names below describe nested mappings, as in the example above.
They are not literal YAML keys: `context.project: value` is an unrelated unknown
extension key and does not set or validate `context: {project: value}`. Unknown
extension keys, including keys containing dots, have no defined field behavior.

| Field | Meaning and requirements |
| --- | --- |
| `id` | Stable identity of this note; preserve through edits and moves. Use a collision-resistant value, for example `note_` plus a UUID. |
| `type` | Optional descriptive lowercase kebab-case type, such as `meeting` or `standup-log`; at most 64 characters. Does not select a writer mode or destination. |
| `created`, `updated` | Note creation and last meaningful update, as single- or double-quoted ISO timestamps with seconds and an explicit offset or `Z`; optional 1–3 fractional digits. Schema 1 rejects plain and block scalars for these fields. Updated cannot precede created when both exist. Reading, reindexing and no-op generation should not change them. |
| `sources` | Up to 128 explicit selected-source descriptors; see below. Omit when there is no recoverable reference rather than inventing one. |
| `context.project` | Stable project key, not a machine-local checkout path. Renaming a display label should not change identity. |
| `context.topics`, `context.entities` | Up to 128 distinct supported strings each, at most 256 characters each. Entity names may include people when useful and evidenced; these are descriptive retrieval hints. |
| `series.id`, `series.label` | Stable series identity, plus an optional human-readable label of at most 256 characters. Each member retains its own note ID. |
| `sprint` | String label of at most 128 characters; quote numeric-looking values such as `"20.26"`. |
| `period.start`, `period.end`, `period.timezone` | Inclusive calendar dates `YYYY-MM-DD`, ordered start through end, and a named timezone recognized by the runtime’s `Intl.DateTimeFormat`. These describe the note's subject period, independently of note timestamps. All three are required when period is present. The helper quotes date strings for YAML portability; existing plain date scalars remain supported. |
| `generation.skill_version` | Version string of the skill that generated the current material; independent of schema version. |
| `generation.content_hash` | Optional `sha256:` plus the full lowercase 64-hex digest of UTF-8 note bytes after removing precisely the metadata block, including its closing-line newline. All other bytes, including surrounding blank lines and BOM, remain in the hashed content. |

Note, project, series and source IDs are case-sensitive ASCII tokens, 1–128
characters, beginning with a letter or digit and otherwise containing letters,
digits, dot, underscore, colon or hyphen. IDs are not paths. An intentional new
note gets a new ID; moving the same note retains it. The checker reports
collisions only among explicitly selected files, without scanning other files
or deciding whether two copies should be merged. Processing proposals reject
collisions within their proposed batch and with retained derived outputs before
recording proposal intent. The shared writer rechecks collisions
across the proposed outputs and any retained outputs in its derived manifest
before writing; it does not scan unrelated authored notes.

Prefer current IANA names such as `America/Los_Angeles` and `Asia/Kolkata`, or
`UTC`. Recognized aliases, case variants and named fixed-offset zones such as
`Etc/GMT+5` remain valid. Validation preserves the stored spelling without
requiring it to match the runtime's canonical spelling, which can differ across
timezone database versions. The recognized set still depends on the runtime’s
timezone data. Numeric offset strings such as `+01:00` are not named timezones.

## Selected sources and hashes

A session source uses `type: session`, `client: codex` or `claude`, `session_id`,
`unit_id` and `revision`. The revision is the full lowercase 64-hex evidence hash
of the selected immutable capture; use its actual native identities and revision,
never a filename's shortened hash. An optional `raw_ref` is a location hint of at
most 2,048 characters, not identity or permission to read that location. Several
revisions or sessions may contribute to one note. A session identity is the tuple
`type`, `client`, `session_id`, `unit_id`, `revision`. Repeating that identity is
rejected even if `raw_ref`, `source_hash` or unknown descriptive fields differ.

A supplied document source uses `type: document` and a `ref` of at most 2,048
characters. Optional `locator` (at most 2,048 characters) identifies a section,
record or selected range; `version` (at most 256 characters) records a supplied
version. Document identity is the tuple `type`, `ref`, `locator`, `version`,
`source_hash`, with absent optional fields treated as null. Repeated document
identities are rejected; different supplied versions or hashes may coexist.
Both source types may include `source_hash`, a `sha256:`-prefixed full
digest of the exact selected source bytes. Do not hash a growing whole session
as a substitute for the selected capture revision. No source reference is
opened or independently verified by metadata validation.

Raw session records preserve original captured evidence; selected immutable
captures identify what informed generation. A recorded statement does not prove
its real-world truth. Generated Markdown retains traceability and subsequent
human corrections. See [evidence](evidence.md).

Changed source bytes indicate a need for review, not a new factual answer.
Changed note content may indicate a human edit. Embedded hashes are descriptive
and user-editable: they neither authorize replacement nor replace inspected
whole-file hashes, private writer manifests, claims or receipts. The read-only
checker validates hash syntax, not hash freshness. Preserve authored/derived
ownership and all [safe-update protections](refresh.md).

## Series and portability

A series connects natural human-sized documents, such as one standup log per
sprint. Follow [series authoring](note-series.md) for member selection, boundaries
and conflicts. Share the stable series ID; preserve distinct note IDs, visible dates,
individual source references and period boundaries. A label alone, such as
`standups`, does not identify a series across projects. Unknown membership must
not be guessed from a filename or title.

Metadata remains in copied or shared Markdown. Prefer opaque portable source
references over private machine paths. Missing sources remain explicit gaps;
metadata never expands collection consent or authorizes automatic discovery.
Future app retrieval may use periods and series relationships, but current
headings and aliases remain necessary for supported search behavior.

## Generation and safe updates

Use [`prepare-note`](workflow-cli.md#prepare-note-metadata) to prepare complete
proposal bytes before approval. The pure helper accepts supplied original/proposed
Markdown and metadata; it never reads sources, edits prose, selects a destination
or writes a note. A new generated note receives a UUID-based ID, current note
creation/update times and the supplied skill version. Explicit `createSeries: true`
generates a UUID-based series ID only when no existing or supplied series ID is
present; reuse that ID for subsequent members. Existing plain notes remain
plain unless explicitly enriched. Enrichment adds identity and an update time but
does not invent a historical creation date; later guarded updates preserve that
absence. A leading YAML (`---`) or TOML (`+++`) frontmatter document
cannot be enriched by this helper because prepending a comment would change that
format; preserve it and report the conflict.

Prepare the visible prose against the current inspected note, retaining human
corrections. The helper preserves the proposed visible bytes, including a BOM,
line endings and blank lines. Regeneration keeps the existing block position when
its prefix is retained, including blank lines after the closing comment. Generated
metadata uses the existing block's first newline, or the body's first newline for
a new block, defaulting to LF when neither has one. It cannot decide whether those bytes faithfully
retain earlier prose. Supported metadata can be reserialized on a meaningful
change, retaining unknown values but not necessarily YAML comments/formatting.
The shared metadata validator rejects numeric scalars that cannot retain their
exact value as JavaScript numbers. Generation reports `NOTE_METADATA_INVALID`
even for a no-op or body-only request against such a block; preserve the original
bytes and resolve the malformed metadata explicitly. Do not silently round the
value or recast an unfamiliar field to bypass the conflict. Generated creation
and update timestamps use quoted YAML strings as required by the schema. Generated
period dates are also quoted to remain strings in YAML 1.1 consumers.
A no-op returns the exact original bytes without changing timestamps or the
generator version. The optional content hash is calculated without the metadata
block; an existing hash is refreshed on a meaningful generation update. A stale
embedded hash does not authorize replacing a human edit.

Metadata additions can change known descriptive fields but cannot replace the
note ID, the presence or value of a creation time, or established series ID. Source descriptors
are additive: retain prior descriptors exactly; never silently truncate provenance
to fit the 128-source bound. Report capacity or conflicting descriptions for
review. Unknown values, including nested extensions, must survive updates.
Unsupported schemas require retaining the exact opaque block. Malformed blocks
remain conflicts, even when the proposed replacement would remove the error.
The plain-Markdown option applies to new notes and existing plain notes. Guarded
updates do not provide a metadata removal or provenance-correction override;
report the preservation conflict instead of silently discarding metadata.

The shared writer validates these transitions against the exact inspected
existing bytes without modifying the approved proposal. It checks ID collisions
among proposed outputs and retained tracked derived members, not unrelated files.
Processing additionally requires every mapped selected capture in a supported
metadata block and validates each newly added session identity/revision against
those mapped inputs. An optional new session `source_hash` must match that
capture's exact stored bytes. Earlier descriptors can remain without reopening
their sources. Plain and opaque-schema notes retain their compatibility.
These checks validate descriptions, never factual claims or consent.
