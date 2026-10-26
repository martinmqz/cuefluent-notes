# Commands and recovery

## Error reports

A failed MCP tool call retains its stable `error` code and includes a plain-language
`message`, a `recovery` step, and bounded `diagnostics` in both the text result and
`structuredContent`. Diagnostics identify the runtime version, platform,
architecture, stage, and client/package version when known. Nested causes expose
only bounded error codes. Unknown errors receive generic guidance rather than
their raw exception messages, stacks, paths, arguments, or environment values.
Recovery uses the actual operation: a note lookup failure calls for inspecting
the selected destination and note, while a missing startup module calls for
checking the installed package. Fatal framing or queue limits close the connector;
reconnect and inspect retained work before retrying a mutation.

A retained invocation with `state: failed` receives the same derived guidance and
MCP error flag when read. Stored outcomes remain unchanged. Status and processing
results may include `warningDetails`, with fixed explanations for code-only
warnings and a scope of `status`, `run`, `latest` or `result`. These details identify
where the warning belongs; they do not turn a successful status read into an error.
Warnings belonging to completed outcomes are marked `historical` and do not advise
retrying finished work. A newer pending run keeps its own recovery guidance.
At most 16 details are returned, within the response size bound. Additional details
can be omitted when space is exhausted; the original warnings remain intact.

Explain the failure and next step to the user; include the code for support.
Runtime details are available when investigating a problem. An error is not proof
that no earlier write succeeded: inspect retained status before retrying mutations,
and do not describe a previous run's result as a new status-command failure.
Keep notes, pending drafts, and queued inputs intact during diagnosis. Connector
startup failures are covered in [package requirements](distribution.md#startup-troubleshooting).

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
edits. The direct tool requires complete read coverage in the same Codex chat or
Claude connection for the exact original hash. Codex must supply the chat context
through its MCP transport; missing context refuses an update without changing the
original. Originals exceeding 64 KiB are refused
before reserving a draft. Do not shorten a note to fit the submission limit.

`cuefluent_create_note` takes `projectId`, a fresh UUID `requestId`, `target`,
`content` and `summary`; the target must be absent. `cuefluent_update_note` takes
the same fields plus the exact inspected `expectedHash`, and requires an existing
target. Submit the complete reconciled Markdown for an update. The writer retains
the original metadata; it does not accept invented provenance or identity changes.

Review mode returns `state: review` with a content-only preview of the draft and
its intended target; nothing is saved yet. The assistant shows the complete
preview, asks the user in chat and relays only the answer. By default it writes
each returned `content` unchanged to a uniquely named temporary `.md` file in a
private system temporary directory outside the repository and notes destination,
opens it with the client's file viewer or preview tool, and gives a clickable
local file link. A client with no file viewer renders the note inline in the
reply as ordinary Markdown, not as a fenced block showing its source. Either way
the destination path is named separately. The content is ordinary Markdown
without Cuefluent metadata, search-alias comments, a branded wrapper or
processing details. Its H1 title, useful H2 sections and body already use the
final note structure. Saving keeps that content and structure and includes the
retained metadata without another rewrite or reformatting pass. The preview is a
presentation copy and is never used as the publication stage. An edit made
silently in the file is neither detected nor submitted; a request for changes,
or an edit the user reports, needs a new draft and fresh approval. Afterwards
the assistant may remove an unchanged temporary preview it created; user edits
are never deleted. Automatic saving returns the saved path from the
create/update call. Both modes return actual outcomes rather than starting a
second model and asking for status commands.

A review-mode create or update result and
`cuefluent_review_note(projectId, runId, draft?, start?)` return a review page.
`cuefluent_review_note` is read-only. It returns the content-only preview of the
pending draft set, for a direct note or a queued processing run, or the latest
completed outcome for that `runId`. A page has `state` (`review`, `interrupted`,
`running`, or the completed outcome state such as `saved` or `skipped`),
`projectId`, `runId`, `kind` (`direct`, `chat` or `project`), `phase`,
`revision`, `draftCount`, `savedCount`, `choices`, `drafts[]`, `next`,
`warnings` (at most 16; `warningsTruncated` says when `status` holds more) and
`warningsTruncated`. `revision` is 64 hexadecimal characters: the immutable identity of
the reviewed set, covering the run id, the pinned destination and preferences,
whether the draft set is published, and every draft's target, original hash,
content hash and size. A partly done save does not change it, so an unchanged
set stays retryable. `choices` is the exact wording to offer and depends on the
run's phase: a pending review set offers `Save`, then `Discard` for a direct
draft or `Skip draft; keep input` for queued drafts, then `Keep pending`; a run
whose notes are all saved and only needs cleanup offers `Finish` and `Keep
pending`; a run interrupted while drafting offers `Discard` or `Skip; keep input`,
and `Keep pending`, and a direct run whose retained draft is complete also offers
`Restore draft` first. `Save`, `Finish` and `Restore draft` relay to
`cuefluent_save_note` (`Restore draft` only restores the preview, for a fresh
decision); `Discard`, `Skip draft; keep input` and `Skip; keep input` relay to
`cuefluent_skip_note`; `Keep pending` makes no call. Each
`drafts[]` entry has `index`, `target` (the absolute destination path),
`summary`, `heading`, `expectedHash` (null for a new note), `hash`, `saved`
(whether this note is already written), `totalBytes`, `start`, `end`, `next` and
`content`. The `hash` identifies the
complete retained private draft, including its metadata; it is not the hash of
the preview text or of any preview file.

Pages are bounded. When the page's `next` is not null, call
`cuefluent_review_note` again with `draft: next.draft` and `start: next.start`
until it is null. A draft too large for one page arrives in byte pieces, with
`start` and `end` as offsets into its preview; concatenate the pieces in order.
Show the complete set. Never truncate or summarize a draft, or raise transport
limits, to fit a page. A new connection or a different chat can review a
retained draft.

The assistant asks with the client's question UI (Claude Code: AskUserQuestion;
Codex: its question tool when available; otherwise plain text), using exactly
the returned `choices`, and relays only the user's answer.
`cuefluent_save_note(projectId, runId, revision)` relays Save or Finish. A direct
draft saves in that call and returns the saved path. A queued set starts the
deterministic save in the separate worker and returns `running` with
`started: true`; `status` shows progress and then the latest result. `running`
with `started: false` means a worker already owned the run, so the decision did
not start: read `status`, and review and ask again once the run is waiting.
Calling the tool again with the same `revision` retries an interrupted approved
save, including one that stopped during cleanup; for an automatic run it finishes
the interrupted save or cleanup the same way, without a model.
`cuefluent_skip_note(projectId, runId, revision)` relays the decision not to
save: Discard for a direct draft, `Skip draft; keep input` for queued drafts, as
described under [skip and conflicts](#skip-and-conflicts). `Keep pending` makes
no call; the draft stays retained, and silence, cancellation or an unanswered
question also leave it pending. Neither tool is a way around review mode; call
them only with the user's decision.

`REVIEW_REVISION_STALE` means the draft set changed after it was reviewed:
review again, show the current draft and ask again; never reuse an earlier
answer. `REVIEW_RUN_CHANGED` means the identified run is neither pending nor
the latest outcome; read `status` before acting. `REVIEW_ARGUMENT` means a page
position or decision argument was invalid; nothing changed.

Keep the returned `projectId`, `runId` and `revision` for review, save or skip.
Reuse the original requestId and exact payload to retry an interrupted
submission. A changed draft needs an explicit discard of the old draft and a
fresh requestId. Reuse of an ID cannot replace its pending content or silently
return a previous outcome for different content. Only the latest completed
result is retained; if a later result replaces it, the original target
expectation still prevents an uninspected overwrite.

Save retries keep the retained draft bytes and original target expectation:
absent for creation, or the inspected hash for an update. A conflicting file is
preserved. Re-read and reconcile the current note before proposing a new change;
never substitute a fresh hash into the old draft to force a save. A revised
draft needs fresh review under the saving preference. Direct notes share the
project's single pending-run slot with queued processing. A busy result does not
disclose another run's identity and never authorizes replacing that pending
work. A complete durable direct draft can be recovered after interruption
without resubmitting content or calling a model; incomplete drafting still needs
the original request.

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
section headings. They are shown through `cuefluent_review_note` with their
`revision`, and the user's Save decision, relayed with `cuefluent_save_note` and
that `revision`, authorizes their publication. While the set is pending, a typed
`save` or `skip` does not act: it returns the pending review status so the
drafts can be shown and the question asked. Auto saving performs the same writes
after an explicit process command. A successful nothing-useful result consumes
its selected input without a note write. Failed drafting or saving preserves
affected input.

Only one run or review set is pending per project. A second command reports that
work. `accepted` and `running` are not completion. Repeating `process` after an
interruption resumes existing drafting or auto-saving; a typed `save` resumes an
interrupted approved review save (phase `saving`). Complete durable drafts are
reused without another model request.

## Skip and conflicts

Typed `skip` releases inactive failed or conflicted work that has no pending
review set. While a review set is pending it does not act: it returns the
pending review status, the assistant shows the drafts with
`cuefluent_review_note` and asks, and a decision not to save is relayed with
`cuefluent_skip_note` and the reviewed `revision`. The meaning of that tool
depends on the run's `kind`. For a direct draft (`kind: direct`) it is Discard:
it releases only the identified direct run, the unused private draft is cleared,
no note changes and every queue is preserved. For queued drafts (`kind: chat` or
`project`) it is `Skip draft; keep input`: the drafts are released and the next
`process` may propose the same notes again. Skip preserves all selected input
and any notes already saved. The result lists those notes; reprocessing may
produce redundant prose. Skip cannot race a live writer. When every save is
already durable and only cleanup remains, the review page offers `Finish`
instead, and either tool finishes that cleanup, which consumes the handled input.

A file changed after the agent read it is a conflict. A newly chosen target that
was never read is expected to be absent. Preserve user edits, changed parents and
unexpected files. Do not refresh hashes, choose another lock directory, delete
state or force replacement. Inspect `status`, decide whether to resume or skip,
and let a new processing run read the current notes afresh.

## Status and delivery

`status` is read-only. It reports settings, tracking and queue counts, pending
drafts, active/interrupted work and the latest completed result. A pending run
includes its `kind` (`direct`, `chat` or `project`); the `revision` a decision
cites comes only from the review pages that showed the drafts. Counts are
bounded snapshots;
an incomplete or unknown count is not zero. It does not repair logs, retry
synchronization or start a model.

Claude's opaque invocation handle lets the skill read the result of that exact
command; polling never starts work. A later native command replaces that chat's
current handle. Codex controls verify the selected skill and exact current native
turn; model-supplied chat IDs and paths are not accepted. If command delivery stops
before recording its outcome, inspect status and issue a new typed command to
resume pending work. Do not infer failure solely from a slow model.
