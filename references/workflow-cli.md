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
| `processing-chat-run` | `{client, requestId, selection, expectedChatHash}`; exact status hash, or null for a missing binding; handles at most one bounded operation |
| `processing-chat-reconcile` | `{client, requestId, expectedChatHash}`; reinspects a known terminal's unresolved operation, or verifies an exact sealed Codex completion, failure or interruption; live owners and unproven outcomes remain blocked |
| `processing-chat-abandon` | `{client, requestId, expectedChatHash, offline: true}`; explicitly retires a creating/busy run or unknown creation/dispatch outcome after the operator stops its controller and native child; refuses live or unverified owners and preserves all engine work |
| `processing-chat-reauthorize` | `{client, expectedChatHash, previousPolicyHash}`; explicitly accepts current settings for the registry, preserving existing engine claims and proposal hashes |
| `processing-chat-rollover` | `{client, expectedChatHash}`; archives settled request history while retaining the same native chat and exact-request replay protection |

`client` is `codex` or `claude`; `requestId` is a new UUID for each explicit run,
reused for retries of that exact request. A duplicate never dispatches again.
`state` is `missing`, `creating`, `idle`, `busy`, `awaiting-review` or `blocked`.
`chatHash` binds registry mutations; `policyHash` exposes the registry's accepted
settings hash for explicit reauthorization. `nativeStatus` distinguishes a completed,
failed or interrupted native run; null means no terminal is available for the
current state. `operationId` points to authoritative engine
status. `chat` identifies the native session, while `desktopVisibility` remains
`unverified`. Neither `idle` nor a native completed turn means a note was saved.
Busy or blocked state must not be bypassed with another binding or writer.
`processing-chat-abandon` archives the exact binding and returns blocked status
with `RUN_ABANDONED`. It does not cancel an engine operation or mark its evidence
handled. Inspect any surviving operation before continuing. Only a subsequent
explicit run with a new request ID creates a replacement native session; the
abandoned request can never dispatch again. `offline: true` records the operator's
confirmation that both the controller and native child are stopped, including
for older records with no saved owner. It is not a model-selected retry flag.

The installed `cuefluent_control` MCP server exposes three strict tools:

| Tool | Arguments |
| --- | --- |
| `processing_status` | `{collectionId?, retryToken?}` |
| `process_selected_captures` | `{collectionId?, selection?, requestId?, retryToken?}` |
| `processing_review` | `{collectionId?, retryToken?}` |

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
active or paused selection, explicit capture scopes, or a processing-only hook
binding. Processing-only bindings record a locator and future byte boundary under
the current policy; they never enable collection. The explicit request verifies
the native source header and exact call within the bounded recent range.
Omitted collection selection must resolve uniquely from bounded registration
metadata; no new source is discovered. Omitted evidence `selection` selects the
source session, not just its control turn. A formal skill control rejects a
selection that differs from its verified source. Other explicit selections still
require existing policy. MCP dispatch identity derives from the verified native
session and call ID: redelivery replays, while another invocation is new even if
the model repeats its optional `requestId` hint. The returned `requestId` is the
authoritative controller identity. CLI request IDs remain explicit as described
above. Native tool namespaces can add client-specific prefixes.
Outputs are versioned bounded status with `statusText`, `status`, `requestId`,
`collectionId`, `chat`, `nextAction` and diagnostic codes. They contain no evidence
or draft text. Tool arguments accept no approval or source-proof object.
If the engine disposition committed but registry or receipt bookkeeping failed,
the response is `completed` with `nextAction: "inspect"` and a bounded diagnostic.
Inspect the existing operation; do not repeat its save. That response does not
claim successful capture-exclusion bookkeeping.
`processing_review` sends the exact proposal through the correlated native host
form; an unsupported or closed form preserves the pending proposal. A model's
tool arguments cannot substitute for that host response.
The control server supports MCP `2025-11-25`, including the string defaults needed
by native review. It offers this version even when the client's initial request
names an older one. Clients unable to accept it cannot use this MCP server and
must use the explicit CLI commands; clients accepting it without form capability receive
`PROCESSING_REVIEW_UNSUPPORTED` for review. See
[MCP version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#version-negotiation).
The form uses a short header, a required `changes` string containing
the complete readable preview as its default, and a required `decision` enum (`save`, `skip`,
`cancel`, `later`) without a default. An accepted host response must echo the
unchanged preview plus the chosen decision, allowing LF/CRLF/CR line-ending
conversion only. Changed, trimmed or collapsed text produces
`PROCESSING_REVIEW_PREVIEW_CHANGED`; it cannot revise or authorize different note
bytes. Quoted note-content lines, escaped controls and per-file line-ending
summaries distinguish source text from review structure without changing saved bytes.
The outgoing form is bounded to 256 KiB. Incoming frames allow up to six times
that size for host JSON escaping, even after a form closes; ordinary MCP requests
remain bounded to 64 KiB. Late or unknown response IDs are ignored within the
framing bound. A correlated response whose normalized preview exceeds 256 KiB
refuses only that review with `PROCESSING_REVIEW_TOO_LARGE`. Frames exceeding the
hard framing bound still close the connection. Host decline/cancel responses leave
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

### Supported read interface

`--help`, `processing-capabilities`, `processing-pending`, `processing-status`,
`processing-worksets`, and `processing-workset-status` advertise `interfaceVersion: 1`.
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

Inventory `counts` apply only to the returned head page (`scope:
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
Both views check every claimed input's head/tombstone/association metadata regardless
of inventory pagination. Collection-wide transaction, writer, intake and prune
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

Do not prepare or synthesize another copy when a claim/proposal is already pending.
`processing-status`: `{operationId}` returns current operation/recovery state.
`processing-recover`: `{operationId, expectedRecoveryHash}` uses its exact inspected
hash. Completed save receipts can finish bookkeeping without modifying later user
edits; incomplete writes require current input/policy/output checks. See
[processing](processing.md) for durable protocol and coverage limits.

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
  `budgetExhausted`. Operation counts are not note counts; input counts are not
  global queue totals. Each count group is a separate dimension with disjoint
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
`processing-status`, `processing-worksets`, and `processing-workset-status`.
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
