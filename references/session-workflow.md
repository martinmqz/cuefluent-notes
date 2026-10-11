# Session workflow contracts

These contracts describe the session workflow shipped by the current source
builder. It replaces the v0.7.1 capture runtime without importing its policy.
Publication is a separate step; the v0.7.1 tag retains the prior implementation.

## Consent and routing

Collection copies explicitly selected portions of native client sessions into
immutable JSON. Processing turns selected JSON into user-owned Markdown. They
have independent settings: collection starts disabled, processing starts Manual.
Prompted processing requires approval before saving; Automatic processing uses
the user's approved scope. Manual processing and direct saves do not require
ongoing collection. Installation, hook trust, or an old policy enables neither.

The new configuration has `format: "cuefluent-workflow"`, `schemaVersion: 1`,
`collections`, and `routes`. Legacy migration and mixed-version operation are
outside this replacement's scope; obsolete runtime code has been removed. The override is
`CUEFLUENT_WORKFLOW_CONFIG`; otherwise settings use
`<local user profile>\.cuefluent-notes\workflow.json` for fresh Windows setups and
`~/.config/cuefluent-notes/workflow.json` on macOS/Linux.
The [synthetic example](../examples/workflow.json) illustrates the shape with
placeholder POSIX paths and both processes inactive; it is not a setup command.
Windows settings use fully qualified Windows paths instead. `--config` overrides
the environment setting. Windows preserves a sole existing old LocalAppData
default; distinct old and new defaults require explicit selection. See
[Windows storage selection](setup.md#windows-storage-selection) for discovery,
existing package stores and custom profile-path compatibility.

A collection has an `id`, `rawDir`, `intakeStateDir`, and `notes`. Notes specify
either `notesDir` with `organization: "by-type" | "flat"`, or a single Markdown
`destination`. Both require `writerStateDir`. New folder destinations default to
`by-type`; an explicit file remains a file. Intake state and writer state are
different stores. Changing raw placement does not move intake state.

Routes identify `id`, `projectRoot`, `clients` (Codex, Claude, or both), and
`collectionId`. Optional fields are `excluded`, `collection`, and `processing`.
Collection uses `enabled` and `selection`, either `{kind: "project"}` or
`{kind: "sessions", sessionIds: [...]}`. Missing selection means no selected
sessions, never all sessions. Processing uses `mode: "manual" | "prompted" |
"automatic"` and an optional approved `scope`.

Routing uses the longest matching canonical project root. A narrower exclusion
wins; equal matching roots are ambiguous. It reads no transcript or writer
state. Its `intended` result describes policy only. Runtime permissions remain
false; the storage capability below is a separate gate for collection and processing.
Read-only placement preflight keeps private storage and settings outside projects,
notes, and the package. Notes may live inside a project, but not inside the
plugin package. Overlapping note collections must share one writer state;
an explicit file's parent directory defines its writer coordination boundary,
while placement protects only the selected file from private storage/settings.
Sibling private paths do not overlap that file. This preflight is not an
ACL check or proof of machine-local storage.
Selected config files must be ordinary, single-link files, not symlinks. Missing
descendants of an ancestor directory alias can resolve normally. Settings are
bounded to 1 MiB; unsafe/unreadable files report `WORKFLOW_CONFIG_UNAVAILABLE`
and invalid JSON/schema reports `INVALID_WORKFLOW`. macOS placement conservatively
rejects case-only overlapping suffixes even before directories exist.

Fresh Windows raw, intake and writer defaults share
`<local user profile>\.cuefluent-notes\collections\<id>`. An existing selected old
LocalAppData default retains its old private-path suggestions. macOS uses
Application Support; Linux uses XDG state storage. Existing collection paths are
never changed by default resolution, and no fallback store bypasses failed checks.
Raw and intake storage must stay outside finished notes, configured
projects, and the plugin. User source material can contain secrets or private
third-party remarks; the workflow does not promise automatic redaction.

## Native context

The stateless adapter accepts native client/event/session/unit identity and
bounded lifecycle metadata. Source prose, errors' detailed bodies, unknown
fields, and child-agent payloads cannot become control instructions. Missing
unit identity cannot be replaced with a record UUID or a cwd/latest guess.

A context reference is a random token for a helper-owned binding of native
client, session, unit, source path and identity, cwd/project, route/collection,
exact inspected configuration hash, lifecycle epoch, and allowed operations.
Validation requires that exact binding still be the authoritative latest one
and match current policy/selection. A processing-only binding cannot collect.
The caller must establish source identity and lifecycle order before registering
the binding; token creation alone establishes neither consent nor freshness.
Never advance freshness by lexically sorting native IDs, wall-clock time, or
notification arrival. All stored/latest/selection arguments come from trusted
helper state, not transcript content. Hook-based context delivery remains a
client integration gate. The separate [processing-chat entry](processing-chat.md)
binds explicit processing/review calls through native MCP metadata and the
registered source's actual call records; it does not depend on a hook context
token. Other controls without verified native binding require explicit session
selection.

### Generated-output provenance gate

Arbitrary generated-copy exclusions remain disabled in processing and ordinary
inline collection. The runtime cannot bind arbitrary CLI stdout to execution of a
trusted Cuefluent helper. Supported Codex tool records can retain native call IDs,
including outputs without a matching call record. An ID alone proves neither
call ownership nor which program produced the bytes. The Claude reader currently
retains proven human records only; this is a
reader coverage limit, not detection of generated copies. Pasted evidence and
new human corrections remain evidence candidates in both clients.

Excluding an arbitrary generated copy would require verified native
session/unit/call ownership, a trusted helper invocation, an immutable content
hash, and exact output ranges. This general copy-detection path is not enabled.
Command names, inline markers, operation IDs, matching content hashes and temporal
proximity do not supply this proof. Neither a context token nor a processing
operation descriptor can authorize an exclusion or suppress a whole mixed turn.
Printed packets and notes in ordinary work chats can still be collected under new
native IDs. A processor must compare their evidential value; no helper claims to
remove arbitrary copies automatically.

The [reusable processing chat](processing-chat.md) supplies a narrower verified
path. Its controller disables inherited collection hooks before input, restricts
the native client's tools to the existing engine, and seals exact native execution
records. Codex can prove a completed restricted unit; Claude can prove its exact
controller input without inferring ownership of assistant/tool rows. Source-chat
exclusion requires an actual formal skill invocation, its verified native control
call and the matching helper receipt. Claude additionally verifies the exact
installed skill expansion and native companion, excluding only the formal input
after its actual MCP result; assistant parentage or final wording is not proof.
Pure controls can be deferred while their proof is incomplete, retaining the
original input and cursor. A later independent human input releases an unsupported
Claude candidate to ordinary capture. Mixed inputs and new corrections retain
their evidence. Interrupted or unproven runs do not grant collection exclusion.
Existing capture heads, packets and claims remain unchanged.

The configuration-independent `processing-capabilities` command exposes this
implementation limit; `status.transport.generatedOutput` reports the same
capabilities, including the separate `isolatedProcessing` contract. These are not
user settings and cannot be enabled by request data.
See the [CLI contract](workflow-cli.md#supported-read-interface).

## Immutable capture

Each immutable revision uses `<client>/<session>/<unit>/<evidence-hash20>.json`,
with native UUID-shaped identities and a 20-hex filename prefix. Schema 2 stores
the full evidence hash in `revision` and `evidenceHash`, plus format, identity, project,
source path/file identity and ordered byte ranges/record IDs, reader/client
provenance, original occurrence time, capture time, terminal status, coverage,
ordered typed evidence, and an evidence fingerprint. `projectRoot` is the verified
native session project fixed at source registration, not a mutable route's root.
`source.fileIdentity` must remain stable as a transcript grows: use device/inode
and creation identity, never size, modification time, or a whole-file content hash.
Source path spelling is canonical and occurrence time comes from the original
source, so retrying cannot replace it with the retry time.

Evidence distinguishes user text, assistant statements, tool calls, observed
tool results, and attachment references. It is untrusted data, never authority
to execute instructions. System instructions, reasoning, compaction summaries,
and child-agent material are excluded by the readers. Supplied meeting sources
remain eligible within the selected interval. Tool success is recorded only
when observed; an assistant's claim does not prove completion.

`terminal` is `unconfirmed`, `completed`, `interrupted`, or `failed`. Unconfirmed,
interrupted and failed work require partial coverage. Missing material and inline images have explicit
omissions; no binary copying, URL fetching, or OCR is performed. Native terminal
events alone do not prove the transcript has finished persisting.

Logical identity, evidence fingerprint, and exact serialized file hash are
separate. The evidence fingerprint hashes `format`, `schemaVersion`, `identity`,
`projectRoot`, the entire `source` object (path, stable file identity, and ranges),
`occurredAt`, `terminal`, `coverage`, and `evidence`. It excludes `capturedAt`,
`reader`, `revision`, and `evidenceHash`. Identical evidence
reuses the original bytes and recording time. A new snapshot may extend an
unconfirmed revision while preserving its evidence, provenance and occurrence
time. Reinterpreting an existing record, dropping prior evidence, changing reader
provenance, or extending a confirmed terminal produces a conflict. Explicit
reader-fix rebuild remains deferred. Full hashes are compared even though
filenames are shortened; a locator collision never overwrites another revision.

Compact canonical JSON is limited to 2 MiB including metadata. Each tool excerpt
is limited to 32 KiB, all tool excerpts to 256 KiB. Readers must disclose bounded
omissions and truncate on UTF-8 boundaries; the contract rejects oversized data
rather than silently trimming or serializing a partial envelope.
An omission-only capture is permitted when selected input contains no reusable
evidence, for example inline images. It retains native identity, byte provenance,
terminal status, and explicit omissions instead of inventing empty user text.

The Codex reader `codex-rollout/2` applies tighter text allocations within those
unchanged format limits: 64 KiB for call arguments and 192 KiB for results, with
8 KiB of arguments and 16 KiB of result text per native call across its records.
Unused allowance is not loaned between kinds. Source order and distinct record
identities survive; identical text, API documentation and large objects are not
excluded by keywords or presumed usefulness. Only already-supported native
structural records are ignored. The worker cannot identify an important sentence
inside an arbitrary truncated result.

After text allowance runs out, a tool record may retain its native tool/call ID
and outcome with an empty excerpt and a separate `tool-text-omitted` marker for
that exact record ID. These markers are not aggregated, so genuinely empty output
remains distinguishable. At most 32 such descriptors are retained, and only below
2,016 evidence records and while omission capacity remains; otherwise
`tool-descriptor-budget-exhausted` reports their loss. A native failed
outcome is not proof of the underlying task's full result. Descriptors still share
the 2,048-record and 1 MiB serialized evidence limits (with 2 KiB headroom); later
descriptors can also be omitted when that envelope fills. User text uses that
same envelope, independently of the tool-text pools. Neither original transcript
bytes nor omitted content are available through an invented artifact reference.

Omissions distinguish `tool-call-call-limit` / `tool-result-call-limit` (per-call
text), `tool-call-budget-exhausted` / `tool-result-budget-exhausted` (per-kind
text), and `tool-evidence-record-limit` / `tool-evidence-serialized-limit` (overall envelope).
A collector seeded with older retained evidence can also report
`tool-budget-exhausted`: the shared 256 KiB format ceiling still applies even if
older call text exceeds its new per-kind allocation. New v2-only evidence reaches
the per-kind limit first. Successive bounds account for disjoint omitted byte ranges;
aggregated omission counts are affected records/ranges, not missing notes. Native read limits and
unsupported structures remain separately reported by the readers.

This allocation applies to new Codex units; it cannot recover previously
omitted bytes. Existing captures, processing packets and acknowledgements are
not rewritten. During collection, an already-published unit is normalized with its
recorded reader rules, including version 1, so a held cursor can pass its unchanged
evidence again without replacing it. Changed native evidence still conflicts.
The Codex cursor-only checkpoint keeps its independent `codex-rollout/1` label;
its representation has not changed with the text allocation. Reader rebuild
remains deferred. Claude's
human-only reader remains at version 1 because its supported evidence has no
tool text. Budget changes do not move selection boundaries or rewind an advanced
cursor to rebalance allocations.

## Selection and intake primitives

Selection and intake provide explicit source registration, structured controls,
and immutable publication through the [workflow CLI](workflow-cli.md) and
[collection hooks](hooks.md). Existing storage inspection does not establish
privacy; collection requires a verified private-storage capability.

Registration fixes the source identity and current EOF, allowing at most a
bounded 64 KiB source-header check and one byte before EOF. A missing source
returns `pending-source`: this inspection result is not durable registration or
acknowledgement that collection is enabled. Durable ingress retries preserve the
registration boundary; later appearance cannot imply an authorized offset of zero.
Start/resume opens a future-only interval, preserving the excluded current unit
and unresolved native anchor. Readers must skip a split initial record and prove
full native successors. A different UUID or later byte offset is insufficient.
The native-order object is a trusted reader result; no public command accepts it
as user/source JSON. Unsupported native ordering remains unresolved. Start,
resume and pause require a native command-unit identity; missing identity produces
`NATIVE_BOUNDARY_REQUIRED`. Anchor persistence uses a locked, hash-checked update
without changing the user's selection revision. Unresolved anchors are reported
separately from units outside the selected interval.

Pause records the command unit as an exclusive upper native boundary and an
exclusion. Pause EOF is supplementary evidence: earlier eligible work
may persist after it. Controls never search prose for instructions. Repeated
start preserves the active interval; explicit current/historical selection does
not change ongoing collection. Exact last-request retries retain the original
request hash (including its inspected selection hash) and return the current
saved selection without rereading source evidence or deriving a new EOF. Native
anchor resolution may update that selection's hash while preserving the same
scope and floor. Changed requests using the same operation ID conflict; stale
requests after later controls fail. Current policy is checked before replay.
State retains every interval/exclusion
without dropping consent history. Reserved metadata capacity lets opt-outs stop
collection: if an exclusion cannot be appended, a durable capacity safety stop
disables capture until explicit maintenance. A later capture request cannot
silently override an excluded unit or safety stop.

All controls, publication and recovery share one owned intake directory lock.
The store pins its roots and observed managed parents. Each operation rechecks
the roots and its touched ancestor chains; revisiting a previously pinned path
still rejects replacement. Publication and cleanup guard both relevant paths.
Linked/replaced paths, conflicts and unfamiliar lock owners are preserved. No automatic lock stealing
exists. Owner metadata records actual PID/host/time/nonce and nullable process
start/boot evidence from native probes. Explicit lock recovery requires an
externally established offline window; a dead PID alone is insufficient.
The Markdown writer uses a separate lock domain. Authorization receives the
operation, native identity, project, source path, and scope. Explicit pause and
exclude controls validate identity and current state without requiring collection
permission. Unrelated pending publication cannot block another session's controls.

Publication stages and synchronizes exact capture bytes, durably records one
pending intent, publishes with an exclusive hard link, removes only its verified
stage, activates an exact-hash current head, writes a receipt, and advances a
contiguous cursor with its reader checkpoint before clearing intent.
An intentional two-link crash window is recognized only by the descriptor's
exact paths, identities and hashes. Equal evidence reuses original bytes and
capture time. Conflicts never overwrite captures or advance progress. Orphan
stages left before durable intent are preserved for inspection, not guessed at
or automatically removed. Handled write failures remove only their verified
partial stage. Cleanup warnings preserve an original error or successful result.

An intent without an activated head still requires current authorization and
bounded source cursor-anchor checks, even if immutable raw bytes already exist.
Those bytes are an inert orphan until activation succeeds. Once activated,
recovery reconciles exact raw bytes, head, receipt and combined cursor/checkpoint
without needing the source transcript. Reusing an already-active head for new
cursor/carry progress has a separate commit point: source and selection checks
remain required until that combined progress value is written. Its receipt is
written afterward, and a failed uncommitted attempt can be abandoned without
removing the preexisting capture. Changed published
bytes remain a conflict even if their normalized evidence fingerprint matches.
Recovery does not invent a new capture or change its occurrence time. Unpublished
attempts can be abandoned after source failure, withdrawn authorization or an
opt-out. Their descriptors are retained for diagnosis; only exact owned stages
are removed. Activated captures, inert orphan bytes and unfamiliar recovery evidence are preserved.
An unsafe cleanup reports a warning without preventing a disabling control.

Session state is limited to 1 MiB, 1,024 intervals and 4,096 exclusions/scopes;
hydrated reader checkpoints are limited to 8 MiB, 32,768 records and 8,192 native
units. Claude persists a compact root referencing at most sixteen authenticated
512 KiB metadata pages. The reader uses the same page planner and stops before
the first row that cannot fit, preserving a publishable prefix. Cumulative allocation
can reach its independent limit before these live limits.
They contain identity, parent links and byte/hash locators, never source prose.
Capacity exhaustion blocks progress with a diagnostic; no carry is silently
evicted. Receipts are individually addressed, retain exact transition digests, and are
limited to 16 KiB. One pending publication references its independently bounded
2 MiB stage. Each selected scope has independent progress. A completed unit can
publish while its cursor stays at the earliest unfinished unit. Later progress
may account for those exact published bytes without re-publishing or rewinding.
The store verifies contiguous accounting, published-file hashes and exact native
end anchors; the trusted reader must prove that structural/excluded ranges
contain no unfinished eligible evidence. Windows
retains the existing filesystem limitation: file data is synchronized, but Node
cannot provide directory fsync, so sudden power-loss durability is weaker.

## Codex reader contract

Selected-range extraction and preview use the same parser. Compatibility is
checked from native record structure, identity and boundaries, not a client-version
allowlist. The fixtures originate from Codex **0.156.1**, uncompressed JSONL,
`legacy` history without ordinals and `paginated` history with native rollout
ordinals. The same shapes are accepted with other client version strings, including
prereleases. `reader.headerClientVersion` retains the bounded, nonempty version
string from the session header. It does not identify the client that emitted
each later record after an update; readers never scan before the selected floor
to infer that. Existing captures with `reader.clientVersion` have the same
header-only meaning and remain readable without rewriting their bytes.
Malformed version metadata reports `INVALID_SESSION_CLIENT_VERSION`, separately
from configuration errors.
Compressed files, missing native sequence, unsupported record types/content and uncertain
ownership report diagnostics. This is not a claim of live-client validation or
support for every format produced by that client. Missing/replaced sources stay
unresolved; the reader does not search another session or follow history-base
files. Forked/inherited sources are refused. A registered project need not still
exist when its stored canonical spelling matches the source header.

The format was checked against the official `rust-v0.156.1` source:
[wire envelopes](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/history/src/rollout_payload.rs),
[persistence policy](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rollout/src/policy.rs),
[ordered writer](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rollout/src/recorder.rs),
and [task lifecycle](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/tasks/mod.rs).
The [ordinal implementation](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/rollout/src/ordinal.rs)
confirms that legacy history has no ordinal. Its native turn lifecycle serializes
root tasks; overlapping legacy starts are unsupported. Source byte/hash locators
identify its records, never replace native turn IDs. Its
[legacy user-event projection](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/protocol/src/legacy_events.rs)
comes from native user items inside that lifecycle, rather than inferred prompt
text. Untagged records before the first observed start remain excluded.
The producer appends its terminal event after task evidence and flushes the
ordered rollout queue. Consequently a complete persisted native terminal record
is the reader's fence. Hook notifications and quiet EOF are not such fences.
Evidence appearing after that fence in the inspected snapshot is a conflict.

Root session metadata must match both native IDs, source ownership,
history mode and canonical project. A later `session_meta` may change the version
label, but a history-mode change blocks at that record. Native `task_started`
records establish full units. `turn_context` alone does not. Turn IDs on response metadata and completed
items establish ownership, independently of native ordinal/lifecycle succession. Untagged
legacy events require one unambiguous open native unit. A matching command-unit
boundary seen after the authorization floor can resolve a stored anchor; readers
never scan before that floor to find it. A historical read does not backfill an
ongoing interval's anchor from bytes preceding that interval's floor.

Legacy user events and paginated `UserMessage` items supply user evidence.
Model-visible user/developer/system messages are excluded because they may contain
injected instructions. Legacy raw assistant messages and paginated `AgentMessage`
items supply assistant evidence. Their other representations are not copied.
Stable native item IDs deduplicate identical mirrors; distinct IDs retain repeated
text. Native source ranges remain attached to the unit's actual records. Reasoning,
compaction summaries, hook prompts and inter-agent content are excluded structurally.
Native collaboration call IDs and pinned collaboration tool names exclude their
outputs with an omission. Native user text, including IDE context supplied in
that text, stays attributed evidence; prose delimiters do not authorize stripping
arbitrary parts of a user's message.

Tool calls and observed outputs remain separate. Plain serialized outputs have
`outcome: "unknown"`; text claiming success does not change that. Supported
structured command completion can corroborate success or failure. Unsupported
native tools/content are either explicit omissions or format diagnostics, never
fabricated successes. Real attachment references remain references; collection
does not fetch or copy their targets. Inline images and opaque file IDs have
omissions. Interrupted and failed terminals preserve partial coverage.
Legacy patch/MCP completion can corroborate tool outcomes. Declined operations
remain unknown rather than claiming execution failed. Outputs without a usable
call identity have omissions. Tool namespaces are preserved. Mirrored auxiliary
items already represented by the same native call ID do not add false omissions.

Reads stop at a frozen EOF and seek from the authorized floor/current cursor.
Header reads are bounded to 64 KiB; records to 8 MiB; one pass to 64 MiB and
16,384 records. Incomplete lines remain unconsumed, and a split registration record
is discarded through its newline. Invalid UTF-8/JSON, changed source identities,
non-increasing paginated ordinals and oversized lines do not advance past the
affected record. A hard stop returns `blocked` with offset/code and preserves
earlier completed candidates. Per-unit normalization errors remain pending for
that unit; other candidates remain reviewable. Source ownership/identity failures
still invalidate the whole read. Rollback records require explicit review.
Large discarded pre-boundary suffixes are streamed without accumulating a line.

Tool text is clipped on UTF-8 boundaries. Serialized evidence, JSON escaping,
item metadata, bounded combined omissions and compact source ranges all count
toward limits. NUL is replaced with U+FFFD with an explicit omission. Empty
evidence units are reported as `noEvidence` and do not block later progress.
Units exceeding source, anchor, provenance or processing budgets remain explicitly
pending/limited; the reader does not promise to ingest arbitrarily large turns.

An unfinished earlier unit keeps the publication cursor unchanged even if a later
unit is ready. Advancing later requires exact published hashes for other captured
units in the prefix. Adjacent accounting segments are compacted and every held
cursor includes a reason. The reader returns unresolved anchors, incomplete units,
unanchored native IDs and resource limits. Before publication, the worker must
check unanchored IDs against already published units so unexpected late evidence
cannot disappear across a saved cursor. The reader does not authorize production
capture or create storage.

## Claude reader contract

The Claude reader accepts the ordinary root transcript shapes verified against
Claude Code **2.1.280**, including when another client version emits those shapes.
It validates native identity and record structure instead of an exact client version.
Public hook documentation establishes native hook identities, but does
not establish a transcript flush fence. Read-only inspection of Anthropic's
published 2.1.280 package found asynchronous transcript writes, cancellation and
batched prompts. A duration record, assistant `stop_reason`, next human prompt,
Stop hook, or quiet EOF cannot prove finality or causal assistant ownership.
These are format constraints, not a claim that every live client version is verified.

The initial supported evidence is **proven human input only**, including supplied
text and attachment references. Native `promptId` identifies the logical prompt;
record `uuid` identifies a source record. Parent links prove ancestry between
human inputs for future-interval selection. They do not establish which prompt
caused an ordinary assistant response or tool result. Such content remains
unowned: bounded native metadata and exact source locators are retained, and
`unownedRecords` plus `coverage: proven-human-input-only` reports the limitation.
No assistant/tool payload is put into a capture or checkpoint on that basis.
Claude captures therefore remain `terminal: unconfirmed` with partial coverage.
They must not be described downstream as complete dialogue or completed work.

The header may have known native metadata before its first identity row; the
entire header read is still bounded to 64 KiB. The header fixes the registered project, tolerating its stored canonical path
when the project later moves. Later root rows must match session and ownership;
their working directory and client version may change. Version strings must be
bounded and nonempty; `reader.headerClientVersion` explicitly records only the
header's client version, not the emitting version of later rows.
Malformed metadata or unsupported record types block at that row while preserving
the supported prefix. Unsupported history relocation,
rewinds or native ownership produce diagnostics. Compaction summaries, injected
context, sidechain/child records, reasoning and queued attachment records are
excluded. Selected human prose is not filtered by instruction-like words.
Classification uses the documented native types, ownership fields and known
injection flags. Neither reader validates every optional field: a future producer
that changes human/injected-message semantics under a known type needs a reader
update. Version-label fixtures do not establish compatibility with such changes.
Repeated exact record UUIDs are deduplicated; a changed mirror is a conflict.
Claude source ranges retain each full native record hash. Replaying a partially
advanced scope checks that exact record and byte range against the active head,
then skips it rather than copying it twice. Empty follow-ups do not create
provenance-only revisions. Inline attachment omissions preserve MIME and counts.
Inline binary is omitted, while actual URL references remain references.

Incremental reads seek from the saved cursor. The helper reads exact immutable
heads as baselines when a selected prompt has more proven human records. Prior
evidence is retained within the same budgets before new evidence is considered.
Readers neither rescan a historical prefix nor infer ownership from time, byte
order alone, or the most recently seen prompt. A missing baseline or unresolved
native ancestry remains pending. Each interval proves ancestry only around its
own boundaries and candidate. Compaction uses the native `logicalParentUuid`
link; a missing/invalid compaction ancestry link has a distinct diagnostic.
Resolved boundary anchors must be persisted under selection CAS before any
cursor can pass them, including a prefix with no new capture. Very large human records use a bounded tail
anchor for progress while preserving the full record hash for deduplication.

Publication commits a trimmed checkpoint with the exact consumed prefix. An
unpublished selected prompt keeps progress behind it; published accounting checks
both the immutable revision hash and that the active head preserves its evidence.
Unowned records can advance only with their exact locators retained. A separate
locked, authorized progress operation atomically replaces cursor and carry for a
prefix containing no new capture, without manufacturing a note or capture file.
This prevents assistant-only appends from repeatedly scanning the same bytes.

Reusable native UUID metadata remains append-only so mirror detection, ancestry,
first occurrence times and prior-human baselines remain exact. Transport metadata,
progress and excluded sidechain rows have no reusable native identity and are
accounted without permanent byte-key entries. Up to sixteen pages fill greedily
in source order, with each unit stored beside its first record. Sealed prefix pages
remain unchanged across appends; only the tail and any new page require publication.
Pages retain only metadata, never source prose. A deterministic compact root is committed with
the exact cursor; it contains full hashes, byte lengths, counts and source/scope
bindings. Helpers hydrate the pages for existing reader logic and trim the root to
the committed prefix. Fresh batched permission checks precede page use. A bounded
operation-local cache reuses bytes and validated roots only after guarded file-version
and full-hash checks; staging files do not displace reusable final pages. Missing,
changed, linked or untrusted files cannot be supplied from cache.

Changed pages are published as complete immutable directories. A durable allocation
counter reserves each random staging attempt before writing; a crash leaves paid,
inert stages and the next attempt can use fresh stages. Existing exact final pages
are reused. Per scope, cumulative allocations stop at 256 MiB or 4,096 page attempts,
including interrupted stages and obsolete versions. No page garbage collection is
implemented. Selection-scoped [`capture-status`](workflow-cli.md#collection-controls)
reports reserved bytes/page attempts, limits, and headroom on request
(`includeReaderAllocation: true` or a selected `scopeId`) from guarded metadata
reads. Routine status omits these reads. It does not take a lock or write files.
The checkpoint is read before its counter; results may lag collection and do not
reserve space or measure disk usage.
Content-addressed filenames use a 20-hex hash prefix and verify the full
hash and binding. Observed conflicting destinations are refused. Directory rename
cannot replace a nonempty destination; as with metadata CAS, POSIX can replace a
race-created empty directory, so this is not a universal no-replace primitive.

Long scopes can still reach explicit live or allocation limits. The worker reports
the capacity diagnostic rather than evicting identity evidence, resetting the floor,
or silently claiming completion. No automatic carry retirement is implemented.

## Verification scope

See [verification](verification.md) for automated coverage, pinned-client
registration checks and the limits of that evidence. Synthetic reader fixtures
and injected filesystem failures do not establish live conversation capture,
client context delivery or durability under sudden power loss.

## Private storage and explicit pruning

`workflow-storage.mjs` separates explicit preparation of empty managed roots
from read-only verification. Neither changes collection consent. The capability
is process-local, cannot be serialized, and binds the exact workflow configuration,
collection, OS identity and canonical root identities. `assertWorkflowStorage`
rechecks policy, permissions and placement before collection/processing operations.
`openWorkflowIntake` binds it to a native selection and operation. Publication,
selection expansion and reader progress reject an unverified store even if a
caller supplies an affirmative authorization callback. Read-only routing grants
no runtime authority. Pause/exclude controls can use the unverified structural
store view; withdrawing consent does not require a privacy grant.

POSIX directories and files require owner-only 0700/0600 permissions and the
current effective owner. macOS extended ACLs are inspected separately; existing
ACLs are refused. Within one helper/worker operation, up to 512 unchanged ACL
results may be reused only after fresh canonical-path and complete stat-version
checks. Changed paths require a new probe; nested helpers share the scope, which
is discarded when the outer operation ends. Mount locality is checked freshly
on every verification, even when all ACL results are reusable. Only new empty directories have inherited ACLs removed. Linux
permits local ext, XFS, Btrfs and tmpfs filesystem types; unknown/network/FUSE
types fail closed. macOS uses local APFS/HFS mount-device identities, including
APFS firmlinks, and refuses mounts with ownership disabled (`noowners`). Hard
links are refused except publication's stage/target pair
when both aliases are accounted for inside private raw storage.

Windows preparation uses system `icacls.exe`, numeric user/SYSTEM/Administrators
SIDs and argument arrays. A fixed read-only PowerShell command receives paths
through environment data and verifies the entire raw DACL, owner, inheritance,
reparse attributes and local NTFS/ReFS drive type. It needs no script file,
execution-policy override or elevation. Current-user access is required even
for administrators. Existing roots and children are inspected without permission
repair. The probe limits module search to system modules and uses a qualified
ACL command; it assumes a trusted host environment, including `SystemRoot`.
After all roots pass privacy verification, explicit preparation uses system
`attrib.exe` if the raw root is not already hidden, then verifies the attribute
with a fresh native probe. An unsuccessful attribute change is a visibility
warning; permission, identity and policy failures remain fatal. This applies only to the
selected directory and does not rename existing paths or change capture filenames.
The default folder uses `.cuefluent-raw` for macOS/Linux visibility as well;
see [setup](setup.md#save-the-chosen-settings) for custom locations.
The native environment is retained for Windows PowerShell's lazy command
initialization. Windows directory/drive values, executable/module search paths
and the selected path payload are overridden after removing inherited aliases
case-insensitively.
Constrained Language restrictions or paths unsupported by Windows PowerShell
5.1 fail closed. These helpers never change finished-note permissions.

Within one Windows operation, the existing native probe transport samples the
current token's `Win32_UserProfile` policy and registered Local AppData location
once. Later operations take a new sample; ACLs and identities remain freshly
checked. Directory aliases for native profile facts resolve to their directory
targets; actual private roots still reject leaf links. The policy covers private
settings, raw, intake and writer paths, not Markdown destinations. Private profile
paths outside native LocalAppData reject roaming, temporary, mandatory, corrupt or
unverifiable profile policy. Native LocalAppData is treated as non-roaming, while
temporary, mandatory and corrupt profile states remain unsupported there.

Outside native LocalAppData, only newly created empty private profile directories
receive NotContentIndexed
(`attrib +I`, no recursive changes), before settings/evidence bytes are written.
Fresh native checks require the bit on those private directories and files,
including stages and published children. Missing protection on existing data is a
fatal diagnostic, not a repair request. This protection is independent of Hidden
and does not certify third-party indexer or synchronization behavior. The helper
refuses creation below shared writable parents; it does not introduce a ProgramData
fallback, automatic ACL repair or package-store migration.

Known cloud-sync and network locations, including canonical aliases, are refused.
macOS Desktop and Documents are conservatively refused because iCloud can sync
them without changing their paths. Unknown third-party sync cannot be detected
universally. Intake and writer state must remain machine-local. Ordinary
operations verify roots and touched paths; unrelated archive size does not gate
collection. A concurrent child write may change a directory's timestamps, size or
link count; verification makes at most three attempts, re-reading ACLs on each retry while preserving
the original identity, mode and owner. Files, replaced roots, permission changes
and persistent churn fail closed. Policy checks retain their exact configuration
hash and a final fresh placement check. Explicit setup audits existing roots. `auditWorkflowStorage` reports
incompleteness at its 20,000-entry default limit. Setup/probes stay outside
synchronous prompt hooks; production worker probe latency remains unverified.

Publication stores an index for each unit/head pointing to its exact immutable
receipt. Lineage follows these indexes rather than scanning all receipts. The
full hashes remain inside records with shortened hash filenames. Maintenance
currently supports up to 100 revisions per unit; exceeding that bound does not
disable operations on other units.

`previewCapturePrune(capability, { identities, before? })` is read-only. It selects
up to 20 explicit logical identities, optionally constrained by occurrence date.
Each current head must be terminal and have an exact durable processing
disposition (`saved`, `unchanged` or explicitly `skipped`). Publication receipts
do not establish completed processing. The [processing workflow](processing.md)
produces dispositions; captures without them remain ineligible. Current Claude
snapshots are unconfirmed and cannot be pruned.

Pruning removes all recognized revisions of each selected closed unit, including
its earlier unconfirmed snapshots. Preview records exact paths, full hashes,
byte counts, file identities, head, processing disposition and publication lineage,
and warns that future source review becomes unavailable. Unfamiliar files,
inert orphan revisions, incomplete publication, claims, proposals, writer
transactions/journals and live derived-manifest dependencies block it. All
configured writer states must be available and privately verified; unknown
writer state is never interpreted as idle.

`applyCapturePrune` validates the exact preview under the intake lock, then all
configured writer locks in sorted canonical order, through the shared
`withWorkflowWriterLocks` helper. A durable intent and permanent
unit/revision tombstones precede individual, exact-file unlinks. Synced individual
deletions are resumable from the intent and tombstones; there is no recursive
directory deletion. `recoverCapturePrune` requires the exact inspected intent
hash. Changed remaining files or metadata leave recovery unresolved. A pending
prune blocks new publication. An already completed receipt can finalize after
unrelated configuration changes without deleting anything further. For a
conflicting incomplete intent, `abandonCapturePrune` requires its exact reviewed
hash, archives the original intent, and frees the pending slot while preserving
all remaining bytes and permanent tombstones. It never refreshes a deletion
preview. There is no scheduled or automatic retention.

Upstream sessions, finished notes, selections, cursors, reader checkpoints and
original receipts remain unchanged. Head lookup/publication report
`CAPTURE_PRUNED`; they never recreate a pruned identity. Cursor accounting accepts
only exact tombstoned revision hashes and recorded byte ranges. Reimport/rebuild
and reader-metadata garbage collection remain unavailable. Empty unit directories,
lineage indexes and receipts remain and grow with captures. Inert orphan bytes
from withdrawn pre-publication consent, and retained bytes from an abandoned
partial prune, have no supported cleanup command yet. They are not eligible
processing inputs or proof of successful publication. Consent withdrawal does
not itself authorize deleting evidence. Status distinguishes
retained units/revisions/bytes, tombstoned units, pending work and blocked
operations; bounded or unfamiliar inventories are marked incomplete.

Local macOS fixtures exercise modes, extended ACL refusal, capability invalidation,
prune eligibility, stale plans, derived dependencies and recovery fault points.
Windows tests are platform-gated. A dedicated step in the existing Windows CI
job creates a disposable standard-user account outside ordinary `npm test`,
verifies its actual non-admin token and Restricted policy, exercises private
root/child ACLs, and cleans up. Native Windows results must be reported separately;
these fixtures do not establish live client capture or power-loss durability.

## Automatic collection integration

The [processing helpers](processing.md) provide bounded evidence
pages, durable logical-unit claims, exact proposals and coordinated writer
recovery. The [reusable processing controller](processing-chat.md) dispatches
explicit skill requests through restricted native clients, retaining the same
engine and writer. It is separate from lifecycle hooks and does not schedule
processing. Standalone agent use with explicit skill/CLI operations remains
available through [workflow-cli](workflow-cli.md).

Hook packages use `collection-hooks.mjs` and `collection-hook-definition.mjs`.
Unconfigured and entirely disabled routes perform zero filesystem writes.
Synchronous ingress reads bounded settings and native metadata, freezes the
source file identity and EOF using filesystem metadata, and publishes a durable
notification. It never opens transcript bytes, calls a model, writes Markdown,
blocks a prompt, or requests a continuation. Processing-only routes do not launch
collection. Hook input is limited to 1 MiB and persisted metadata to 16 KiB.

A registration preserves its first observed EOF. Native source provenance uses
the verified session cwd, which may be a subdirectory of the configured route. A missing file stays pending;
it never implies byte zero. The worker verifies the native header and the frozen
file identity, seeks to the floor, and waits for a proven native boundary at or
after it. That boundary prompt is excluded; subsequent full units are eligible.
This conservative coverage loss is retained by the selected boundary, returned
as `boundaryExcluded` on later worker visits, and included in matching notices. A Claude human row already before the floor cannot be recovered through
assistant parentage or a backward scan. Startup, resume, compact and clear never
rearm a paused selection. Source replacement/truncation requires explicit review.
Registrations bind the relevant collection grant, not the whole settings file:
processing settings, note destinations, disjoint routes and semantic reordering
preserve collection progress. Fresh whole-configuration authorization still runs
before reads and writes.

The configure helper assigns collection generations. Collection consent, source
routing, raw/state locations, session selectors and overlapping route changes
rotate them when narrowed or rebound, including off/on and remove/re-add round trips.
Adding sessions or clients preserves existing members, and strict ancestor routes
cannot shadow a more specific route. Newly selected members receive their own
grant and fresh registration boundary; existing members do not inherit their history. Hooks cannot renew
an old grant. Explicit start/resume inspects the same native file and freezes a
fresh EOF, then atomically records the new grant and interval with its retry
identity. Retired intervals and progress remain recorded but cannot be read or
published; explicit scopes and exclusions remain intact. An own-session pending publication must
be reconciled or explicitly restricted first. Another session can record its own
start boundary while a foreign intent remains unchanged; publication still waits
for the collection-wide pending intent to be handled. Exact retries under the same grant
reuse the saved boundary; a new grant requires a new operation and inspected hash.
Configuration must be changed through the configure helper: restoring an identical
old file by hand cannot establish an observed revocation history. This replacement
runtime does not migrate registrations created by earlier development builds.
An explicit pause is recorded separately from a selection containing only manual
captures or exclusions. Those selections can still start authorized future
collection. Pausing closes future eligibility while the worker continues to drain
authorized closed intervals; the pause prompt and its successors stay excluded.
For Codex, resolved upper anchors and contiguous terminal-backed progress prove
when the closed interval is drained. Later passes then read no transcript bytes
for that interval, and a matching paused-session hint suppresses redundant hook
wakes. An unfinished earlier unit still waits for its native terminal.

Claude has no verified terminal proof. Pausing freezes automatic inspection at the
saved upper EOF, for both range and header reads. The worker processes complete,
eligible records within that ceiling, then persists a source/interval/cursor-bound
inspection suspension. Matching suspensions are checked before hydrating carry pages.
Reader suspensions and the `ingress/suspended` hook hint are bound to the Claude
reader's rules revision; bump that revision when its compatibility or classification
rules change. Other suspension-cache versions are stale and revalidated.
The `ingress/drained` hint instead represents committed terminal progress and
does not expire with the reader's rules revision.
The worker revalidates stale caches only within the saved ceiling, preserving
selection, capture and checkpoint identities.
Completed explicit windows also stop at their committed end. Transient head/storage
errors remain retryable instead of becoming permanent suspensions. A partial tail or unresolved boundary retains its backlog
and diagnostic; it never reads future bytes to resolve it. This is a suspension,
not a claim that every earlier prompt is complete. A matching paused-session hint
suppresses redundant hook wakes once all scopes are suspended or drained and no
publication intent remains. Later human input for an earlier prompt needs explicit
bounded capture. Resume creates a new interval and does not reopen old ceilings.
Exact reusable UUID carry and existing captures are preserved.

Setup creates a private `ingress/` namespace. Hook staging, registrations, wakes
and worker status remain below its stable parents, so concurrent ingress cannot
change the intake root during another operation's privacy verification. Root
identity and permission checks remain mandatory.

Notifications coalesce at a stable path. Acknowledgements bind the exact inspected
registration, current selection/grant, wake hash and native file identity, size
and nanosecond timestamps. Fresh policy and metadata checks precede every reuse;
unchanged sources need no transcript reads. Appends, same-size edits, new wakes
and selection changes miss the hint. Incomplete tails and budget-limited passes
remain retryable. Acknowledgements never unlink wakes or update frozen floors,
so a newer notification cannot be erased by an older pass.
A failed spawn preserves queued metadata. Each later enabled event, including
SessionStart, can launch a detached worker to catch up registered sessions.
Registrations use 256 hash-prefix folders per client. Complete folder enumeration
is bounded to 2,048 entries per folder, with no 2,048-session lifetime cap.
Saturated or unreadable shard folders produce a diagnostic while other shards
and exact trigger or pending-owner lookups remain usable. The per-client parent
scan is capped at 512 entries; exceeding that bound disables background discovery
for that client while retaining exact lookups and the other client. No registration history is automatically
removed. A separate scheduler cursor reserves one attempt at a time under the
intake lock; it never skips an unattempted batch after budget exhaustion. Each
pass attempts at most 32 items, including invalid or unchanged records. Native
trigger hints alternate priority with background work so a frequently active
session cannot starve others. Hints do not grant capture authority; malformed
scheduler state is retained for inspection. There is no automatic cursor reset:
malformed scheduler metadata requires explicit reviewed maintenance.
An intake lock serializes source operations and publication. Persisted native
anchor updates are reread before publication; unexpected late evidence for a
published or pruned Codex unit blocks progress rather than disappearing into an
excluded prefix. Fully accounted empty/excluded prefixes may advance without
creating a capture.
Malformed registrations and unavailable session directories produce per-session
diagnostics and do not abort the remaining batch. Claude readers load only the
capture heads needed by the selected evidence; Codex anchor resolution is confined
to the requested scope. Before visiting the batch, recovery looks up the pending
publication's exact owner. Unpublished evidence requires that owner's current
collection authority; absent authority preserves the intent for explicit recovery.
Already-committed publication may finish bookkeeping under maintenance authority.
Both paths compare the inspected intent hash under the intake lock.

Each pass shares a cooperative monotonic ten-second deadline and 64 MiB incremental source
read budget across reader passes and privacy probes. Header/boundary reads are
separately bounded. Native command timeouts use the remaining deadline; filesystem
operations are not guaranteed cancellable during an OS stall. On Windows a
short-lived read-only PowerShell probe handles repeated current ACL queries;
permission decisions are never cached. The probe ends with the worker and paths
travel as JSON data. No persistent daemon or automatic lock stealing is used.

The fixed outer Node bootstrap normalizes plugin-controlled parse/import/runtime
failures, rejected operations and child exit codes to exit zero, with a 2.5-second
watchdog and a three-second host timeout. An unavailable Node executable or a
host/OS termination occurs outside that guarantee. Node 22+ must be on the
client's launch PATH. A shell-specific runtime override remains deferred; no
machine-wide PATH change or execution-policy override is performed.

### Client contracts and transport limits

The supported contracts follow [Codex hooks](https://learn.chatgpt.com/docs/hooks)
and [Claude Code hooks](https://code.claude.com/docs/en/hooks),
with pinned producer artifacts. Codex 0.156.1 provides `turn_id`,
Interrupt and `PLUGIN_ROOT`; its documentation describes UserPromptSubmit
additional context and enabled-by-default hooks. Older feature-flag behavior
must not be assumed for every installed version. Claude documents `prompt_id`
from 2.1.196, StopFailure, and direct executable `command` plus `args`.

Codex's [session configuration](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/session/mod.rs)
uses the selected local environment shell with non-login execution arguments.
The [runner](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/hooks/src/engine/command_runner.rs)
falls back to COMSPEC/cmd on Windows and SHELL/sh on POSIX only when no explicit
shell was configured. The replacement Codex command puts fixed JavaScript in the
shell and reads paths from environment data after parsing. Claude uses its
supported direct-exec `node` plus argument array, avoiding its shell-string
executor. The native shell fixture matrix includes sh, cmd, Windows PowerShell,
PowerShell 7 and Git Bash where available; local skips are explicit.

These hook checks do **not** prove live hook-to-agent current-turn context binding
or native prompt rendering. Hooks emit no usable `contextRef` and do not start
automatic processing. Explicit processing-chat entry instead verifies a native
MCP call against selected source records; its restricted client protocol and
review-form transport have separate synthetic acceptance fixtures. Those fixtures
do not prove attended desktop behavior or automatic hook delivery. Explicit CLI
client/session/unit selection remains available. A hook identity is descriptive
metadata, never authority inferred from cwd, notification order or UUID order.

### Blocked intake and explicit recovery

A busy/blocked intake is surfaced by a later SessionStart or UserPromptSubmit
notice and bounded worker diagnostics. Automatic recovery is deferred.
`intake-recovery.mjs` provides read-only inspection and explicit offline apply.
Before apply, the operator must suspend entrypoints, close affected clients,
stop workers/other maintenance, and ensure one recovery process. Confirmation
fields acknowledge this operational prerequisite; PID checks and a cooperative
maintenance marker do not create an exclusive OS window.

Recovery requires the same hostname and a proven-dead owner, exact inspected
root/lock identities and owner bytes. Linux uses boot ID and process start ticks;
macOS uses `sysctl kern.boottime` and `ps lstart`; Windows uses fixed PowerShell
process/start and boot probes. Unknown/denied probes block recovery. A present
PID with different wall-clock timestamps on macOS or Windows is not death proof.
Apply archives the recovery plan and quarantines only the exact intake lock.
It never removes writer locks, claims, captures, cursors or unknown metadata.

## Explicit controls and settings

The [workflow CLI](workflow-cli.md) exposes guarded setup, metadata-only pending
discovery, explicit collection controls, paged processing, direct saves and reviewed
maintenance. New settings are saved disabled/Manual before private preparation;
activation is a separate guarded settings change. No legacy import occurs.

One-time capture has separate explicitCollect authority bound to a single native
session, scope ID and selected units. A selected byte window is read authorization,
not a serialized proof: production readers establish anchors. Both current and
historical selections retain their fixed end boundary. Explicit runs do not sweep
other scopes or enable background collection. Future CLI start/resume can wait for
a null lower native anchor; only the first verified post-floor unit binds it, and
that unit is excluded. This never guesses a current turn or reads before EOF.

Restrictive CLI pause/exclude uses safe structural state without requiring private
capture capability or source text. Unsafe state paths/locks still block changes.
A current source identity and exact old selection hash remain required. Pending
notices preserve a fresh intake-blocked signal in processing-only and paused routes.

Read-only operation and pending status do not acquire locks. Pending discovery
uses bounded heads/dispositions/claim metadata only; preparation still checks raw
bytes and full publication lineage. Direct saves use the same collection writer,
exact proposal/content/note hashes, and no fabricated capture or disposition.
