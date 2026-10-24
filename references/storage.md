# Private storage and cleanup

Project settings, chat metadata, queues, complete draft bytes and current-run
recovery records live in a private store outside repositories and note
destinations. Use a supported local filesystem with verifiable ownership and
permissions. Symbolic links, hard links, replaced parents and unsupported storage
are refused. See [setup](setup.md) for locations.

## What is retained

Each chat retains tracking/opt-out state, stable project ownership, native source
identity, verified transcript position and bounded installed-skill identities.
Queued JSONL contains unprocessed normalized conversation parts. Bookkeeping,
sidechains, duplicate snapshots, compaction summaries and verified plugin command
exchanges are excluded. Oversized tool output is clipped with an explicit notice;
ordinary prompts, replies and tool arguments remain intact across ordered parts.

An append becomes processable only after both its complete record and transcript
position are durable. Late output produces supplementary parts. Unknown inherited
history or a changed source anchor stays pending instead of guessing a new boundary.
Native source transcripts are never deleted or rewritten.

A processing run pins selected record identities, inspected note hashes, routing,
saving and logging preferences. Its draft bytes remain private until save. The
latest result contains outcome metadata, paths, counts and warnings; a direct
result also retains its request hash to reject conflicting retries. It contains
no note body and is never write authority.
Current command delivery keeps one replaceable metadata entry per chat, not an
accumulating command or conversation history.

A direct note run selects no queue records and carries no native session identity.
It retains a request hash and the proposed note in the same private draft storage.
Creation pins an absent target; an update pins the exact inspected original hash.
Review saving, conflict checks, logging and recovery use the regular writer.
Completing or discarding a direct note removes its private drafts without changing
chat enrollment or consuming any queued conversation.

## Cleanup

| Situation | Source queue outcome |
| --- | --- |
| Tracked, successful save | Selected parts removed; future collection continues. |
| Untracked, input remains | Remaining JSON stays available. |
| Untracked, fully handled | Conversation JSON and completed private drafts removed. |
| Draft skipped or save failed | Affected input remains; already-saved notes stay. |
| Successful nothing-useful result | Selected parts removed without a note write. |

Explicit opt-out and the verified position remain after queue removal, preventing
re-enrollment and re-importing handled history. Data arriving after selection is
not consumed by that run. Cleanup never deletes Markdown notes.

## Recovery and logs

Process-owned gates release when their worker dies. Retries retain exact inspected
hashes, draft content and durable cleanup progress. Do not infer owner death from
PID reuse or elapsed time, delete gate files, refresh conflict hashes or relocate
locks. Unexpected files and user edits are preserved.

A note save and activity entry are separate writes. Logging failure does not block
successful note cleanup. The current run can retry an interrupted entry with its
original event ID and applied save timestamp. On completion or skip, unconfirmed
entries are reported in the latest result and their retry details are released.
There is no cross-run backlog, automatic backfill or status-triggered repair.
Human edits and removed acknowledged markers are not automatically undone.
