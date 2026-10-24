# Commands and recovery

## Direct notes from supplied content

Ask naturally, for example: “Use Cuefluent to save the meeting details above as
a note.” The assistant composes the requested note from user-authorized context,
supplied material, or task results and submits the complete Markdown body as
`content` to `cuefluent_create_note` or `cuefluent_update_note`. Cuefluent validates
and saves this body; the tool does not generate a note from a raw context prompt.
No tracking, transcript read, queue processing, or separate model session is
required. The complete proposed note is retained in private drafts; no session
provenance is inferred.

Choose a configured project from `cuefluent_projects`. Each direct request creates
or updates one Markdown file with up to 64 KiB of submitted UTF-8 content. The writer
validates the note and enforces its configured destination. New notes receive
Cuefluent identity and timestamps; updates retain existing identity and metadata.
The complete draft, including retained metadata, is limited to 128 KiB.
Explicit file destinations are honored. Zero queued inputs is valid for either
operation. Neither operation enrolls a chat or selects queued conversation.

Before creating a note, check for a suitable existing subject note with
`cuefluent_list_notes(projectId, directory?, cursor?, limit?)`. Browse only relevant
directories; listing does not grant overwrite authority. Read a selected existing
note with `cuefluent_read_note(projectId, target, start?, maxBytes?, expectedHash?)`.
Reads start at byte zero by default and return at most 8 KiB per chunk with the
whole-file hash. Follow the returned next offset; `expectedHash` is required for
every read starting after byte zero. Reuse the first hash, so a changed file cannot
be mistaken for one consistent read. Read the complete original before
submitting its replacement; preserve useful content, metadata, aliases and manual
edits. Do not shorten a note merely to fit the submission limit.

`cuefluent_create_note` takes `projectId`, a fresh UUID `requestId`, `target`,
`content` and `summary`; the target must be absent. `cuefluent_update_note` takes
the same fields plus the exact inspected `expectedHash`, and requires an existing
target. Submit the complete reconciled Markdown for an update. The writer retains
the original metadata; it does not accept invented provenance or identity changes.

Review mode returns a content-only preview and the intended target. The assistant
writes the returned `content` unchanged into a uniquely named temporary `.md` file
outside the repository and notes destination, opens it for review, and links it
for approval. It contains ordinary Markdown without Cuefluent metadata,
search-alias comments, a branded wrapper or processing details. Its H1 title,
useful H2 sections and body already use the final note structure. Approval keeps
that content and structure; saving includes the retained metadata without
another rewrite or reformatting pass. The returned
`hash` identifies the complete retained private draft, including its metadata;
it is not the preview file's hash. `cuefluent_save_note` publishes that exact run
after approval. The preview is never used as the publication stage. Edits to the
preview require a revised draft and fresh approval. Remove an unchanged temporary
preview after save or discard; preserve user edits. Automatic saving returns the
saved path from the create/update call. Both return actual
outcomes rather than starting a second model and asking for status commands.

Keep the returned projectId/runId for review, save or skip. Reuse the original
requestId and exact payload to retry an interrupted submission. A changed draft
needs an explicit discard of the old draft and a fresh requestId. Reuse of an ID cannot
replace its pending content. Only the latest completed result is retained; if a
later result replaces it, the original target expectation still prevents an
uninspected overwrite.

`cuefluent_review_note` is read-only. Save retries keep the retained draft bytes
and original target expectation: absent for creation, or the inspected hash for
an update. A conflicting file is preserved. Re-read and reconcile the current note
before proposing a new change; never substitute a fresh hash into the old draft
to force a save. A revised draft needs fresh review under the saving preference.
`cuefluent_skip_note` releases only the identified direct run, preserving notes
and all queues. Direct notes share the project's single pending-run slot with
queued processing. A busy result never authorizes replacing that pending work.

## Native tracking and processing commands

Use direct native commands: `/cuefluent-notes:cuefluent-notes <action>` in Claude
Code, or select `$cuefluent-notes` with exactly `<action>` in Codex. Mentioning a
command in ordinary conversation does not execute it.

## Tracking

`track` follows this chat and collects completed exchanges already present. Later
repeated tracking catches up from the retained position. Tracking after an
untracked interval includes that interval; untrack is a pause in collection.

`untrack` revokes collection immediately and attempts a final catch-up through
completed conversation before the command. A delayed or unavailable source can
leave this catch-up pending. Already-queued input stays available, and the explicit
opt-out survives queue removal. Original client transcripts are untouched.

Hooks record bounded metadata and schedule a plain Node synchronizer. They never
call a model or write notes. The synchronizer also retries pending work and checks
for late output while eligible chats remain. A stopped host preserves pending
state; a supported hook or explicit command can restart synchronization. No OS
service is installed.

## Processing and review

`process` selects this chat's queued input. `process project` includes all queues
owned by this project, including untracked chats, and first catches up every
tracked chat. One unavailable source produces a warning while other queued input
remains eligible. Nested projects retain their own queues.

Each run freezes a context-sized selection. Later arrivals and input beyond its
budget wait for another command. Oversized exchanges progress in ordered parts;
ordinary prompts, replies and tool arguments are not truncated to fit one run.

Review mode prepares private drafts with target paths, summaries and optional
section headings. `save` authorizes their publication. Auto saving performs the
same writes after an explicit process command. A successful nothing-useful result
consumes its selected input without a note write. Failed drafting or saving
preserves affected input.

Only one run or review set is pending per project. A second command reports that
work. `accepted` and `running` are not completion. Repeating `process` after an
interruption resumes existing drafting or auto-saving; `save` resumes a review
save. Complete durable drafts are reused without another model request.

## Skip and conflicts

`skip` releases inactive failed, conflicted or review work. It preserves all
selected input and any notes already saved. The result lists those notes;
reprocessing may produce redundant prose. Skip cannot race a live writer.
If every save is already durable and only cleanup remains, skip finishes cleanup
instead of replaying the handled input.

A file changed after the agent read it is a conflict. A newly chosen target that
was never read is expected to be absent. Preserve user edits, changed parents and
unexpected files. Do not refresh hashes, choose another lock directory, delete
state or force replacement. Inspect `status`, decide whether to resume or skip,
and let a new processing run read the current notes afresh.

## Status and delivery

`status` is read-only. It reports settings, tracking and queue counts, pending
drafts, active/interrupted work and the latest completed result. Counts are bounded
snapshots; an incomplete or unknown count is not zero. It does not repair logs,
retry synchronization or start a model.

Claude's opaque invocation handle lets the skill read the result of that exact
command; polling never starts work. A later native command replaces that chat's
current handle. Codex controls verify the selected skill and exact current native
turn; model-supplied chat IDs and paths are not accepted. If command delivery stops
before recording its outcome, inspect status and issue a new typed command to
resume pending work. Do not infer failure solely from a slow model.
