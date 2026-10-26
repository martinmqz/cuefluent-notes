# Tools, commands and recovery

## Direct note tools

`cuefluent_projects` lists configured projects with their destination and saving
mode. `cuefluent_list_notes(projectId, directory?, cursor?, limit?)` browses one
directory with bounded pagination; it reads no content and grants no overwrite
authority. `cuefluent_read_note(projectId, target, start?, maxBytes?, expectedHash?)`
without `start` and `maxBytes` returns a note within 64 KiB whole, with its
whole-file `hash`, when its serialized projection fits one 128 KiB result.
Otherwise, and for larger notes, it returns UTF-8 ranges of at most 8 KiB: follow
the returned `next` offset and pass the first `hash` as `expectedHash` on every
later range, so a changed file is refused (`DIRECT_NOTE_CONFLICT`) rather than
read inconsistently.

`cuefluent_create_note(projectId, requestId, target, content, summary)` requires an
absent target. `cuefluent_update_note` takes the same fields plus the exact
inspected `expectedHash` and requires the existing target; a changed or missing
original is a conflict, and an original above 64 KiB is refused before a draft is
reserved (`DIRECT_NOTE_UPDATE_LIMIT`). Each request creates or updates one file
from up to 64 KiB of submitted UTF-8 content; the complete private draft with its
retained metadata is limited to 128 KiB. New notes receive identity and
timestamps; updates keep theirs. The writer enforces the configured destination.

`requestId` is a fresh UUID per request. The same id with identical arguments
replays the retained draft or the latest completed outcome after a lost response;
the same id with different content is refused (`DIRECT_NOTE_REQUEST_CHANGED`), so a
revised draft needs the user's Discard and a fresh id. Only the latest completed
result is retained: after an intervening run, a retry can meet a target conflict
and must read the existing note instead of assuming the earlier save failed.
Direct notes share the project's single pending-run slot with queued processing;
a `busy` result names no other run and never authorizes replacing it. A complete
retained direct draft is recovered after interruption without resubmitting
content; incomplete drafting needs the original request.

## Review pages and decisions

A review-mode create or update, and `cuefluent_review_note(projectId, runId,
draft?, start?)`, return a page for a direct note or a queued run, or the latest
completed outcome for that `runId`. `cuefluent_review_note` is read-only and
works from any connection or chat.

A page has `state` (`review`, `interrupted`, `running`, or a completed outcome
state such as `saved` or `skipped`), `projectId`, `runId`, `kind` (`direct`,
`chat` or `project`), `phase`, `revision`, `draftCount`, `savedCount`, `choices`,
`drafts[]`, `next`, `warnings` (at most 16, with `warningsTruncated`). `revision`
is the immutable 64-hexadecimal identity of the reviewed set: run id, pinned
destination and preferences, whether the set is published, and every draft's
target, original hash, content hash and size; a partly done save does not change
it. Each draft entry has `index`, `target` (absolute path), `summary`, `heading`,
`expectedHash` (null for a new note), `hash` (the complete retained draft, not the
preview), `saved`, `totalBytes`, `start`, `end`, `next` and `content`. Pages are
bounded at 48 KiB of serialized JSON: when `next` is not null, call again with
`draft: next.draft` and `start: next.start` until it is null, concatenating the
byte pieces of one draft in order. Show the complete set; never truncate,
summarize or raise limits.

`choices` is the exact wording to offer, through the client's question UI or in
plain text when no question tool is available. A pending review set offers `Save`, then
`Discard` (direct) or `Skip draft; keep input` (queued), then `Keep pending`. A run
whose notes are all saved offers `Finish` and `Keep pending`. A run interrupted
while drafting offers `Discard` or `Skip; keep input`, and `Keep pending`; a direct
run whose retained draft is complete adds `Restore draft` first in review mode, or
`Save` in automatic mode.

`cuefluent_save_note(projectId, runId, revision)` relays `Save`, `Finish` and
`Restore draft`. `Restore draft` only restores the preview and returns a page to
show again. A direct draft saves in the call and returns its path. A queued set
starts the save in the separate worker and returns `running` with `started: true`;
`started: false` means a worker already owned the run and the decision did not
start, so read `status` and review again once the run waits. Repeating the call
with the same `revision` retries an interrupted approved save, including one that
stopped during cleanup; an automatic run finishes the same way without a model.
`cuefluent_skip_note(projectId, runId, revision)` relays `Discard`, which clears a
direct draft and changes no note, or `Skip draft; keep input` and `Skip; keep
input`, which release queued drafts while the selected input stays queued and
saved notes stay, so the next `process` may propose the same notes again. When
every save is durable and only cleanup remains, either tool finishes that cleanup,
which consumes the handled input. `Keep pending` makes no call; silence,
cancellation or an unanswered question also leave the draft pending.

Both tools relay the user's decision only. `REVIEW_REVISION_STALE`: the set changed
after review; review, show and ask again, never reusing an earlier answer.
`REVIEW_RUN_CHANGED`: the run is neither pending nor the latest outcome; read
`status`. `REVIEW_ARGUMENT`: an invalid page position or decision argument;
nothing changed.

## Native commands

Direct native commands are `/cuefluent-notes:cuefluent-notes <action>` in Claude
Code and the selected `$cuefluent-notes` skill with exactly `<action>` in Codex.
Mentioning a command in prose executes nothing. In Claude Code the command hook
runs the action; its context carries either `Cuefluent Notes result: ...` or
`Cuefluent Notes invocation: <handle>`, which `cuefluent_invocation` reads
(polling never starts work, and a later command replaces the chat's handle). In
Codex `cuefluent_control({ action })` binds the native current turn and selected
skill itself; model-supplied chat ids and paths are rejected. If delivery stops
before an outcome is recorded, read `status` and issue a new typed command.

`track` follows this chat and collects the completed exchanges already present;
repeating it catches up from the retained position, and tracking after an untracked
interval includes that interval. `untrack` stops collection immediately, attempts
one final catch-up (which can stay pending when the source is unavailable), keeps
already-queued input, and records an opt-out that survives cleanup and automatic
mode. Hooks record bounded metadata and schedule a plain Node synchronizer that
never calls a model or writes notes; a stopped host preserves pending state, and
no OS service is installed. Native transcripts are never changed.

`process` selects this chat's queued input; `process project` includes every
queue the project owns, including untracked chats, after catching up each tracked
chat. One unavailable source is a warning while other input stays eligible. Each
run freezes a context-sized selection; later arrivals and input beyond the budget
wait for another command, and oversized exchanges progress in ordered parts
without truncating prompts, replies or tool arguments. Review mode prepares
private drafts shown through `cuefluent_review_note`; automatic saving writes
after the explicit command. A nothing-useful result consumes its selected input
without a note; failed drafting or saving preserves affected input. One run or
review set is pending per project, a second command reports it, and `accepted`
or `running` is not completion. After an interruption, the command that started
the run resumes its drafting or automatic saving: `process project` for a project
run, `process` from the same chat for a chat run; another chat's `process` only
reports the pending run. Typed `save` resumes an interrupted approved save (phase
`saving`); typed `skip` releases inactive failed or conflicted work, keeping
selected input and saved notes. While a review set is pending both return the
pending review status so the drafts can be shown and the question asked. Once
every note is saved, typed `skip` finishes the remaining cleanup in either
saving mode and consumes the handled input; typed `save` does so in review mode,
while in automatic mode it only reports the run, which `process` or the `Finish`
decision completes. A save refused because a note changed after review leaves a
conflict warning on the run; `Discard` or `Skip draft; keep input` releases it
for a fresh draft, and `Save` succeeds again only once the note is back to its
reviewed original.

A file changed after it was read is a conflict. A new target that was never read
is expected to be absent. Preserve user edits, changed parents and unexpected
files; never refresh hashes, choose another lock directory, delete state or force
replacement. Inspect `status`, decide whether to resume or skip, and let a new run
read the current notes afresh.

## Status

`status` (typed, `cuefluent_status(projectId)` or the CLI) is read-only. `state` is
`running` while a worker holds the project, `review` while a draft set awaits a
decision, and `idle` otherwise. `idle` does not mean no pending work: a run that
stopped between phases stays in `run` with `active: false`, `phase`, `kind`,
`selected` and `saved` counts, `drafts`, `savedPaths`, `warnings` and a
`recovery` sentence naming the action that continues or releases it (repeat
`process`, relay `Save` or `Finish`, relay `Discard` or `Skip; keep input`, or
retry a direct request with its `requestId`). `latest` is the most recent
completed result; `settings` and `counts` describe the project. `pendingSources`
means source synchronization is unresolved, not that conversation was queued.
Counts are bounded snapshots and an incomplete or unknown count is not zero. The
`revision` a decision cites comes only from review pages. Status repairs no logs,
retries no synchronization and starts no model.

## Error reports

A failed tool call returns its stable `error` code, a plain-language `message`, a
`recovery` step and bounded `diagnostics` (runtime version, platform, architecture,
stage, client and package version when known, and the codes of nested causes) in
both the text result and `structuredContent`. Guidance comes from one short table
of user-facing codes; any other code receives the generic entry rather than its
exception message, stack, path, arguments or environment values. A retained
invocation with `state: failed` receives the same guidance when read. Fatal
framing or queue limits close the connector; reconnect and read `status` before
retrying a mutation.

Status and processing results may include `warningDetails` (at most 16, within the
response bound): fixed explanations for code-only warnings with the `scope` they
belong to. `status` and `run` warnings describe current work and carry its
recovery; `latest` and `result` warnings belong to a completed run and say that no
retry is needed. Details never turn a successful read into an error, and the
original warnings stay intact when details are omitted for space. Explain the
failure and next step, keep the code for support, and do not treat an error as
proof that no earlier write succeeded: inspect `status` before retrying a
mutation. Connector startup failures are covered in
[limits](limits.md#startup).
