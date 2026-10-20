# Workflow commands

Run the bundled helper with Node.js 22+ from the skill directory (`skills/cuefluent-notes` inside a plugin):

```sh
node scripts/workflow.mjs --help
node scripts/workflow.mjs status
node scripts/workflow.mjs <command> --config /absolute/workflow.json --request /absolute/request.json
```

On Windows use fully qualified native paths; invoke Node directly with separate
arguments. Requests are ordinary UTF-8 JSON files, at most 2 MiB, except
`prepare-note` allows 25 MiB for two Markdown fields and JSON escaping. Put private request
files outside the repository/plugin. Helpers never evaluate text or accept serialized
reader proofs, lock capabilities or callbacks. Errors return bounded codes without
echoing source text. Hook launchers separately normalize plugin errors to exit zero.

`--config` is optional: the configured environment override or platform default is
used. Duplicate/unknown flags, relative command-line paths and unknown request keys
are rejected. `status`, `defaults` and `processing-capabilities` can omit a request;
other commands require one.
Every collection command below uses this envelope:

```json
{
  "collectionId": "selected-collection",
  "expectedConfigHash": "<exact SHA-256 returned by status>",
  "args": { "<command fields>": "<values>" }
}
```

The helper verifies private storage and obtains its own process-local authority.
Changing settings invalidates old hashes. Never refresh a stale hash under an old
approval. The `selection` object is `{client, sessionId, cwd, unitId}`: `client` is
`codex` or `claude`, `cwd` is the canonical native project directory, and `unitId`
can be null for a session-level operation. Session/turn/prompt IDs are native UUIDs.
A record UUID is not a Claude prompt ID. No current-turn contextRef is emitted.

## Settings and inspection

These commands use their own request shape, without the collection envelope:

| Command | Request |
| --- | --- |
| `status` | `{selection?, diagnostics?}`; reads settings and bounded package diagnostics, optionally resolves a route; no writes |
| `defaults` | `{collectionId?}`; returns platform paths; no creation or activation |
| `configure` | `{expectedHash, proposal}`; exact old hash or null plus the complete new configuration |
| `storage-prepare` | `{collectionId, expectedConfigHash}`; explicitly prepares/validates private storage without enabling either process |
| `fingerprint` | `{paths: [absolute paths]}`; hashes 1–100 selected files; null means missing |
| `inspect-notes` | `{root, paths: [relative Markdown paths], existing?}`; returns canonical root and parents; `existing: true` inspects custom/deeper existing parents; no creation |
| `writer-status` | `{stateDir}`; explicit inspection of shared writer recovery state |
| `writer-recover` | `{stateDir, expectedJournalHash}`; exact inspected direct-save journal; processing transactions require their own recovery command |

Fresh setup saves disabled/Manual settings, prepares private roots, then activates
only the separately authorized choices. Read [setup](setup.md) before configuring.

## Collection controls

Use a collection envelope for these commands. `operationId` is a fresh helper/control
request UUID; it does not substitute for native source identity.

| Command | `args` |
| --- | --- |
| `capture-status` | `{selection, sourcePath?, scopeId?, includeReaderAllocation?}`; returns selection/hash, optional source metadata/EOF, and requested reader allocation headroom without reading transcript bodies |
| `capture-control` | `{selection, sourcePath, expectedSourceIdentity, expectedSelectionHash, operationId, operation}` with start/resume/pause/exclude |
| `capture-preview` | `{selection, sourcePath, expectedSourceIdentity, expectedSelectionHash, operationId, kind, unitIds, readRange}` |
| `capture-select` | Same as preview; durably selects one bounded scope without enabling collection |
| `capture-run` | `{selection, scopeId, expectedSelectionHash, unitIds?}`; runs exactly one inspected scope |

Use `capture-status` to obtain source file identity and the existing selection hash
(null for absent selection). `capture-control` start/resume requires ongoing collection
consent and records the current EOF. Its first later proven native unit is excluded
as the boundary. Pause/exclude requires the explicitly selected current native unit;
it never infers identity from the latest source row. Pauses do not enable collection.
A source change or stale state leaves the control unresolved.

Reader headroom is opt-in: pass `includeReaderAllocation: true` or a `scopeId`.
Routine status calls omit `readerAllocation` and do not read checkpoints or counters.
When requested, `capture-status.readerAllocation` reports Claude counters for
scopes already listed in that selection's intervals or explicit scopes; it does
not discover other sessions.
It reads at most 32 scopes per call. If more are known, `status` is
`scope-selection-required`, `scopeIds` lists the choices, and no counters are read;
repeat with one listed `scopeId`. An unknown scope is refused. Codex returns
`not-applicable`. Missing selection or no known scopes returns `unavailable`, not
zero usage. Valid reports have `status: available` and `scopes` entries with:

- `bytes` and `pages`: `reserved`, `limit`, and `remaining`. These are cumulative
  allocation and page attempts, including obsolete pages and interrupted attempts.
- `status`: `ok`, `low-headroom` at 80% of either limit, or `exhausted` at a limit.
- `checkpoint`: the saved root's referenced page count and byte total. This is
  metadata only; status does not hydrate or verify those pages or measure disk usage.

An unused scope with no page-bearing checkpoint or counter reports zero allocation.
A missing counter for a page-bearing checkpoint, an invalid counter, or one below
its checkpoint's referenced allocation,
produces an `inconsistent` scope entry with no usage numbers; expected metadata
read failures produce `unavailable`. Malformed saved progress or a checkpoint/source
binding mismatch reports `INVALID_READER_PROGRESS` for that scope; healthy scopes
remain available. Overall `partial` reports retain the
selection/hash for controls. Privacy, private storage identity, workflow budget and
unexpected failures reject the command instead of becoming partial reports.
For each scope, status reads the checkpoint **before** the counter, without a lock
or filesystem writes. Newer counters than the saved checkpoint are valid, including
charged attempts with no committed checkpoint. The reads are not an atomic snapshot:
usage can lag active collection and reported headroom can be higher than what
remains when used. See [reader storage](session-workflow.md#claude-reader-contract)
for the storage contract; status does not reserve capacity or reclaim pages.

Selection inputs normalize project directory aliases and trailing separators to the
stored project identity. Existing captures remain inspectable and processable
after a worktree is deleted, provided the configured storage and source identities
remain valid. New selections still require an existing project directory; macOS
case-only route ambiguities fail closed. An exact owner pause/exclusion remains available after its route is
disabled or removed: supply the configured collection, original source identity,
and inspected selection hash. It may archive that owner's unpublished intent;
it cannot adopt or discard another session's pending publication.

The named pause anchor must begin at or before the frozen pause EOF. If the
reader cannot prove it, eligible backlog stays pending; a delayed duplicate
record cannot move the pause past later units.

For explicit current/historical collection, `kind` is `current` or `historical`;
`unitIds` contains 1–100 native IDs. Current requires one ID matching selection.unitId.
`readRange` is `{fromByte, endByte}` with complete record boundaries and a maximum
8 MiB window. It represents authorization to read that range of the named file,
not a claim about native ownership. Choose the window from the user's selected
source/range; never silently scan earlier history to locate a missing ID. The readers
verify native anchors within it; missing endpoints, partial records and unsupported
structures fail without widening it. A separate bounded identity/header read is
required. Preview creates no files. Select persists metadata only, so a later run
failure leaves a reviewable, retryable scope.

Run an explicit scope with the exact `unitIds` returned by selection and its hash.
Run a future interval without `unitIds`. Explicit runs work with ongoing collection
disabled or paused, but exclusions remain authoritative. Neither kind sweeps other
scopes. Current and historical scopes both retain the selected end boundary; later
appends outside it are not imported. For later evidence explicitly select a new
range that also includes the existing snapshot's retained evidence when extending
it. A fully covered replay advances only its own selected window without creating
a new snapshot. Changed prior evidence remains a conflict, not automatic
reinterpretation.

A run shares the worker's ten-second/64 MiB budget and returns saved/pending/coverage
status plus current selection state/hash. Use that returned hash on subsequent
calls because native anchor resolution can update selection metadata. No model or
Markdown writer runs during collection. Codex needs its supported terminal proof;
Claude publishes proven human-input snapshots with unconfirmed finality.

## Processing chat controls

The optional native-client controller uses the existing engine. It launches the
installed `codex` or `claude` executable with the client's authentication and the
model resolved under restricted launch settings, and reuses a dedicated chat. It is explicit, not a
hook-triggered model runner. See [entry, review and recovery](processing-chat.md).
These commands use the collection envelope and return `interfaceVersion: 1`:

| Command | `args` |
| --- | --- |
| `processing-chat-status` | `{client}`; reads the selected local client-profile binding without launching a native client or dispatching a model turn |
| `processing-chat-run` | `{client, requestId, selection, expectedChatHash, worksetId?, resumeOperationId?}`; exact status hash, or null for a missing binding; the optional bindings are mutually exclusive |
| `processing-chat-reconcile` | `{client, requestId, expectedChatHash}`; reinspects a known terminal's unresolved operation, or verifies an exact sealed Codex completion, failure or interruption; live owners and unproven outcomes remain blocked |
| `processing-chat-abandon` | `{client, requestId, expectedChatHash, offline: true}`; explicitly retires a creating/busy run or unknown creation/dispatch outcome after the operator stops its controller and native child; refuses live or unverified owners and preserves all engine work |
| `processing-chat-reauthorize` | `{client, expectedChatHash, previousPolicyHash}`; explicitly accepts current settings for the registry, preserving existing engine claims and proposal hashes |
| `processing-chat-rollover` | `{client, expectedChatHash}`; archives settled request history while retaining the same native chat and exact-request replay protection |

`client` is `codex` or `claude`; `requestId` is a new UUID for each explicit run,
reused for retries of that exact request. A duplicate never dispatches again.
`state` is `missing`, `creating`, `idle`, `busy`, `awaiting-review` or `blocked`.
`chatHash` binds registry mutations; `policyHash` exposes the registry's accepted
settings hash for explicit reauthorization. `remainingRuns` reports the native
history capacity left before guarded rollover, or the full replacement-session
capacity for a retired binding. `restartSupported` is true only for a binding
explicitly retired offline or proven not to have dispatched creation. It permits
the normal new-request admission checks, not automatic execution or bypass of
authentication, claims, or recovery. Such a binding reports `idle` unless its
retained operation requires inspection or has a proposal awaiting review. An
unresolved proposal reports `awaiting-review` and prevents another native run,
including from a different namespace. `nativeStatus` distinguishes a
completed, failed or interrupted native run; null means no terminal is available
for the current state. `operationId` points to authoritative engine status. For an
idle chat with a recorded operation, status also returns
`operationState`, `operationOutcome` and `recoveryRequired` from a metadata-only
engine inspection; a completed native turn does not imply completed engine work.
When that inspection is unavailable, `operationState` is `unknown`, both outcome
and recovery fields are null, and `OPERATION_OUTCOME_UNKNOWN` calls for inspection.
These fields concern the latest recorded operation, not a collection inventory.
`chat` identifies the native session, while `desktopVisibility` remains
`unverified`. Neither `idle` nor a native completed turn means a note was saved.
Busy or blocked state must not be bypassed with another binding or writer.
`processing-chat-abandon` archives the exact binding. Retired bindings omit
historical launch diagnostics and return null for the current `chat` and
`requestId`; the archived registry retains those identities. A retained unfinished
claim without a verified terminal owner reports `blocked` with
`PROCESSING_OPERATION_OWNER_UNVERIFIED`. Competing execution does not erase
verified terminal ownership: `processing_status` identifies the active peer and
advises waiting, while new runs remain refused until that execution ends.
A direct `processing-chat-run` also returns the unverified-owner blocker before
replacing the binding, even with a fresh request ID or explicit resume/workset
arguments. Abandonment does not cancel an engine operation or mark its evidence
handled. Inspect any surviving operation before continuing. Only a subsequent
explicit run that passes admission with a new request ID creates a replacement
native session; the abandoned request can never dispatch again.
`offline: true` records the operator's confirmation that both the controller and
native child are stopped, including for older records with no saved owner. It is
not a model-selected retry flag.

The installed `cuefluent_control` MCP server exposes these strict tools:

| Tool | Arguments |
| --- | --- |
| `processing_status` | Claude: `{collectionId?, retryToken?, verbose?, help?}`; Codex: `{collectionId?, retryToken?}` |
| `process_selected_captures` | `{collectionId?, selection?, requestId?, retryToken?, scope?}` |
| `processing_resume` | `{collectionId?, retryToken?}` |
| `processing_cancel` | `{collectionId?, retryToken?}` |
| `processing_review` | Claude: `{collectionId?, retryToken?, draft?, decision?}`; Codex: `{collectionId?, retryToken?}` |

The MCP `arguments` member may be omitted or null for an empty argument object;
other non-object values are rejected. Native source verification still applies.
A code-mode call can first return `{interfaceVersion: 1, status:
"verification-required", retryToken, instruction}`. This is a challenge only,
not processing status or admission. Complete that exec, then repeat the same tool
and arguments with the UUID `retryToken` in a new exec. The connection retains the
original request for at most one minute and verifies its completed native call and
response before any work. A token cannot change arguments, turn, source or policy,
is consumed on its first retry, and does not survive reconnects. A failed retry
requires a fresh explicit invocation; it must not fall back to inline processing.

Native metadata must bind the actual call to an already registered source: an
active or paused selection, explicit capture scopes, a processing-only hook
binding, or, for Claude, an exact current collection registration (its own grant
still current) with no selection state yet. Processing-only bindings record
a locator and future byte boundary under the current policy; they never enable
collection. The explicit request verifies the native source header and exact call
within the bounded recent range. Without a selection, a Claude source may also be
read from its start (after a verified continuation's re-homed prefix) within the
same 2 MiB bound when everything before the hook boundary holds at most the one
prompt that registered it, so a typed control in a
fresh session's first prompt binds. When neither the registration nor that
prompt's wake could snapshot the transcript (Claude can create it only after the
prompt's hooks ran), the collection worker freezes the floor itself from a
metadata-only snapshot taken when it handles that prompt wake (the worker that
prompt's hook launched waits at most one second for the file to appear); a later
floor is never wider, and the
binding waits for a floor within its existing settle window. Only the worker
freezes a floor. This creates no selection, moves no floor and
captures nothing earlier: the first full prompt after the floor is still the
excluded boundary, so collection starts with the prompt after that. With
collection on, a typed control that is itself that first prompt after the floor
binds before the selection is armed (it can never be collected), provided the
bounded read still reaches the floor; any later typed control, or one past a
longer unarmed tail, binds only once the selection is armed.
Omitted collection selection must resolve uniquely from bounded registration
metadata; no new source is discovered. The optional `selection` must match the
verified caller; it is not the default evidence boundary. Evidence `scope` is
`collection` (default), `repo` or `chat`. A mismatched exact formal action and tool
scope is refused. Narrower scopes still require existing per-input policy. MCP dispatch identity derives from the verified native
session and call ID: redelivery replays, while another invocation is new even if
the model repeats its optional `requestId` hint. A typed `capture`, `pause chat`
or `resume chat` keeps its reply as well, so its redelivery answers as the first
delivery did and acts once. Its call is reserved before it acts: a delivery
that finds the call reserved without a kept reply, because another delivery is
acting or stopped before keeping its reply, reports `PROCESSING_CONTROL_FAILED`
without acting or leaving out its turn. A delivery that fails before it can
tell does not leave out its turn either; its refusal reports
`PROCESSING_EXCLUSION_UNVERIFIED`. A command whose reply cannot be kept reports
`PROCESSING_CONTROL_FAILED` too, after acting. The kept reply says whether the
command left out its own turn. A `pause chat` that paused Automatic capture is
the exception: the chat's binding then starts after that call, so its
redelivery is refused before acting and the pause stays. The returned `requestId` is the
authoritative controller identity. CLI request IDs remain explicit as described
above. Native tool namespaces can add client-specific prefixes.

A refused or failed tool call is a JSON-RPC error whose `message` is a plain
sentence for the person (no codes, paths or identifiers) and whose `data.code`
is the bounded diagnostic code below. A failure before the requested action
started says that nothing was applied; any other unknown failure binding the call
reports `PROCESSING_CONTROL_SOURCE_UNVERIFIED`. A failure after the action started
reports `PROCESSING_CONTROL_FAILED` unless it is a known code, and its message
says the outcome is not certain and to check `status`; a refusal for the native
client's sign-in or launch settings, or an unconfirmed cancel, names that cause
instead. When a typed command fails and its own turn could not be left out of
later captures, `data.diagnostics` also lists `PROCESSING_EXCLUSION_UNVERIFIED`.

Source-binding failures use bounded MCP error codes. An exact Codex ingress
registration with current collection authority but without a selection or
processing-only binding reports `PROCESSING_CONTROL_REGISTRATION_UNVERIFIED`;
ingress metadata supplies neither dispatch authority nor a worker outcome.
For a session still selected for active collection, a stale registration grant
reports `REGISTRATION_REQUIRES_REVIEW`. Old registrations do not request grant
review when collection is off or the session is no longer selected; without a
current binding the control reports `PROCESSING_CONTROL_SOURCE_UNVERIFIED`.
Use a processing-only binding under existing processing policy or the standalone
explicit workflow without enabling collection. Actual
ownership, history or identity rejection for the invoking Codex source reports
`UNSUPPORTED_SESSION_OWNERSHIP`, `UNSUPPORTED_CODEX_HISTORY` or
`SOURCE_IDENTITY_MISMATCH`; in Claude, where discovery could have rejected a
different registered candidate, these report `PROCESSING_CONTROL_SOURCE_UNVERIFIED`
instead. An absent or otherwise unproven binding remains
`PROCESSING_CONTROL_SOURCE_UNVERIFIED`. These errors contain no source paths or
evidence and do not change the command schemas. See the
[processing entry guidance](processing-chat.md#entry-and-reuse) for precedence,
storage-safety diagnostics and recovery.

Outputs are versioned bounded status with `statusText`, `status`, `requestId`,
`collectionId`, `chat`, `nextAction` and diagnostic codes. They contain no evidence
or draft text. `statusText` is for people: it carries no hashes, identifiers or
diagnostic codes (when there are diagnostics it says to type `status --verbose`),
except in the reply to `status --verbose` described below. Optional
`commandPrefix` (`/cuefluent-notes` in Claude, `$cuefluent-notes` in Codex) is the
spelling, followed by one space and the action, of every command the text names;
replayed responses keep their original text. Optional `scope` is `collection`, `repo` or `chat`. Optional
`progress` reports selected/unattempted/handled/unavailable/cancelled revisions,
unfinishedOperations, awaitingReview and incomplete for the frozen selection.
Status also returns `inventory` with pending, claimed, blockedByClaim, inspected,
handled, unfinishedOperations, awaitingReview, incomplete and sourceCompleteness.
Inventory is collection-wide but bounded to one metadata page; counts are not an
atomic total. `nextAction` can additionally be `process` for another inventory
portion or `cancel` (type `process cancel`) for an unchanged frozen selection
that cannot continue. Tool arguments accept no approval or source-proof object.
New responses also include `statusDetail`: `accepted`, `already-processing`,
`processing`, `preparing`, `draft-ready`, `unfinished`, `inactive`, `missing`,
`blocked`, `completed` or `unbound`, plus `nothing-pending`, `nothing-to-resume`,
`discovery`, `continuation`, `cancelled`, `selection-limit`, `selection-complete`,
`pending` and `inventory-incomplete` for shortcut results. A status reply also
returns `drafts` (at most four `{code, path, fileCount}`) for drafts awaiting
review, listed one per line as code, one space and note path. Claude's
`verbose: true` mirrors a typed `status --verbose` (Codex: the verified typed text
alone); that reply returns `verbose: true`, adds `operationId`, `proposalHash` and
`claimHash` to each listed draft, and its `statusText` lists the status, next
action, diagnostics, request and processing-chat identifiers, scope, counts and
each draft's exact revision. Claude's `help: true` mirrors a typed `help` (Codex:
the typed text alone); that reply returns `help: true` and only the command list,
built from the grammar, in its `statusText`. `help` is a formal, read-only control
receipted like `status`; the skill typed with nothing after it gets the same reply
without a receipt. Help needs no configuration: when nothing is set up for the
chat (no configuration, no route for this client, or no registration, selection
or processing source for this session in any routed collection) and no
`collectionId` was requested, `processing_status` alone still answers, with
`status: "missing"`, `statusDetail: "unbound"`, `help: true`, `collectionId:
null`, the diagnostic `PROCESSING_CONTROL_SOURCE_UNVERIFIED` and a `statusText`
that names `setup` before the command list. It reads and writes no private
storage and records no receipt. Every other tool, an explicit `collectionId`, a
failed binding of a source that exists and a verification retry that still
cannot bind refuse with that code as before. Admission, a competing request and a read-only progress
snapshot remain distinct even when their stored execution state is `busy`.
An idle native session with unfinished engine work reports `unfinished`, with
`resume` (type `process resume`) or `inspect` as the next action. `inactive` does not mean an empty backlog.
Legacy response receipts omit this field and replay their original text unchanged.
If the engine disposition committed but registry or receipt bookkeeping failed,
the response is `completed` with `nextAction: "inspect"` and a bounded diagnostic;
its `statusText` keeps the decision's outcome and adds that something needs
attention, with `status --verbose` for the details.
Inspect the existing operation; do not repeat its save. That response does not
claim successful capture-exclusion bookkeeping.
`processing_review` writes the exact outstanding proposal to a private review
folder under the collection's intake state (`review/<code>/`, directories 0700 and
files 0600 on POSIX, no links followed): `proposed.md` and, for an update,
`current.md` (numbered `N-proposed.md`/`N-current.md` for several files), plus
`summary.txt` with paths, sizes, sources (each with the numbers of the files it
supports and at most five omission details plus a count), inspection limits, the
decision commands and the operation, claim and proposal hashes, bounded to 1 MiB.
Entries an editor or Finder adds inside a review folder are neither checked nor
followed by the storage privacy check; Finder's `.DS_Store` is removed with the
folder's own files, and anything else keeps the folder. At most 32 folders are
kept, the oldest removed first, and a reused copy whose permissions changed is
written again. A durable presentation record in the
same private state stores `{chatLineage, operationId, proposalHash, claimHash,
attempt, presentedAt, verified, delivered, typedDelivered}` for the invoking chat lineage:
the native session, or the root session of a verified Claude continuation (see
the [Claude reader contract](session-workflow.md#claude-reader-contract)), so the
records outlive a continuation. `attempt` is a random ID naming the latest presentation attempt of
that revision, and `verified` and `delivered` describe it (typed, and its reply committed), and `typedDelivered` records that
some typed review of it was delivered to that session. A coded decision needs
`typedDelivered`; a bare decision needs the session's latest attempt to be a
delivered typed review. Before the reply is written, the attempt must still be
this chat's current one; if another request settled or superseded it meanwhile
(`PROCESSING_REVIEW_SUPERSEDED`), the reply is the error and the draft must be
reviewed again. The attempt counts as delivered only once the reply was written;
a failed write, a stopped process or a failed confirmation leaves the draft
undecidable until it is shown again. A redelivery of that same call is refused
the same way unless this chat's record of the exact revision its receipt names
is live and delivered and that revision is still awaiting review. A cancelled, failed or model-started attempt
therefore never makes a draft decidable, and never lets a bare decision fall
back to an older draft. A folder is removed when its draft is
decided through review, or by a later review or refused decision once its revision
is no longer pending; records are bounded per collection (64 revision records and
64 chats' latest attempts). A collection step that has not finished, such as a
capture still being published, refuses a review or decision with
`PROCESSING_REVIEW_BLOCKED` and leaves the draft and this chat's record as they
are; a review step, and a control's receipt, waits up to two seconds for the
collection lock before refusing with `INTAKE_BLOCKED`.

The draft code is six characters from `a-h j k m n p-t v-z 2-9`, derived from a
domain-separated hash of the proposal hash. Claude's optional `draft` (that code)
and `decision` (`save`, `skip` or `cancel`) mirror the typed action `review`,
`review <code>`, `save`, `save <code>`, `skip`, `skip <code>`, `review cancel` or
`review cancel <code>`; the native transcript must show exactly that typed text,
so changed or model-chosen fields are refused. Later exists only as a choice in
the Codex form. Codex refuses these fields with
`PROCESSING_CONTROL_INVALID_REQUEST`; its verified typed text alone names the
draft and decision. Codex verifies typed text in either native form: a user
message whose parts are this skill and the text, or (Codex CLI 0.163) one text
part that starts with the skill's mention, optionally recorded as the `$` list's
single placeholder element, plus exactly one `skills.selected_skill_instructions`
item of the same turn naming this skill at its installed `SKILL.md` path; the
typed text is what follows the mention and one space. A mention typed out without
that item is no command. A code-mode call verifies the same typed text through
its native MCP item and the completed handshake; its exclusion receipt also names
both cells and the retry call, so the reader can prove the whole turn (see
[capture prevention](processing-chat.md#capture-prevention-and-limits)).
A decision applies only through a verified typed action, to a
revision that a delivered typed review presented to the invoking chat lineage (a
model-initiated or natural-language display records `verified: false` and does
not count, even with the code), whose claim and proposal hashes still
match; Save, Skip and Cancel then use the existing exact-hash engine paths. A
decision without a code uses only the lineage's most recent presentation attempt,
and only when that attempt was a delivered typed review. Tool arguments cannot
substitute for the typed text or a host response.

Codex with form support also sends the same exact proposal through the correlated
native host form, whose header names the review folder; an unsupported or closed
form preserves the pending proposal.
The control server supports MCP `2025-11-25`, including the string defaults needed
by native review. It offers this version even when the client's initial request
names an older one. Clients unable to accept it cannot use this MCP server and
must use the explicit CLI commands. Claude never receives a review form, and Codex
without form capability reviews through the folder and typed decisions. See
[MCP version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation).
When multiple proposals are pending, Codex's form review first sends a selector with a required
`operationId` string and titled `oneOf` choices (`const` is the exact operation ID).
There is no default. Acceptance selects a preview only; decline/cancel leaves all
proposals unchanged. The subsequent form remains bound to the selected exact
proposal. This uses the [supported single-select schema](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation#requested-schema).
The proposal form uses a short header, an optional `changes` string containing
the complete readable preview as its default, and a required `decision` enum (`save`, `skip`,
`cancel`, `later`) without a default. Save, Skip and Cancel apply only when the
accepted host response echoes the unchanged preview, allowing LF/CRLF/CR
line-ending conversion only. Changed, trimmed, collapsed, oversized or missing text
applies no decision and leaves the exact proposal pending; it cannot revise or
authorize different note bytes. Later applies nothing and is reported as
`deferred` whatever the echo, so a host that renders the preview empty still lets
the person defer.
Review responses add `review`, separate from `statusDetail`: `presented` for a
written review folder; `saved`, `skipped` or `cancelled` for a completed decision;
`deferred` for Later; `declined` for a host decline or close, including a declined
draft selector; `display-altered` for a changed echo; `not-shown` for a draft not
presented to this session; `unverified` for a decision that was not a verified
typed action; `changed` for a revision, destination or pending state that no
longer matches; `unresolved` for a decision without a code and no verified latest
presentation; `unavailable` for a pending draft without a review callback; and
`busy` for a review typed while this chat's own processing run is still going,
which applies nothing. A coded decision naming a draft that is no longer pending
is `changed` with reason `not-pending`, whether or not this chat was shown it.
A pending display the person did not type (`verified: false`) adds
`untyped: true`, and its `statusText` says to type `review <code>` first.
`changed` can add `reason`: `changed` (the revision differs from the one shown),
`destination` (a note at its destination changed), `not-pending` (not
pending) or `stale` (its review here is no longer current); its `statusText` then
names that cause. `presented`, `deferred`, `declined`, `display-altered` and `unavailable` always
have status `awaiting-review`. Review responses built from review fields also return
`commandPrefix`, optional `draft` (`{code}`, `{code, path, fileCount}` naming its
first note path while it is pending, or `{code, folder, files, fileCount}`, with at
most five `{path, bytes, change, review?}` files, `review` naming the file's
proposed copy in the folder) and optional `drafts` (at most four
`{code, path, fileCount}`, one Markdown list item each as code, one space and
note path), and their `statusText` omits diagnostic codes. Note paths are quoted
as JSON strings with the characters CommonMark or GFM read as inline markup
(`` ` ``, `*`, `_`, `[`, `]`, `<`, `>`, `&`, `~`) backslash-escaped, so
each renders exactly as written. Its Markdown blocks
are separated by blank lines, and every list follows one. For Claude the folder
and each file's proposed copy appear as percent-encoded `file://` autolinks; for
Codex as `[name](/absolute/path)` links named by the path's last segment, with
`[name](</absolute/path>)` for a path with spaces or parentheses and no link for
a path Markdown cannot carry, such as a Windows path or one with `#` or `?`. Links are dropped in
favour of the folder path as a code span when they would not fit the reply
bound, and that code span, with its controls escaped and its fences counted,
stays within 1024 bytes; the `draft.folder` field always holds the native path. `saved`, `skipped` and
`cancelled` may carry `{code, path, fileCount}` for the decided draft. A
completed decision whose only diagnostic is `PROCESSING_EXCLUSION_UNVERIFIED`
does not add the `status --verbose` hint.
A status reply may add `collection: {state: "stopped", code}` when the latest
collection pass reported `CLAUDE_HISTORY_REQUIRES_REVIEW` or
`UNSUPPORTED_SESSION_OWNERSHIP` for exactly the invoking session; its
`statusText` says in plain words that collection has stopped for this chat, and
`status --verbose` names the code. It is display only and changes nothing.
Note paths in these fields are truncated to 512 bytes for display; `summary.txt`
keeps every full path.
When the verified typed input that started the call selected this skill but is
not one exact action (Claude: the trusted skill command's arguments with its
native companion; Codex: a user message with the trusted skill block), every
tool returns `command: "not-a-command"` with `commandPrefix` and one to three
`suggestions` instead of acting: no dispatch, display, decision or receipt. Its
`statusText` is only that sentence and the suggestions, without counts, scope or
listings. A
mixed message (an exact action plus more words, lines, content or a second
message) is such input too, and so is a plain-language request that starts with
an action word. Suggestions are exact actions, `setup`, or a form with
`<draft code>` in place of an unusable code, computed deterministically from the
command grammar and the typed text (text near no command gets `help`, `review`
and `status`); they carry no authority. In Codex, a turn whose one message is a
single text part starting with this skill's mention but without any
selected-skill item (the mention typed out by hand) is answered the same way,
with `command: "skill-not-attached"` and a `statusText` that says to choose
cuefluent-notes from the `$` list; the suggestions come from the words after the
mention.
Quoted note-content lines, escaped controls and per-file line-ending
summaries distinguish source text from review structure without changing saved bytes.
The outgoing form is bounded to 256 KiB. Incoming frames allow up to six times
that size for host JSON escaping, even after a form closes; ordinary MCP requests
remain bounded to 64 KiB. Late or unknown response IDs are ignored within the
framing bound. A correlated response whose preview echo exceeds 256 KiB is a
changed display. Frames exceeding the hard framing bound still close the
connection. Host decline/cancel responses leave
the proposal pending, distinct from an accepted `skip` or `cancel` decision. See
[review controls](processing-chat.md#review-controls) for the user workflow.
Cancelling the MCP request before its save intent or disposition starts publication
leaves the proposal pending, including after the form returns. Once publication
starts, the engine finishes or reports its error/recovery state; late cancellation
does not suppress that result or undo a save.

The restricted child engine tool schemas are declared in
`scripts/processing-tool-contracts.mjs` (interface version 1). Only the selected
engine operations, note inspection and proposal preparation are exposed. There
is no save, shell, setup or consent-changing tool in that channel. Consumers must
not parse the private chat registry or mint native proof receipts.
`guidance_read({guide})` accepts only `authoring`, `retrieval`, `evidence`,
`placement`, `metadata`, `series` or `processing`, returning the complete bundled
guide (at most 64 KiB), its hash, and recording-time context. It accepts no path.
Restricted `prepare_note` takes `{original, content, metadata?, enrich?,
contentHash?, createSeries?}`; the adapter supplies the installed package version
and current UTC recording time. Evidence occurrence dates stay source-derived.
The standalone `prepare-note` CLI contract is unchanged.
Serialized child-engine results are bounded to 256 KiB; oversized results return
`PROCESSING_ENGINE_OUTPUT_LIMIT` as a tool error without truncated evidence.

## Processing selected captures

### Processing shortcut checkpoints

The same engine exposes these versioned CLI commands through the ordinary
collection/config envelope:

- `processing-shortcut-select`: `{selection, requestId, scope?, mode?}`. `scope`
  is `collection` (default), `repo` or `chat`; `mode` is `process` (default) or
  `resume`. The caller is independently authorized. A UUID request ID makes
  selection retries idempotent. This command selects metadata and worksets; it
  does not launch a native client or save notes.
- `processing-shortcut-status`: `{selection}`. Read the current checkpoint and
  authoritative workset/operation outcomes without changing them.

Both return `interfaceVersion: 1`, `checkpointHash`, `requestId`, `phase`, `scope`,
`operations`, `worksets`, `nextRun`, `incomplete` and `sourceCompleteness`.
An existing checkpoint also reports its original `selection`, `policyHash`,
`counts`, `blockers`, `reviews`, `continuationNeeded`, `remainingInputs` and
`unlinkedWorksetId`. `remainingInputs` contains exact unattempted
`{identity, headHash}` references across the entire frozen selection.
`unlinkedWorksetId` is null or the deterministic workset published before an
interrupted checkpoint update; inspection includes it and selection repairs its
pointer without replacing its contents. Status adds `policyState`.
`nextRun` is null or an exact `{worksetId}` / `{resumeOperationId}` binding for
`processing-chat-run`. Counts distinguish selected, unattempted, handled,
unavailable, cancelled, unfinished operations and awaiting-review operations. No native
session, no checkpoint, and no remaining selected evidence are different states.
`sourceCompleteness: "unknown"` never asserts that retained captures contain all
original output. A `reason` may explain a no-op or recovery requirement.

A selection examines at most four metadata pages per call and freezes at most
100 pending revisions. Its scope-bound cursor preserves discovery progress;
a frozen selection excludes later arrivals. It uses existing worksets, with at
most 20 admissions and 16 MiB per workset; up to ten continuations preserve the
same exact remaining inputs. Existing unfinished operations with a verified stopped native owner run first.
Standalone claims without that proof remain preserved for explicit CLI handling. `process resume`
never opens a fresh evidence selection after the frozen one finishes; a new
`process` may continue the inventory cursor. Incomplete discovery is not an empty
backlog. A changed policy, scope conflict or recovery requirement preserves the
checkpoint. Cancel safely owned unapplied work before starting a fresh selection
under changed policy or after unavailable inputs; never refresh old hashes.
Finished or cancelled selections may be replaced by a fresh `process` request.
When continuation capacity is exhausted, `PROCESSING_SHORTCUT_CAPACITY` is a
checkpoint blocker and native status offers Cancel, followed by a fresh Process.
It does not keep offering an unusable Resume.
An observed intake lock does not block read-only inventory or review discovery.
Mutating helpers still acquire the intake lock and refuse with `INTAKE_BLOCKED`
if the lock already exists. If inventory changes during a bounded status retry,
`PROCESSING_INVENTORY_INCOMPLETE` accompanies the execution snapshot without
claiming inventory totals.

The MCP shortcut can reuse a native session for at most eight sequential turns
per request and admits no further turn after 45 minutes. Each turn retains the
[bound-run limits](#bound-native-processing-runs). These are admission bounds,
not promises about a model's response time. A proposal, unfinished operation,
conflict, native failure or lack of progress stops continuation earlier. No
shortcut automatically saves or changes capture configuration.
If native history reaches capacity, `PROCESSING_CHAT_HISTORY_FULL` stops further
turns. Use the existing guarded `processing-chat-rollover` command while the
session is idle, then resume; its archive preserves request replay and the chat.

Cancellation is a native control, not a CLI assertion that execution stopped.
`processing_cancel` must verify owned native termination before releasing claims.
Cancel never adopts unrelated standalone operations or drafts.
Standalone agents retain the existing explicit completion and recovery commands;
a serialized stop flag cannot grant native cancellation authority.

### Bound native processing runs

`processing-chat-run` can bind an existing `worksetId` or `resumeOperationId`.
With neither, it retains the single-source, single-operation contract. The source
`selection` identifies the explicit caller; a workset or resumed operation retains
its original engine selection and exact input hashes. This does not change
collection settings or authorize a save.

A workset run processes bounded operations sequentially in the same isolated
native turn. The restricted `processing_pending` tool returns the frozen workset,
its unfinished operations and `nextPreparation` (`{operationId, inputs}`), or null.
The native agent uses that exact preparation, inspects and acknowledges each page,
and either completes unchanged or publishes a proposal. It continues after an
unchanged outcome; a proposal, conflict, recovery or exhausted budget stops the
run. New captures do not enter the frozen workset. Operation IDs come from the
workset's deterministic admission, not arbitrary model-generated IDs. Existing
charged admissions retain their exact budget on retry. A single input that exceeds
the remaining budget requires an explicit bounded continuation; it is not omitted
or marked handled.

An interrupted admission appears as `nextPreparation` with its original inputs
and operation ID. A new admission cannot skip an unfinished operation. After
`PROCESSING_BATCH_BUDGET`, call `processing_pending` again: measured input sizes
can reduce the next preparation to a fitting prefix without charging the rejected
batch. `reason: "input-budget"` means no leading input fits that remaining budget.
The controller also limits each native turn to three operations, 4 MiB of
packet admissions and eight minutes before starting another operation. An existing
claim can finish under its original budget. `reason: "run-budget"` pauses further
admission while preserving the exact workset for another run. These limits do not
guarantee a model will finish one operation before its transport timeout.

`resumeOperationId` binds only that existing operation and disables new preparation.
This supports an interrupted standalone operation without rewriting its selection
or adopting its claims into another workset. A completed bound operation or fully
handled/exhausted workset returns `dispatch: "not-started"` and a bounded `reason`
without starting a native client. Proposals and recovery remain explicit blockers.
`workset-remainder-unavailable` distinguishes blocked or cancelled remaining inputs
from exhausted admission budget. Unattempted input conflicts do not prevent valid
independent frozen inputs from being processed. Unknown final metadata is reported
as `WORKSET_OUTCOME_UNKNOWN`; it does not undo a recorded native completion.
Status can include `workset` metadata separately from the native state and latest
operation outcome; native `idle` does not mean the frozen workset is complete.

Native admission checks all processing-client bindings in the collection under
the existing intake lock. A different active, unresolved, or awaiting-review
binding refuses another run with `PROCESSING_COLLECTION_BUSY`. Inspect or finish
the existing owner; do not create another binding or clear locks to bypass it.
A completed engine outcome releases this admission gate even if its former
native client has not acknowledged the review yet. The read preserves that
client's registry. These checks do not replace engine claims, writer conflicts,
or recovery.

### Supported read interface

`--help`, `processing-capabilities`, `processing-pending`, `processing-inventory`,
`processing-status`, `processing-worksets`, and `processing-workset-status` advertise `interfaceVersion: 1`.
Workset creation and preparation also return a versioned workset view; ordinary
page, ack and proposal responses do not advertise a separate version. This is the public command/read-model contract, independent
of capture and private-state schema versions. Consumers must use these commands,
not parse private claims, journals, or receipts. Stop on an unsupported interface version until compatibility is explicitly
established. Additive fields may appear; request keys remain
strict. This interface works without Cuefluent being installed or running.

`processing-capabilities` accepts an empty request `{}` (or no `--request`), without
a collection envelope. It reads no settings, captures or operation state and
ignores `--config`. Its versioned response has `generatedOutput`,
`automaticProcessing: false` and `modelRunner: false`. `generatedOutput` reports
`verified: false`, `collectionExclusions: false`, `processingExclusions: false`,
reason `HELPER_INVOCATION_BINDING_UNAVAILABLE`, per-client reader capabilities,
required proof and a limitation. `status.transport.generatedOutput` uses the same
shape. These top-level copy flags describe arbitrary inline output. The separate
`generatedOutput.isolatedProcessing` object describes verified native controller
records and formal skill controls, with per-client proof scope, inherited-hook
restriction and native review channel. `controller` reports interface version 1,
`execution: "installed-native-client"`, `independentModelRunner: false` and
`desktopVisibility: "unverified"`. Each client reports `retainedEvidence`, `retainedToolCallIds` and
`helperInvocationBinding`. `retainedToolCallIds` means supported retained tool
records can carry native call IDs; it does not prove that a matching call record
exists, call ownership, or trusted helper execution. These flags describe
implementation support, not consent or feature
switches. Extra request keys, including claimed provenance, are rejected. See
[generated-output provenance](session-workflow.md#generated-output-provenance-gate).

`processing-pending` counts apply only to the returned head page (`scope:
"returned-head-page"`): pending, unclaimed, exactly claimed, blocked by an older claim, and handled **revisions**.
They are not note counts or collection totals. `operations` covers the selected
session/unit independently of head pagination, within the existing operation bound.
Inventory is an advisory concurrent read, not an atomic snapshot or authorization.

Operation status reports `state`: `missing`, `unread`, `inspecting`, `inspected`,
`draft-staging`, `awaiting-review`, `conflicted`, `blocked`, `recovery-required`, or `completed`.
`inspection` reports issued/acknowledged/total pages, exact packet bytes and the
next unacknowledged page (null when all are acknowledged). Delivery is not inspection.
`sourceCompleteness: "unknown"` means these metadata reads did not inspect coverage
inside captures. Full page acknowledgement does not establish complete original
source evidence. No raw bodies are read to produce these views.

`inspection.projection` describes the unchanged `full-capture-v1` packet projection:
`capturedFileBytes` sums the canonical sizes of the claimed capture revisions when
the batch was prepared, including each final newline; `embeddedCaptureBytes`
excludes those newlines; `packetBytes`
also includes the packet's input descriptors and JSON framing. These are not
original native transcript sizes or a current retention/disk-usage check. Completed
operations retain these historical measurements even after pruning.
`provenCopyExcludedBytes` is zero and `exclusions`
is `disabled-unverified`. `collectionAvoidedBytes: null` means collection-time
savings are not measured here; it must not be displayed as zero or as processing
savings. Ordinary reader omissions remain in capture coverage, independently.
This diagnostic is derived from validated manifests and does not change packet
hashes or the meaning of existing acknowledgements.

`outcome` is a durable saved/unchanged/skipped/cancelled result or null. A completed
operation may still have `recoveryRequired: true` while projections/cleanup finish;
use its inspected `recoveryHash`. Proposal intent alone is `draft-staging`, not a
published draft or approval. `nextAction.command` names a CLI operation when one
applies; null with `reason` means review or conflict resolution requires judgment.
These hints do not supply missing request fields, approval, or refreshed hashes.
`freshness: "metadata-only"` is not a declaration that every input/output is current.
Claims at unchanged configured collection paths with changed physical identities
remain visible as `conflicted` with `PROCESSING_BINDING_CHANGED`. Their revisions
are `blocked-by-claim`; `PROCESSING_BINDING_CHANGED` also blocks all new preparation
in the collection, including unrelated pending revisions. This metadata view does
not establish storage continuity or authorize a save under the changed binding.
It does not block review of a healthy current-binding proposal. An unapplied stale
claim's next action is exact `processing-complete` cancellation; completed history
does not retain a binding conflict after cleanup. A transfer reservation does not
turn missing or completed operations into active work.
For unchanged bindings, both views check every claimed input's
head/tombstone/association metadata regardless of inventory pagination. A binding
conflict stops those input checks. Collection-wide transaction, writer, intake and prune
blockers suppress actionable hints. A fully inspected packet asks for a proposal
**or a disposition**; inspection alone implies no new knowledge. `selection`,
`claimHash`, and exact public `inputs` are top-level fields. Inventory omits the
legacy detailed `claim` projection returned by status; consumers should use the
public fields, not depend on private packet layout.
Malformed or changing metadata returns an error rather than a successful empty list.
Errors from a selected operation include its validated `operationId` for targeted
inspection; error text never includes corrupt record bytes.

Use a collection envelope and the same operation ID throughout a batch:

`processing-proposal` accepts `{selection, operationId, expectedClaimHash,
expectedProposalHash}` in `args`. It returns the exact reviewed proposal and
current originals, mappings, inspection and per-input source coverage, with
`interfaceVersion: 1`. Both hashes are required; changed inputs, notes, parents,
policy or proposal refuse the read. It holds only short validation locks and
creates no approval. Drafts plus originals are bounded to 4 MiB; native forms
have the smaller 256 KiB limit. Run this explicit draft read outside captured
work chats when avoiding echoed content. Use the unchanged save/recovery commands
below for standalone operation.

`processing-inventory` accepts `{selection, scope?, limit?, maxSessions?, after?}`.
It reads retained source, head, disposition and operation metadata across the
selected collection without reading native transcripts or raw evidence. `scope`
is `collection` (default), `repo` or `chat`. Repository scope uses the nearest
regular `.git` marker above the selected cwd; `PROCESSING_REPOSITORY_UNVERIFIED`
requires an explicit chat or collection scope when no repository can be established.
Each source must resolve to that same repository root; nested repositories are
outside the parent repository's scope. It does not infer a repository from a
route folder name.

Each source requires current explicit-processing authority. Excluded sources
remain excluded even when they were captured previously. The caller's selection
must itself be authorized for the collection. This command neither starts
collection nor changes settings. `limit` bounds returned head metadata (default
and maximum 100); `maxSessions` bounds visited sources (default 32, maximum 128).
Each source directory scan retains the existing 65,536-entry ceiling. Membership
checks for existing operations and the current page together read at most 256
distinct sources; larger requests fail with `PROCESSING_INVENTORY_CAPACITY`.
Return the exact `nextCursor` as `after` for another page; it binds the scope,
collection and settings revision. Cursor objects contain `{scopeHash, client, sessionId, unitId}`;
a null unit ID means that source was fully visited. Pages are lexical, not temporal.
An empty incomplete page is not evidence of an empty backlog. A cursor from a
different scope, collection or settings revision is refused with
`PROCESSING_INVENTORY_CURSOR_MISMATCH`; begin fresh discovery without that cursor.

The versioned response includes `scope`, `scopeHash`, `pending`, `operations`,
`blockers`, `intakeBlocked`, `counts`, `incomplete`, `nextCursor` and
`sourceCompleteness`. `excludedSources` counts settings-denied sources;
`outsideScopeSources` counts authorized sources outside the requested scope.
Counts cover the returned page only. Operations cover active claims and
same-collection writer transactions throughout the collection, independently of
that page; `scopeMatch` is `full`, `partial` or
`outside`. A narrow request cannot resume a partial or outside operation by
silently expanding its scope. Existing conflicts, proposals and recovery are
reported without resolving them, including intake/prune recovery. `intakeBlocked`
is only an observation of lock presence, not a recovery blocker or a stable
snapshot field. Read-only inventory can proceed during collection; mutations
still acquire the intake lock and validate current state. Claimless writer transactions retain their operation ID and recovery hash.
`sourceCompleteness: "unknown"` remains separate
from how much retained metadata was inspected. Discovery is advisory rather than
an atomic queue snapshot: pass exact returned `{identity, headHash}` references
to the existing workset or preparation commands, which revalidate evidence and
shared claims. A discovery result grants no permission to save notes.

1. `processing-pending`: `{selection, limit?, afterUnitId?}`. Reads bounded head,
   disposition and operation metadata, not raw bodies. Default limit 20, maximum
   100. Pages are lexical pagination, never chronological/native order. Each call
   scans at most 65,536 head-directory entries; a larger inventory returns
   `PENDING_INVENTORY_CAPACITY` without a partial cursor. Select a specific
   `unitId` to inspect it without enumerating the directory. Incomplete
   results remain incomplete; narrow selection if capacity is reached. The output
   includes existing claims, pending proposals/transactions and blocked intake.
2. `processing-prepare`: `{selection, operationId, inputs, reconsider?, budget?, parallelism?}`. Inputs
   are 1–20 exact `{identity: {client, sessionId, unitId}, headHash}` records.
   This verifies raw bytes and lineage, then reserves logical units. Explicit
   reconsideration can revisit handled heads; it is not an automatic retry flag.
   New admissions default to 5 inputs and 64 KiB packet bytes. An explicit
   `budget: {maxInputs, maxPacketBytes}` can select 1–20 inputs and 1–4194304 bytes.
   Larger singletons require that explicit choice. `parallelism` defaults to 1
   active inspection, with a maximum of 5; it applies across the collection, not
   just this session or workset. A separate fixed cap allows five durable proposal
   intents (staging or published); resuming an existing intent does not need another slot.
   Budget rejection publishes no claim. Known capacity errors return numeric
   details; admission blockers can include bounded `operationIds` for status.
   A measured byte rejection also reports `inputSizes: [{index, packetBytes}]`:
   each original request index's standalone packet cost, including framing. This
   identifies oversized revisions without repeated singleton reads, including when
   the combined packet exceeds the 4 MiB hard ceiling. Inventory
   remains metadata-only and cannot estimate unmeasured raw bodies.
3. `processing-page`: `{selection, operationId, expectedClaimHash, page}`.
   Page indexes start at zero. Read the complete returned evidence page.
4. `processing-ack`: `{selection, operationId, expectedClaimHash, pages}` where
   pages are the issued `{index, hash}` pairs. Use the latest claim hash returned
   by each call. Delivery is not acknowledgment; unread pages must not be acked.
5. Synthesize useful notes using the [skill](../SKILL.md), selected source facts,
   relevant existing notes and prior associations. Prepare any
   [note metadata](#prepare-note-metadata) before staging complete Markdown in a
   private proposal file; fingerprint it and the inspected target.
6. `processing-propose`: `{selection, operationId, expectedClaimHash, proposal?}`.
   Omit `proposal` only to resume the existing immutable staging intent; an initial
   proposal is required. Existing copied bytes can resume without the original
   draft file, but changed/missing required bytes remain a conflict.
   Proposal is `{files, mappings, mode?, expectedManifestHash?}`. Each file has
   `{path, expectedHash, contentPath, expectedContentHash}`. Each input mapping has
   `{identity, paths: [relative output paths]}`. Every input/output must be mapped.
   Authored is the default. Derived requires its exact manifest hash and existing
   parents. Proposal staging creates no notes or category folders.
7. Apply the [consent rules](../SKILL.md#processing-consent-and-outcomes).
   `processing-save`: `{selection, operationId, expectedClaimHash,
   approvedProposalHash, trigger}`. Trigger `approved` means an explicit save request
   or approval of that exact proposal; `automatic` additionally checks every
   applicable Automatic source route. Never infer user approval from a hash.
8. Or `processing-complete`: `{selection, operationId, expectedClaimHash, outcome,
   expectedRecoveryHash?}`.
   Outcome is `unchanged`, `skipped`, or `cancelled`. Unchanged requires all pages;
   skipped suppresses exact heads; cancelled releases an unapplied operation.
   To cancel a pending transaction, supply its recovery hash from
   `processing-status`. This works only before a writer journal or receipt exists;
   staged/applied writes remain recovery conflicts. Cancellation preserves notes.
   At unchanged configured placement, cancellation also permits a changed physical
   binding: it records the original namespace and writes no dispositions. Exact
   cancellation receipts can resume metadata cleanup with `processing-recover`.

Do not prepare or synthesize another copy when a claim/proposal is already pending.
`processing-status`: `{operationId}` returns current operation/recovery state.
`processing-recover`: `{operationId, expectedRecoveryHash}` uses its exact inspected
hash. Completed save receipts can finish bookkeeping without modifying later user
edits; incomplete writes require current input/policy/output checks. See
[processing](processing.md) for durable protocol and coverage limits.

## Draft reinspection

Use these standalone commands only after the user's explicit decision to inspect
and adopt the current configured storage for a retained unapplied proposal. See
[eligibility and limits](processing.md#reinspect-a-retained-draft-after-storage-changes).
All use the ordinary collection/configuration envelope.

- `processing-reinspection-preview`: `{selection, operationId,
  replacementOperationId, expectedClaimHash, expectedProposalHash}`. Obtain the
  old hashes from `processing-status` and choose a fresh replacement UUID.
  Returns `previewHash`, previous/current bindings and directories, exact
  original/proposed text, source coverage and mappings. Read-only; no Save authority.
- `processing-reinspect`: the same args plus `expectedPreviewHash` from that
  reviewed preview. Rechecks the exact inputs and destinations, archives the
  preserved text, creates an unread replacement claim, and cancels the old claim
  without disposition. Returns `status: "transferred"`, the replacement ID and a
  `proposal` request whose `contentPath` values refer to the private archives.
  Follow `processing-status`, `processing-page`, `processing-ack`,
  `processing-propose`, `processing-proposal`, then separately approved
  `processing-save`. Transfer itself never saves notes and respects default
  parallelism of one unpublished claim. Original claim metadata and draft bytes
  are archived separately. Completed transfers retain both indefinitely;
  abandonment retains the claim archive and removes only verified draft copies.
- `processing-reinspection-status`: `{operationId?}`. Without an ID, discovers
  the one pending transfer; with the original ID, returns its pending or archived
  record, even while a different transfer is pending (`otherPendingTransfer`).
  `state` is `missing`, `transfer-pending` or `transferred`; present records
  include `recordHash`, `conflict`, exact retry `args`, `canAbandon`, `abandoning`,
  archive location/count/retention in `retainedDrafts`, and `nextAction`. This is
  metadata-only and does not grant new consent. Completed transfer is historical,
  not proof that its replacement remains pending or has been saved.
  Without an ID, a different collection's writer reservation instead returns
  `state: "reserved"`, `blocker: "writer-reserved-by-another-collection"` and
  `nextAction: "inspect-owning-collection"`, with no local retry args.

- `processing-reinspection-abandon`: `{expectedRecordHash}` from reinspection
  status. Only before a successor claim exists: archive the exact intent, remove
  only its matching owned copies and release the transfer blocker. The original
  durable draft must still match before an archived copy is removed. A missing
  original is first restored from the exact archive; an edited original reports
  `PROCESSING_PROPOSAL_CHANGED` and preserves both versions and the pending intent.
  When no archive exists, a missing or edited original keeps the intent pending
  with the same conflict.
  The original claim and all notes and evidence remain unchanged. The same request resumes
  interrupted abandonment; it never creates or approves a replacement. Once a
  successor exists, finish transfer bookkeeping instead.

An interrupted transfer reports `PROCESSING_REINSPECTION_REQUIRED`. Before its
replacement claim exists, retry requires the same policy, binding and evidence;
otherwise explicitly abandon it. After the claim exists, the exact request can
finish metadata under current maintenance authority without saving notes. During
this interval, session pending inventory and frozen workset-input views refuse
with that code; collection and shortcut inventory report the blocker and incomplete
discovery. Do not treat an empty returned page as an empty queue. `PROCESSING_REINSPECTION_CHANGED` means the
reviewed intent or current binding no longer matches; inspect before deciding.
`PROCESSING_REINSPECTION_ABANDONING` requires finishing the exact abandonment,
and `PROCESSING_REINSPECTION_COMMITTED` refuses abandonment once a successor or
completion exists. Malformed or tampered state remains blocked for integrity review.
`PROCESSING_REINSPECTION_NOT_REQUIRED` means bindings and parents still match,
so use ordinary inspection/review. `PROCESSING_REINSPECTION_CONFLICT` means the
selected IDs or archive destinations are already occupied; preserve their state.

## Finite processing worksets

These version-1 commands use the same collection envelope, private processing
state, claims, proposals and writer as ordinary processing. They invoke no model.
Prepare a deliberately bounded list from inventory; pagination is not a globally
atomic snapshot. Workset IDs are UUIDs. Nothing automatically extends a workset.

- `processing-worksets`: `{selection?, limit?, afterWorksetId?}`. Rediscover saved
  worksets after losing conversational context. Default page size 20, maximum 100;
  scans at most 65536 filenames. Results include IDs, inspected hashes, selection,
  creation time, input count and charged budgets, never raw bodies. The lexical
  cursor covers examined workset files; selection/binding filtering can yield an
  empty page with `incomplete: true`. Continue its cursor. Use a returned ID with
  status rather than opening private files. `policyState` and `conflict` report
  whether settings changed; see the policy-change handling below.
- `processing-workset-create`: `{selection, worksetId, inputs, runBudget?,
  unscannedRemainder?}`. Freeze 1–100 exact `{identity, headHash}` inputs.
  `runBudget: {maxBatches, maxPacketBytes}` defaults to 5 batches and 327680 bytes;
  maximums are 20 batches and 16777216 bytes. `unscannedRemainder` is a caller's
  inventory limitation (boolean or null/unknown), not proof the whole queue was
  enumerated. Exact creation retries return the existing workset without resetting
  progress when the saved settings hash still matches. Changed settings return
  `WORKFLOW_POLICY_CHANGED`; changing a selection requires a new explicit workset.
- `processing-workset-prepare`: `{worksetId, expectedWorksetHash, indexes,
  batchBudget?, parallelism?, acceptPolicyChange?}`. Select 1–20 unique zero-based indexes from the
  frozen list. `batchBudget` has the same shape/limits as preparation's `budget`.
  A byte-budget error returns `inputSizes[].index` as the frozen workset index
  (0–99), irrespective of request ordering. Workset and batch budgets both apply;
  a new workset cannot bypass collection admission. The engine derives the same operation ID from the same index set.
  After a settings change, `acceptPolicyChange: true` explicitly permits only a
  new batch of unattempted inputs under the request's current config hash. The
  default is false. Frozen inputs, total charges and earlier admission policies
  stay intact. Every input still needs current permission. The flag cannot renew
  an existing claim or a charged pre-claim admission; those retain their exact
  old policy. Retrying a new batch already admitted under the current hash does
  not need the flag again. This is not authorization to change settings.
  Use the returned ordinary processing claim for page/ack/propose/save/complete.
  Admission intent charges actual packet bytes before publishing the claim. An
  interrupted admission resumes only its exact selection and packet, without a
  second charge; inspect the workset for its current hash before retrying. A
  completed operation is inspected/recovered, never prepared as a fresh save.
- `processing-workset-status`: `{worksetId}`. Metadata-only progress over the
  frozen selection. `policyState` is `current` or `changed`; `conflict` is null
  or `WORKFLOW_POLICY_CHANGED` relative to the creation policy. Individual batches
  admitted under current consent can still proceed; each operation reports its own
  state. Reports per-input states, operation states, charged and
  remaining budgets, `operationCounts`, `outcomeCounts`, `inputCounts`, `remainingSelected`, and
  `budgetExhausted`. Collection-wide `blockers` remain visible even when no
  operations remain in the workset; an empty operation list does not prove that
  writer recovery is complete. Operation counts are not note counts; input counts
  are not global queue totals. Each count group is a separate dimension with disjoint
  buckets; do not sum groups together. Operation progress distinguishes recovery,
  terminal, review, blocked, admission-pending and inspection. Outcomes distinguish
  saved, unchanged, skipped and cancelled; cancelled is terminal but **unhandled**.
  Exact dispositions from other operations appear as `handled-elsewhere`, with
  their operation IDs/outcomes. Foreign claims block admission rather than appearing
  as available work. `remainingSelected` counts unattempted, blocked and cancelled-but-unhandled revisions,
  excluding exact revisions already handled elsewhere. `remainingPacketBytes` does not prove another revision
  fits; actual packet measurement remains mandatory. `sourceCompleteness` is
  unknown in this metadata view. An interrupted pre-claim admission is exposed
  as `admissionPending`; it is not a completed or reserved capture. If those inputs
  were subsequently claimed/handled elsewhere, it reports the specific blocker.

Follow status to resume the same operation, review a proposal, or inspect a
conflict. Finish each batch before claiming another. All retained pages still need
explicit acknowledgement, even for apparently identical text. `unchanged` is a
successful knowledge outcome; `cancelled` leaves evidence unhandled. Neither
outcome causes the engine to chase newly arriving captures. Stop when the run
budget stops new admission or review is needed, and report unattempted, blocked
and cancelled-but-unhandled inputs.
Existing operations and already charged admissions remain resumable at an exhausted
budget while their policy and inputs remain valid. Settings changes do not renew
workset consent: exact create retries fail, and status/listing disclose the stale
policy. Follow [policy-change handling](processing.md#resume-and-reconcile-a-workset)
for explicit new-batch consent, cancellation and committed recovery; do not
refresh stored hashes or reset charged budgets.
Workset files are helper-managed plans and do not prevent authorized pruning.

## Direct saves

A direct request to save supplied material needs neither collection nor native IDs.
Inspect the exact destination and relevant existing notes, then use `fingerprint`
and `inspect-notes`. A conversation-only summary does not authorize a file write.

`direct-save` takes its own request: `{plan, approvedPlanHash, collectionId?,
expectedConfigHash?}`. Supply both optional collection fields for a configured
collection; they bind the same destination and shared writer. Without configuration,
the user must select the destination and persistent writer state. Never use another
writer to avoid a conflict. `approvedPlanHash` is SHA-256 of canonical JSON of the
concrete inspected plan, using `canonicalJSON` and `digest` from `workflow-values.mjs`.
The hash binds content; the user's instruction supplies authority.

A normal authored plan is `{version: 2, mode: "authored", root, stateDir, files,
directories, createDirectories}`. Use parent fields
from `inspect-notes`; each file has relative `path`, inspected `expectedHash`,
absolute staged `contentPath`, exact `expectedContentHash`, and optional inspected
`sources`/section `entries`.

An explicit file destination uses an authored version-1 plan with its existing
parent as `root`, the selected filename, and no directory-creation fields. This
allows a home-level note beside private writer state without treating the entire
home directory as a notes folder. Processing builds this plan automatically.

Custom/deeper existing paths and derived ownership follow [safe updates](refresh.md).
The writer rechecks actual proposal bytes and inspected note/parent state, preserves
user edits and pending transactions, and verifies its output. A direct save creates
no fake capture, processing claim or capture disposition.

## Prepare note metadata

`prepare-note` uses its own request, with no collection envelope or configured
workflow requirement:

```json
{
  "original": null,
  "content": "# Synthetic planning\n\n## Decision\n\nReview the prototype first.\n",
  "now": "2026-10-01T07:42:00-07:00",
  "skillVersion": "0.9.0",
  "metadata": {
    "type": "meeting",
    "sources": [{"type": "document", "ref": "selected/planning.md"}],
    "context": {"project": "synthetic-project", "topics": ["prototype"]}
  },
  "contentHash": true
}
```

These dates, version and sources are illustrative. Use the actual note-update
time, generating skill version and selected source descriptors. `original` is
null only for a new note; otherwise supply its complete inspected Markdown.
`content` is the complete reconciled proposal, either with no metadata block or
with the original block unchanged. Supply supported metadata changes separately
in `metadata`: optional `type`, `sources`, `context`, `series`, `sprint`, `period`.
Nested context/series/period additions use their defined keys. Identity and
generation fields are managed by the helper. Unknown existing fields are retained.

`createSeries: true` explicitly creates a new `series_` UUID when the note has no
established series. Optionally supply `metadata.series.label`, but omit its `id`.
The default does not generate a series ID: to join an existing series, supply its
inspected `metadata.series.id`. Creation with an existing series or a supplied ID
fails with `NOTE_METADATA_SERIES_CONFLICT`; the helper never replaces either ID.
This flag also works for an existing supported note without a series, or for a
plain note with explicit enrichment. It cannot modify opaque future metadata.
Reuse the returned ID for later members and the prepared bytes for save retries.

`enrich: true` explicitly permits adding metadata to an existing plain note;
the default preserves its plain format. `contentHash: true` requests the optional
body hash; a pre-existing hash is maintained regardless of this flag. Source
additions keep earlier descriptors. See the [metadata contract](note-metadata.md)
for bounds, conflicts and opaque future schemas.

The result is `{content, changed, metadataStatus}`. It writes nothing, reads no
note/source/configuration paths, resolves no workflow defaults, starts no storage
permission probes and grants no save authority. Invalid metadata inputs return a
bounded `NOTE_METADATA_INVALID` error. Source-list or serialized-byte exhaustion
instead returns `NOTE_METADATA_SOURCE_CAPACITY` or `NOTE_METADATA_BYTE_CAPACITY`
with an allow-listed numeric `details` object containing `current`, `proposed`,
and `limit`. See [capacity meanings and warnings](note-metadata.md#generation-and-safe-updates).
No source values or arbitrary exception details are included. Save returned content
to a private proposal file, inspect the diff and fingerprint those exact bytes
before approval. Reuse a prepared new-note proposal rather than generating another
ID on retry. A no-op keeps original bytes. It does not verify the factual quality
or preservation of proposed prose; the agent must reconcile that against the
inspected original. The existing save checks still reject stale whole-file hashes.
Each original/proposed Markdown string remains limited to 2 MiB UTF-8, and the
metadata block remains limited to 64 KiB; the larger request envelope does not
expand note or metadata limits.

For capture processing, translate each mapped claim input into a session descriptor:
`identity.client` → `client`, `identity.sessionId` → `session_id`,
`identity.unitId` → `unit_id`, and full `evidenceHash` → `revision`.
Optional `source_hash` is `sha256:` plus `fileHash`. Include every input mapped
to this note and retain older descriptors. Do not use shortened filenames or the
growing native transcript hash. Supported metadata with missing or unrelated new
session sources is rejected by `processing-propose`; plain/future-schema notes
remain supported. Metadata does not replace the private proposal mappings.

## Explicit maintenance

`storage-status` takes empty args and performs a deeper bounded inventory; it may
read raw evidence. `prune-preview` takes `{identities, before?}` and reports an exact
reviewable plan. `prune-apply` takes `{reviewed}`; `prune-recover`/`prune-abandon`
take `{expectedPlanHash}`. Only eligible processed terminal captures can be pruned;
unknown files, active work, derived dependencies and current Claude unconfirmed
snapshots stay protected. No automatic retention or rebuild is implemented.

`intake-recovery-status` takes empty args. `intake-recover` takes `{reviewed, offline}`
using the returned plan and the explicit offline conditions in
[session-workflow](session-workflow.md#blocked-intake-and-explicit-recovery).
Neither user confirmation nor a PID check creates OS exclusivity. Live or uncertain
owners, changed locks and pending conflicts are retained. Never delete or steal a
writer lock. Maintenance is an explicit operation, not a remedy to run silently.

## Windows settings discovery

See [Windows storage selection](setup.md#windows-storage-selection) for defaults,
override precedence, existing-store preservation and the environment used by hooks.

`status` and `configure` add `requestedConfigPath` and `resolvedConfigPath`.
`status` keeps the normalized requested `configPath`; `configure` keeps the resolved
`configPath`. Ordinary Windows `status` inspects only the
selected settings path and its package origin. `{ "diagnostics": true }` also
inventories the known default/package-cache settings locations and inspects the
configured collections' root paths and physical identities. It does not read other
settings bodies, captures, or notes, and an incomplete inventory is reported as incomplete.

Fresh setup and changes to projects, collections or storage destinations compare
bounded, validated settings from those locations before writing. Overlapping
project, note or private-storage bindings are refused. An explicit disjoint
configuration is permitted; explicit selection cannot bypass a conflicting store.
Storage already identified by the selected settings remains usable: a bounded
metadata walk distinguishes its ancestors and private roots from unexplained
siblings, without reading private-root contents or adopting unknown state.
Ordinary policy changes and removals keep working without that inventory.

`WINDOWS_PACKAGE_STORE_FROZEN` means a package-backed settings file or private
root needs a missing store created. Existing prepared collections can continue,
but additions requiring missing roots await separate migration support.
`WINDOWS_STORAGE_SHADOW_CONFLICT` means an AppData path has a package-cache
counterpart that could hide another store. Keep the existing files; do not delete
state, change permissions, or choose fresh paths to bypass these errors.
Incomplete discovery or changed candidate settings also stops setup. Inspect the
reported paths and resolve access or concurrent changes before reviewing a new
request. Discovery does not lock every configuration across clients, so it cannot
make independent cross-config setup operations atomic. Each discovery pass retains
finite entry/byte bounds and a 30-second deadline checked between filesystem
operations; an outer worker deadline, if present, still takes precedence.

Setup pins resolved paths for the operation. `PRIVATE_STORAGE_REDIRECTED` means
creation or staging changed a path mapping; activation is refused. A failed setup
can leave newly created empty directories. Preserve those objects for inspection
instead of retrying automatically or selecting their redirected paths. A changed
mapping is not authorization to adopt a different store.

New Windows private directories require a parent whose write permissions are
limited to the current user, SYSTEM and Administrators. `PRIVATE_PARENT_UNSAFE`
refuses creation beneath a shared writable parent; do not loosen its permissions
or select another store to bypass a conflict. Existing folders receive no
permission edits. A separate mechanism for secure creation under shared parents
is not included.

| Setup error | Meaning and next step |
| --- | --- |
| `WORKFLOW_CONFIG_SELECTION_REQUIRED` | Both implicit defaults name different settings files. Inspect and select the intended settings for the command; hooks also need the client environment override described in [setup](setup.md#windows-storage-selection). Never merge or delete stores automatically. |
| `WORKFLOW_CONFIG_UNAVAILABLE` | A selected/default path is unsafe, unreadable or changed during inspection. Do not treat it as absent and create another configuration. |
| `LOCAL_STATE_LOCATION_REQUIRED` | Required local path facts are missing or the only fresh candidate is a network profile. No fallback store is selected. |
| `PRIVATE_PROFILE_UNVERIFIED` / `PRIVATE_PROFILE_UNSAFE` | Native profile policy cannot be established or is unsupported for the private location. Preserve settings and data; inspect profile policy rather than enabling capture or relaxing checks. |
| `PRIVATE_CONTENT_INDEXING_REQUIRED` | A private profile path lacks NotContentIndexed. Verification does not repair existing files; review storage before continuing. This is separate from an optional raw-folder visibility warning. |
| `WINDOWS_EXISTING_SETTINGS` | Implicit fresh setup found other settings. Inspect their paths before explicitly selecting an existing setup or a disjoint new one. |
| `WINDOWS_SETTINGS_OVERLAP` | Another configuration owns overlapping project, notes or private-storage paths. Preserve it; do not create a second writer or move paths to bypass ownership. |
| `WINDOWS_SETTINGS_UNRESOLVED` | Discovered state or another settings file could not be explained or validated. Inspect the reported location; a newer schema may require a plugin update. |
| `WINDOWS_SETTINGS_INSPECTION_LIMIT` | Bounded settings or metadata inspection exceeded its limit. Setup did not complete; preserve the existing stores. |
| `WINDOWS_SETTINGS_DISCOVERY_INCOMPLETE` / `WINDOWS_DISCOVERY_TIMEOUT` | The package inventory or inspection could not finish. Diagnose access or host load before trying a newly reviewed request. |
| `WINDOWS_SETTINGS_CHANGED` | Candidate identity, contents or bindings changed during setup. Inspect the current state before reviewing another request. |

## Supported consumer boundary

Use the [supported read interface](#supported-read-interface) and explicit command
schemas above. Do not parse private files to infer state or maintain another claims,
receipts, approval or writer database. The plugin remains usable without an app.

Read-only processing commands are `processing-capabilities`, `processing-pending`,
`processing-inventory`, `processing-status`, `processing-worksets`, and
`processing-workset-status`.
They describe capabilities or metadata progress. `processing-page` is mutating:
it records issued pages and can change the claim hash, even without acknowledgment.
Page/ack requires explicit processing authority and coordination with the owning
operation. A read-only consumer must not call page/ack, claim inputs, stage drafts,
write notes or mutate settings. Delivery is not inspection. The CLI cannot attest that a person or model read a page.
All mutation commands retain current consent, exact hashes and conflict/recovery
checks. Proposal hashes are identifiers, never consent. Selection and source
locators do not grant access to unrelated evidence.

`INVALID_PROCESSING_MARKDOWN` retains its code and may include a bounded fixed
`reason`, including correction guidance for the reserved Cuefluent metadata marker.
It never returns proposal text. Writer rejections retain `SAFE_UPDATE_REJECTED`.
Use current operation status after a failed mutation; do not infer that an error
means no durable commit occurred. See [processing](processing.md) for resume,
source-completeness and outcome semantics. Live automatic processing, model
selection, app controls and scheduling are not supplied by this interface.
