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
are rejected. `status` and `defaults` can omit a request; other commands require one.
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
| `status` | `{selection?}`; reads settings and bounded package diagnostics, optionally resolves a route; no writes |
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
| `capture-status` | `{selection, sourcePath?}`; returns selection/hash and optional source metadata/EOF without reading transcript bodies |
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

## Processing selected captures

Use a collection envelope and the same operation ID throughout a batch:

1. `processing-pending`: `{selection, limit?, afterUnitId?}`. Reads bounded head,
   disposition and operation metadata, not raw bodies. Default limit 20, maximum
   100. Pages are lexical pagination, never chronological/native order. Each call
   scans at most 65,536 head-directory entries; a larger inventory returns
   `PENDING_INVENTORY_CAPACITY` without a partial cursor. Select a specific
   `unitId` to inspect it without enumerating the directory. Incomplete
   results remain incomplete; narrow selection if capacity is reached. The output
   includes existing claims, pending proposals/transactions and blocked intake.
2. `processing-prepare`: `{selection, operationId, inputs, reconsider?}`. Inputs
   are 1–20 exact `{identity: {client, sessionId, unitId}, headHash}` records.
   This verifies raw bytes and lineage, then reserves logical units. Explicit
   reconsideration can revisit handled heads; it is not an automatic retry flag.
3. `processing-page`: `{selection, operationId, expectedClaimHash, page}`.
   Page indexes start at zero. Read the complete returned evidence page.
4. `processing-ack`: `{selection, operationId, expectedClaimHash, pages}` where
   pages are the issued `{index, hash}` pairs. Use the latest claim hash returned
   by each call. Delivery is not acknowledgment; unread pages must not be acked.
5. Synthesize useful notes using the [skill](../SKILL.md), selected source facts,
   relevant existing notes and prior associations. Prepare any
   [note metadata](#prepare-note-metadata) before staging complete Markdown in a
   private proposal file; fingerprint it and the inspected target.
6. `processing-propose`: `{selection, operationId, expectedClaimHash, proposal}`.
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
bounded `NOTE_METADATA_INVALID` error. Save returned content
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
