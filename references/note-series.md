# Related-note series

Use natural document boundaries for recurring material: for example, one standup
log per agreed sprint, with useful dated sections inside it. Share a stable
`series.id` across members; keep a distinct stable note `id` for each file.
The [metadata contract](note-metadata.md) defines the fields. A series is a
relationship between notes, not a new folder, writer, capture scope or source of
truth. Original selected evidence remains the basis for factual claims.

## Select a member before preparing changes

1. Honor an explicit file destination first. A configured single-file route stays
   restricted to that file. Do not split or redirect it when a sprint changes;
   retain its useful dated sections. One note can span several periods, in which
   case do not claim a single-sprint period that misdescribes its contents. A
   suitable existing continuing note also remains the target unless the user
   chooses per-period files or an established series already uses that boundary.
   For a log intended to continue across sprints, omit `sprint` and `period` when
   preparing new metadata, including on a configured single-file route.
2. Within the authorized scope, inspect the relevant candidate notes and previous
   processing associations using [note placement](workflow.md#note-placement).
   Read candidate metadata and visible content. Do not recursively discover a
   series, follow raw references, or expand collection just to complete it.
3. Reuse the established series ID when the selected evidence and existing notes
   establish membership. A matching label, project name, filename, sprint number
   or modified time alone does not establish identity. For a new series, ask
   `prepare-note` to generate the ID once with `createSeries: true`, optionally
   supplying `metadata.series.label` without an ID. Reuse the returned `series.id`
   for later members; do not hand-invent IDs or request a new series for each member.
4. Reuse the clearly matching member for the intended period, retaining its note
   ID and occurrence dates. A later correction to an earlier sprint belongs in
   that earlier note when it is the selected subject; today's date does not make
   it current-sprint evidence. Read and reconcile the current human-edited content.
5. At a new boundary chosen by the user or already used by the established series,
   prepare a new member with a new note ID and the same series ID. Keep older
   members intact. Honor an explicit destination first; otherwise follow the
   established series directory and naming pattern where the current authorized
   route permits it, including an established custom/deeper folder. Earlier members
   do not authorize a new route or folder: resolve any conflict before saving,
   rather than silently placing the new member elsewhere. Without an established
   location, use the existing flat or by-type route. Do not move or split existing
   notes automatically. A standup log normally has a meeting purpose, but its type
   never overrides an explicit destination. Example names are `standups-sprint-20-26.md` and
   `standups-sprint-20-27.md`, optionally under `meetings/` on a by-type route.

Use an explicit quoted sprint label and evidence-backed inclusive period dates
with a named timezone when known. Do not decode dates from `"20.26"`, use file
modification times as event dates, or add an `is_current` flag. Note creation and
update timestamps describe the document; its period describes the subject.
The helper quotes emitted period dates so other YAML consumers keep them as strings.
Unknown labels/dates stay absent. Keep known period and event dates visible too.
If start, end and timezone are not all established, omit the entire `period`
object and retain the known date context visibly; partial period objects are invalid.

`prepare-note` can add or replace `sprint` and update a complete `period`, but it
cannot remove existing fields. If a continuing log already has period metadata,
keep it only while it accurately describes the whole proposed note. Broaden a
period only with established dates and timezone, and do not retain an obsolete
single-sprint label. If obsolete fields need removal, report them for the user to
correct before preparing from the freshly inspected note. Do not save stale
metadata, invent a combined sprint label or bypass preparation to resolve it.

## Ambiguity and existing notes

Two plausible members for the same period, duplicate note IDs, conflicting series
IDs or overlapping periods require reconciliation before a save. A date match
alone does not choose between them. Differences in timezone may be meaningful;
compare their stated calendar boundaries instead of silently normalizing them.
Do not resolve an occupied destination by inventing another filename.

A selected note without metadata remains usable. Preserve its plain format unless
explicit enrichment is authorized; do not silently backfill an entire history.
When identity or period is missing, use only established visible evidence and
report the gap. Ask for the missing distinction if it determines the destination.
Preserve malformed or opaque future metadata as described in the contract; never
remove a conflicting block to make the checker accept a new series assignment.

## Prepare, review and save

Use [`prepare-note`](workflow-cli.md#prepare-note-metadata) before approval. For a
new member, pass the already reconciled visible document with `original: null`
and the established `series`, supplied `sprint`/`period` and selected `sources`.
Only the first member of a new series uses `createSeries: true` without a supplied
series ID. For later members, omit that flag and pass the inspected established
`metadata.series.id`. Reuse the prepared bytes and generated IDs on save retries.
For an existing member, supply its complete inspected original, preserve its
identity and established period, except for an evidence-backed period correction,
and add only the supported changes. The helper creates new note IDs and explicitly
requested new series IDs, preserves existing identities and retains source descriptors; it does not
choose a member or infer a sprint calendar.

Preserve source references for each member rather than pointing only at the
previous summary. Several selected sessions or supplied documents can support a
single member. A carried-over action remains pending until new evidence establishes
completion; attribute speaker reports and keep limitations visible. Do not copy
old findings into a new period as if they happened again.

Review the complete proposal and source mappings, then use the same collection
writer with exact inspected hashes and normal consent rules. Series membership
does not authorize saving, switching ownership or enabling capture. No-op updates
leave timestamps and bytes unchanged. A historical correction does not rewrite
other members merely to make their update times match.

## Retrieval boundary

The two [fictional sprint examples](../examples/standups-sprint-20-26.md) and
[following sprint](../examples/standups-sprint-20-27.md) show a shared series with
separate evidence and visible dates. Their UUID-based IDs are fixed synthetic
fixtures; never copy them to establish a real note or series. Their H1/H2 headings retain project, period
and subject vocabulary because the recorded app baseline searches headings and
aliases only.

This authoring contract does not implement current-sprint ranking, automatic
series expansion or historical search across files. When answering from explicitly
selected members, distinguish their periods and disclose missing coverage; do not
claim that the selected set is the full history. Future app retrieval can use the
portable relationships without changing these human-sized file boundaries.
