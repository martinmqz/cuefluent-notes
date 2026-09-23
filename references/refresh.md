# Safe updates and derived refresh

Use the shared writer for reviewed changes from Log, Prepare, Update, or Refresh.
It applies supplied Markdown; it does not summarize sources, merge prose, infer
facts, or decide what should be deleted. Evidence review, chronology, useful
vocabulary, and preservation of user edits remain the working agent's job.

All helper processing is local. The agent's handling of material it reads is a
separate boundary; do not describe agent-assisted preparation as wholly local.
No Cuefluent app, source checkout, workspace packages, or Devlog is required.

## Ownership and private state

Choose the output root and state directory from the user's authorized locations.
Both are absolute paths; the notes root and output parent directories must
already exist. The helper creates its private state directory when needed, not
a new notes folder structure. Keep notes, source
paths, proposals, query cases, plans, manifests, and recovery state outside this
public skill repository. The state directory is a private companion to the
collection, separate from the loaded Markdown; it is not another note store.

Use one state directory for each collection. Cooperating helper calls serialize
through that directory's lock. Using different state directories for the same
outputs would defeat that coordination. Never share a state directory between
unrelated collections or automatically choose another one to avoid a lock.

| Mode | Source of truth | Guard before replacing an existing file |
| --- | --- | --- |
| `authored` | The current user-owned note | Its bytes must still match the hash of the version inspected for this edit. No source manifest or duplicate evidence document is required. |
| `derived` | The selected sources, with explicitly owned generated outputs | The output must match both its inspected hash and its last generated hash in the manifest; source hashes and manifest hash must also match the inspected state. |

An initial derived write cannot overwrite an untracked existing file. Start in
a fresh destination. A tracked output with manual edits is a conflict, even if
a new proposal appears plausible. Preserve it and report the conflict; there is
no automatic merge or blanket adoption switch. Do not change ownership mode or
discard the manifest merely to bypass a refusal.

## Inspect, reconcile, and review

1. Inspect the selected output files and source passages within the authorized
   scope. Fingerprint the inputs before reading, then verify that those
   fingerprints are unchanged after preparing the proposal; if they changed,
   re-read the affected material before proceeding. Preserve relevant dates,
   identifiers, source locators, uncertainty, and user-authored content.
2. For an existing derived collection, inspect its private state. Changed hashes
   identify evidence to review, not a new factual answer. A missing source is a
   gap, not permission to delete an entry. If a source moved, resolve its new
   location within the selected scope and update its mapping after review; do
   not search unrelated folders automatically.
3. Prepare only the necessary revised Markdown in private proposal files. Show
   the diff with additions, revisions, proposed retirements, and unresolved gaps.
   Reconcile meaning against the actual source passages. Preserve occurrence
   dates even when recording information later. Resolve material uncertainty;
   work already authorized does not need repeated permission.
4. Check the proposed resulting collection against [authoring.md](authoring.md),
   [evidence.md](evidence.md), and [retrieval.md](retrieval.md), including unchanged
   documents that can create ambiguous vocabulary. Recheck factual support and
   rich Markdown; the safe writer does not make those editorial judgments.
5. Build the plan with the inspected output, source, and manifest hashes. Apply
   it, inspect the result, and report changed files, no-ops, conflicts, or partial
   progress. Do not silently retry against newly observed hashes without
   re-reading and reconciling changed content.

No new durable information and no needed correction means no note write. An
identical proposal leaves the target content and modification time unchanged;
an unchanged derived manifest is retained without rewriting it.
Unchanged source hashes do not prove current behavior, and changed source hashes
do not prove that every derived entry needs an edit.

## Commands and plan

Run from the skill directory with the supported Node runtime and dependencies
described in [retrieval.md](retrieval.md). These paths are illustrative; replace
them with the selected private locations.

```sh
node scripts/safe-update.mjs fingerprint /absolute/private-notes/client.md /absolute/private-sources/task.md
node scripts/safe-update.mjs inspect /absolute/private-state
node scripts/safe-update.mjs apply /absolute/private-review/plan.json
node scripts/safe-update.mjs recover /absolute/private-state
node scripts/safe-update.mjs abort /absolute/private-review/abort-plan.json
```

`fingerprint` reports SHA-256 hashes of exact, bounded UTF-8 file bytes without
printing file bodies; a missing file has a `null` hash. `inspect` reports the
manifest and journal hashes, whether recovery or a lock is pending, and whether
each tracked output or source is unchanged, changed, or missing. Pending output
and stage fingerprints support explicit recovery review, including incomplete
stages; bodies are never printed. It does not
rewrite notes or decide factual corrections. `apply` reads a JSON plan and
rejects fatal errors from the bundled Markdown checker before applying reviewed
proposal files. Advisory findings still require review of the resulting
collection and factual meaning. `recover` handles an interrupted update
under the constraints below. `abort` cancels remaining replacements after review
and preserves completed note bytes. These commands never generate new Markdown prose.

For a source shared by several outputs, drift is checked against every recorded
mapping. `affectedOutputs` identifies the notes still based on older or missing
evidence, including after a partial refresh of the collection.

A derived plan has this shape. Hash placeholders represent the exact hashes
returned for the inspected files, not timestamps. Use `null` for an output that
must not yet exist. `expectedManifestHash` is required in derived mode; use
`null` only when the manifest must not yet exist.

```json
{
  "version": 1,
  "root": "/absolute/private-notes",
  "stateDir": "/absolute/private-state",
  "mode": "derived",
  "expectedManifestHash": "<inspected manifest hash>",
  "files": [
    {
      "path": "client.md",
      "expectedHash": "<inspected output hash>",
      "contentPath": "/absolute/private-review/client.md",
      "sources": [
        {
          "path": "/absolute/private-sources/task.md",
          "expectedHash": "<inspected source hash>"
        }
      ],
      "entries": [
        {
          "heading": "Authorization conflict investigation",
          "sourcePaths": ["/absolute/private-sources/task.md"]
        }
      ]
    }
  ]
}
```

Each `path` is relative to `root`; each `contentPath` and source path is absolute.
`sources` is required for derived outputs and optional for authored notes.
`entries` is an optional human-readable heading-to-source mapping; it does not
prove the claim or replace inspection of the supporting passage. For authored
notes, use `"mode": "authored"`; no derived manifest hash or duplicate evidence
file is required. Existing authored notes still need their inspected
`expectedHash`, and new notes use `null`.

The derived `manifest.json` records output fingerprints, source fingerprints,
entry mappings, and the compatibility guide version. It contains private paths
and identifiers but no source bodies. Keep it with the selected private
collection state and out of versioned skill files. A later plan must use its
inspected fingerprint to detect concurrent manifest changes.

## Retire derived output tracking

A derived plan can include `"retire": [{"path": "obsolete.md", "expectedHash":
"<inspected last generated hash>"}]`. Use `null` only after confirming the file
is absent. This removes its manifest record; it never deletes or changes the
note. A present note must still match its last generated hash. Manually edited
notes require reconciliation before retirement. Untracked paths, stale hashes,
duplicates, and paths also listed in `files` are rejected.

A retirement-only plan uses `"files": []`; updates and retirements together are
limited to 100 paths. Keep the inspected `expectedManifestHash`. A missing
tracked output blocks refresh until its retirement is explicitly reviewed;
retiring it then permits ordinary refresh of the remaining collection. Once
untracked, a retained note cannot be overwritten by initial derived generation.

## Interrupted writes and conflicts

The helper stages content and replaces files atomically one at a time. A
collection is not an all-or-nothing transaction: an interruption can leave some
outputs updated and others unchanged. Before any staging, the private journal records all reserved temporary paths,
hashes and the previous/proposed manifests, not note or source bodies; staged files necessarily contain the
reviewed note content and need the same privacy as the notes. Stages live beside
their targets and start with `0600` permission bits. New notes keep `0600`.
Immediately before replacing an existing note, the stage receives its recorded
permission bits and owner/group; inability to preserve them stops the write.
Permission or ownership changes during the operation are conflicts. Updates to
hard-linked notes are refused because replacement would sever that relationship;
an unchanged proposal can still leave a hard-linked note untouched.

Atomic replacement creates a new inode. ACLs and extended attributes (including
macOS tags and Finder comments) are **not copied** by this portable Node helper.
Use a metadata-preserving editing method when those attributes must survive;
do not claim full filesystem metadata preservation. A stage interrupted just
before rename can already have the existing note's permissions.

An interruption during staging may leave missing or partial stages. They remain
listed by `inspect`; no directory scan or untracked content discovery is needed.
Recovery requires complete staged bytes. Use a reviewed abort for incomplete
staging before preparing fresh proposals.

Use `inspect` to understand the interrupted state, then `recover` on the same
state directory. Recovery can roll forward only while outputs match their
recorded old or desired versions and selected sources remain unchanged. It must
stop if a user edited an output or evidence changed. Preserve completed writes,
remaining staged content, and conflicting user edits until the conflict is
understood. Do not claim success for a partially applied collection, regenerate
missing content blindly, or repeatedly force recovery.

If source drift makes roll-forward inappropriate, inspect the current note bytes
and every listed stage, then prepare an abort plan bound to that inspection:

```json
{
  "version": 1,
  "stateDir": "/absolute/private-state",
  "expectedJournalHash": "<inspected journal hash>",
  "expectedManifestHash": "<inspected manifest hash or null>",
  "files": [{"path": "client.md", "expectedHash": "<inspected current output hash or null>"}],
  "stages": [{"path": "/absolute/private-notes/.cuefluent-stage-<uuid>.tmp", "expectedHash": "<inspected stage hash or null>"}]
}
```

Use JSON `null`, without quotes, for absence. List **every** `pendingOutputs`
entry and stage from `inspect`, using their `hash` values as `expectedHash`.
An abort preserves outputs only at the journal's old or new hashes; newer human
edits remain a conflict to reconcile. It checks reviewed stage bytes, cancels
remaining writes, and reconciles tracking to completed output versions while
retaining their original evidence hashes. It does not mark changed evidence as
fresh. It removes only the reviewed journal stages, then the journal. An abort
also cancels pending retirements, retaining their prior tracking.

The approved abort is itself journaled. If cleanup is interrupted, `recover`
finishes that abort without applying remaining proposals or requiring stale
sources to be restored. After completion, inspect again, review current evidence,
and prepare a new plan using current hashes. An abort does not roll note bytes
back. Older journals without a previous-manifest snapshot support reconciliation
when the original manifest is still available; otherwise the helper may require
manual reconciliation rather than guessing ownership.

The lock coordinates cooperating helper processes only. Hash checks detect
changes since inspection, but a separate editor can still write between the
last check and a rename. This tool does not guarantee universal concurrent-write
exclusion. A full check runs before and after replacements. Between them, each
output, stage and its mapped sources are checked before that output's rename.
Stable source path, inode, size, mtime and ctime allow reuse of the prior source
hash; changed metadata forces a new hash, and the final full pass hashes sources
again. Avoid simultaneous external editing of the selected notes during an
apply or recovery, and review reported conflicts against current content.

Never automatically steal a stale lock, manually delete a journal, or point recovery at
a new state directory. The state directory's `.lock/owner.json` records the
process ID, hostname, and creation time. An abrupt process termination can leave
this lock behind. Inspect that metadata and establish that the owning process
has ended on the recorded host before manually removing only the `.lock`
directory; a reused process ID or unknown host is not evidence of a stale lock.
Keep the journal and stages, then use `recover` or an explicitly reviewed
`abort` in the same state directory.
If ownership is uncertain, leave the lock in place and report the conflict.
Cleanup errors are separate `cleanupWarnings`: they do not turn a completed
write into failure or replace the original operation error. A changed owner
or directory is retained for inspection. Missing owner metadata permits cleanup
only when the original directory identity is intact and the directory is empty.

A lock refusal is a bounded failure to investigate, not permission to bypass
coordination. Do not retry indefinitely or block unrelated work. Report the
affected collection, verified progress, and unresolved state.
