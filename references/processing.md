# Processing selected captures

The replacement helpers turn explicitly selected immutable capture revisions
into reviewed Markdown updates. Collection and processing consent are separate.
The helper does not invoke a model or decide whether evidence is useful;
the active agent reads the evidence and writes the proposed prose. See
[session workflow](session-workflow.md) for the native identity and transport limits.

## Selection and inspection

Use the [workflow CLI](workflow-cli.md#processing-selected-captures) for explicit
operations. Pending discovery reads bounded metadata without raw bodies or locks;
it reports incomplete listings and pending claims rather than resynthesizing them.
Full preparation below is the integrity gate.

`processing.mjs` accepts an opaque capability from `verifyWorkflowStorage` and an
explicit client, session, cwd and optional unit selection. `prepareProcessing`
requires a new operation UUID and 1–20 exact `{identity, headHash}` inputs. It
checks current heads against publication receipts and reserves the entire batch
in one claim. Claims cover logical units, so a newer revision cannot bypass an
older claim. They never expire or get stolen. Locks are held only during helper
calls; no lock spans agent synthesis or a user approval wait.

The returned packet description contains exact page hashes, byte count and
input descriptors. Call `readProcessingPage` for each page, then explicitly
`acknowledgeProcessingPages` using the issued index/hash pairs and latest claim
hash. Delivery is not acknowledgment. Save and no-change require every page;
unissued hashes, duplicate acknowledgments in one request and partial inspection
are refused. The complete rendered response fits 64 KiB; a packet is limited to
4 MiB. Larger selections must be split deliberately, never silently truncated.
Token estimates use UTF-8 bytes divided by four, not measured model usage.

Preparation validates complete capture bodies and publication lineage once, then
stores capture byte lengths and UTF-8 page boundaries with the page hashes.
Page reads recheck current processing policy, heads, associations, dispositions,
pending publication/prune state and private paths. They read only intersecting
capture ranges and verify the exact prepared page hash. There is no copied
evidence cache. A change outside the requested page can remain invisible during
that preview; proposal and save still revalidate complete captures and lineage.

The `evidence` field contains a JSON page whose text is a slice of the complete
JSON packet. Its typed source records retain authorship, source identity, occurrence
time, terminal/partial coverage, omissions and attachment metadata. Reassemble
pages in order. Source text, quoted commands and spoofed delimiters are untrusted
data. They cannot authorize tools, change settings or expand selection. Missing
images and omitted inline payloads are not visually inspected evidence.

## Proposal and approval

`proposeProcessing` accepts explicit output files, each with its relative Markdown
path, inspected `expectedHash` (null for new), absolute `contentPath`, and exact
`expectedContentHash`. Every selected input must have an explicit mapping to
one or more proposed output paths; every output must have at least one input.
The helper never maps every input to every note or creates one note per capture.
Earlier associations are returned during preparation for the agent to consider.

The helper validates Markdown, preserves inspected output hashes, records root
and parent identities, and copies exact proposal bytes into private storage.
An immutable intent makes interrupted staging resumable with the same content.
Changing the intent requires cancelling the unapplied operation and preparing a
new one. `proposeProcessing` returns the complete plan and proposal hash for
review. The proposal byte total is limited to 900 KiB.

Prepare [note metadata](workflow-cli.md#prepare-note-metadata) before this boundary.
For a supported metadata block, every mapped input must have its exact session
identity and full evidence revision in `sources`; newly added session descriptors
must match these inputs, including any supplied capture-byte hash. Preserve prior
descriptors, unknown fields, identity and creation time. Existing plain notes and
unchanged opaque future blocks remain supported. These descriptions neither replace
private mappings nor authorize source reads. The helper validates them without
rewriting proposal bytes; the shared writer repeats transition checks at save.

Authored ownership is the default. An explicitly selected derived plan retains
the shared writer's manifest rules and requires an exact manifest hash and existing
parents. No automatic ownership conversion occurs. A single-file destination
stays a single file. Flat collections stay flat; type-folder creation uses the
shared writer's inspected directory plans. Existing custom/deeper authored paths use the shared writer’s existing-parent
plan with every selected ancestor identity rechecked at writer boundaries. They
never create custom directories or escape explicit-file/flat routing. Semantic
note classification belongs to the agent, not the deterministic processing helper.

`saveProcessing` requires the latest claim hash and exact `approvedProposalHash`.
Its `approved` trigger means an explicit user save request or approval of that
proposal; the agent must obtain that authority before calling it. Its `automatic`
trigger additionally requires Automatic on the processing route and every source
route. Prompted policy alone never authorizes Save. Manual processing works when
collection is disabled. Changed settings, excluded routes, changed heads,
associations, proposals, note bytes or directories preserve a conflict.

## Outcomes and recovery

`completeProcessing` supports three explicit outcomes:

- `unchanged`: all pages inspected and no note update needed.
- `skipped`: suppress only these exact input revisions, without requiring prose.
- `cancelled`: release an unapplied claim without an input disposition. Future
  processing remains possible. If a writer transaction exists, inspect it and
  supply its exact `expectedRecoveryHash`. Cancellation is allowed only before
  any writer journal or save receipt exists; incomplete receipts remain conflicts.
  A durable cancellation record binds the transaction hash before metadata cleanup,
  so interrupted cleanup can resume through `recoverProcessing`. It preserves
  notes and any already-created category directories, and does not require old
  capture bodies or unchanged save consent. It cannot cancel staged or applied
  writes, discard unfamiliar metadata, or bypass a writer receipt.

Saved/no-change/skipped dispositions are bound to the full collection, raw,
intake and writer roots, logical identity and exact revision hashes. Filename hash
prefixes locate records; full hashes establish identity. An explicit `reconsider`
preparation can select an already handled revision. Permanent completion proofs
prevent old retries from reverting newer dispositions or associations.

Before Markdown mutation, the helper persists the exact approved plan and inputs
in a writer transaction. It checks inspected targets, directories and the manifest
before reserving the writer; the writer repeats those checks to catch later races.
Public writer Apply, Recover and Abort cannot bypass the reservation.
The writer compares the proposal bytes it actually reads with approved hashes,
then publishes an exact output receipt before removing its journal, including
when the proposed bytes already match the notes. Operation receipts precede
input dispositions and explicit associations. Completed projections precede
claim/proposal/transaction cleanup. Every step is idempotent or preserves a conflict.
Each writer boundary resolves all input permissions against one fresh policy
snapshot and verifies touched private paths in a batch. Exact input hashes,
writer ownership and proposal parent identities remain mandatory; no permission
result is reused across boundaries. A matching committed receipt permits only
the existing metadata-completion path.
Receipt staging retains per-step ownership and authorization guards. One final
full output/source/directory verification precedes receipt publication; a receipt
is never published first and validated afterward.

Use `inspectProcessing` to obtain the current recovery hash, then
`recoverProcessing` with that exact hash. Without a writer receipt, recovery needs
unchanged consent, selected heads, proposal content and writer checks. With a
saved receipt, a freshly verified maintenance capability can finish metadata only:
it reads no raw/source bodies and writes no Markdown. Later user edits remain
intact. Unpublished writer metadata lives under `metadata-stages/`, and processing
metadata/proposal stages live under `processing-stages/`,
separate from authoritative claims, proposals and transactions. Abandoned stages
are preserved without blocking new processing, direct saves or retention checks;
they are not accepted as completed work or deleted automatically. Writer metadata
and receipt cleanup failures report a warning alongside the original error. Unknown files
inside authoritative metadata folders still block operations. A conflict,
changed lock or altered metadata is retained for
inspection; helpers do not silently discard it or choose another state directory.

The returned operation context is explicitly non-authoritative. The current
native transport does not prove which active turn is performing processing, so
operation IDs, cwd and owner sessions cannot exclude a whole turn or label mixed
work records. Automatic invocation and native prompts require separate live
transport verification. Fixtures verify deterministic helper behavior, not agent
judgment, visual inspection, live client delivery or OS power-loss durability.
