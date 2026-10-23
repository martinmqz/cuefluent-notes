# Commands and recovery

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
