---
applyTo: "src/**,test/**,SKILL.md,references/**"
---

<!-- agent-guidance-sync:generated:v1 source=".agents/rules/runtime.md" target=".github/instructions/agent-guidance/runtime.instructions.md" -->

# Runtime and storage

Apply the shared boundaries in [repository guidance](/AGENTS.md).

## Responsibilities

- `src/core/` holds pure settings, ownership, run transitions, and validation.
  Validate complete loaded state and freeze independent snapshots. Settings cannot
  silently reassign a chat or alter a pending run's expectations.
- `src/storage/` owns private paths, bounded reads, atomic publication, gates,
  queues, and attempts. Keep it independent of client transcript shapes and models.
  Metadata contains no conversation; only queue files hold selected conversation.
- Client adapters resolve native identity and normalize main-conversation rows.
  Recognize commands from invocation evidence, not ordinary prose. Resume, fork,
  and compaction handling must preserve source identity.
- Synchronization appends durable complete records before advancing its source
  checkpoint. Processing cannot consume records until that checkpoint is durable.
  Exact retained records may deduplicate an interrupted append; conflicting data
  or a malformed complete line is an error. Repair a torn tail only from verified
  uncommitted source, preserving ordinary conversation bytes.
- Processing freezes selected record identities/hashes and context-sized ranges,
  not a whole live queue hash. New appends survive cleanup. Completed drafts are
  reused on retry; durable saved outcomes authorize cleanup without redrafting.
  Skip preserves selected input and already-written notes unless saving is
  durably complete and only cleanup remains.

## Ownership and filesystem rules

Private stores live on a supported local filesystem outside repositories and note
destinations. Validate links, hard links, ownership, parent identities, and Windows
ACLs; refuse unverifiable locations. Read/status operations never create a store,
gate, transcript registration, or model session.

SQLite gate files are persistent rendezvous paths, not product data. Never unlink,
replace, hash, or open them through generic file helpers while owned. Closing any
other descriptor for the same inode in a process can release POSIX locks. Use only
the gate module and its process-wide registry. Worker threads must not acquire
gates. Missing/corrupt/replaced gates are errors, never stale owners.

Acquire short gates in settings → project → notes-writer order. Hold the separate
worker gate in the actual worker process for its entire attempt. Establish that
ownership before publishing an active attempt. Every draft/save/cleanup publication
rechecks the current run and attempt under the same short mutation gates. Parent
death before activation releases the unstarted worker; a detached active worker
may finish and publish a truthful result after its original call ends.

Keep one latest result containing status, paths, counts, and warnings. It never
authorizes writes and contains no conversation or input receipt history. Runtime
failures preserve queue data, pending state, and manual note edits.

## Verification

Use synthetic process and filesystem fixtures under `test/`. Exercise observable
interleavings and crash boundaries. Do not use inherited user hooks or Git
configuration in fixtures. Report unverified platform and native-client cases.
