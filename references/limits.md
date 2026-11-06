# Requirements and limits

## Requirements

Node.js 26.12.1 or a newer Node 26 patch, and a supported authenticated native
client: Claude Code (stable 2.x from 2.1.307) or Codex CLI 0.163.0. Each client
package contains the runtime, its exact production dependency closure, license
notices, the skill and these references, the native manifest, MCP descriptor and
hooks; an installed package needs no npm, source checkout or Cuefluent app.
Register the package through the client's plugin flow and trust its hooks only if
desired; neither configures a project or starts tracking. The connector, hooks and
workers of one installation use the same package and private store; restart the
client after changing either. Published releases and their checksums are
immutable.

## Startup

The connector and hooks run `node` from the native client's environment, and a
connector-only override does not change the hooks' executable. The CLI checks the
Node version before loading storage: an unsupported runtime reports
`NODE_VERSION_UNSUPPORTED` with the required range, detected version and
executable, while Node versions before 18 may fail in the loader first. A missing
runtime module reports reinstall guidance; if the diagnostics module itself cannot
load, the bootstrap reports `CUEFLUENT_BOOTSTRAP_FAILED`. CLI and connector
diagnostics go to stderr; hook failures use the native `systemMessage` response
and do not fail the user's prompt. A closed diagnostic pipe never interrupts an
operation.

`ENTRY_STORE_ROOT_INVALID` is a malformed `CUEFLUENT_HOME`; the diagnostic names
the variable without its value. `STORE_SCHEMA_UNSUPPORTED` means the store's state
schema is not supported: preserve it in place, and only an explicitly agreed new
setup at a fresh [private location](setup.md#private-location) continues.
`STORE_ROOT_OCCUPIED` means the selected location holds foreign entries: preserve
them and confirm the intended location. `STORE_INCOMPLETE` means initialization
state is incomplete or changed, which includes a retained store whose layout or
settings are missing while its queues, runs and gates remain: preserve it,
investigate, and retry setup at the same location for an interrupted first
initialization. A location that is empty or holds only that first scaffold is
not a store yet: the connector and the read-only commands treat it as
unconfigured, and `cuefluent_setup` creates or resumes the store there. Never switch `CUEFLUENT_HOME` to bypass pending work; a second
store against the same notes cannot coordinate with the first. `STORE_SETUP_BUSY`
means concurrent activity in the setup directory; retry the same setup at the same
location. If the host cannot start the executable
or load the entry script, Cuefluent has not run and produces no diagnostic: check
the configured executable, installed path and working directory in the client's
connector settings or startup log. Diagnostics install no Node, change no client
configuration and select no other executable; a manually pinned package path must
be kept current when upgrading. How a desktop client renders stderr or hook
messages varies.

## Private store

The store holds settings, per-chat tracking and opt-out state, stable project
ownership, native source identity, verified transcript positions, queued
normalized conversation parts, complete draft bytes, the current run's recovery
records and the latest result (outcome metadata, paths, counts, warnings and a
direct request hash, never a note body or write authority). Bookkeeping,
sidechains, duplicate snapshots, compaction summaries and verified plugin command
exchanges are excluded from queues; oversized tool output is clipped with a notice
while prompts, replies and tool arguments stay intact. An append is processable
only after its record and transcript position are durable; unknown inherited
history or a changed source anchor stays pending.

| Situation | Queue outcome |
| --- | --- |
| Tracked, successful save | Selected parts removed; collection continues. |
| Untracked, input remains | Remaining input stays available. |
| Untracked, fully handled | Conversation and completed private drafts removed. |
| Draft skipped or save failed | Affected input remains; saved notes stay. |
| Nothing-useful result | Selected parts removed without a note write. |

Opt-outs and verified positions survive queue removal. Data arriving after a
selection is not consumed by that run. Cleanup never deletes notes or native
transcripts. Process-owned gates release when their worker dies; owner death is
never inferred from PID reuse or elapsed time, and gate files are never deleted or
relocated. On macOS filesystems that report a volume UUID, retained file
identities bind that UUID and inode: gates, transcripts, draft artifacts,
directory pins, setup journals,
queue identities and publication recovery retain the same identity when a reboot
renumbers the mount-time device. Live operations also pin the current device
until they finish. A different gate volume or inode is `GATE_REPLACED`; a volume
identity that cannot be read is `GATE_IDENTITY_UNVERIFIED` for gates or
`FILESYSTEM_IDENTITY_UNVERIFIED` for other files. Preserve the store and
investigate these errors; never recreate locks or save around failed coordination.
A public note destination need not be on a local disk. When macOS explicitly
reports that a filesystem has no volume UUID, public files keep native device
and inode checks. This supports that capability profile without treating an I/O,
permission or malformed response as a missing capability. Private gates still
require a UUID, and private stores remain limited to supported local filesystems.
A previously recorded UUID never silently changes to a device-number identity.
Live SMB, NFS and FUSE shares have not been verified by the synthetic capability
checks; the writer still refuses any filesystem operation or metadata it cannot
verify.
Linux, Windows and macOS filesystems without UUIDs retain native device and inode
identities. Reboot or remount recovery where those identities change is not
established; preserve affected
state and report the diagnostic instead of replacing its recorded identities.
Cleanup acknowledgments must match the current run (`RUN_INVALID`,
`QUEUE_CURSOR_MISMATCH` otherwise); finish pending work before changing packages.
A note save and its log entry are separate writes: a log failure never blocks
cleanup, retry details stay in the current run, and unconfirmed entries are
reported in the latest result.

## Native clients and collection

Direct note tools are ordinary MCP calls to a selected configured project; they
read no transcripts and claim no session provenance. Tracking and processing need
native binding: Claude uses direct plugin command expansion plus an exact
attachment nonce for copied-history boundaries; Codex uses native MCP turn
metadata, the selected skill item or its exact linked-text form (the installed
skill link, one space, one action, at most one trailing newline, as the whole
message), exact thread source metadata and current-turn checks. Quoted examples,
extra prose and other skill paths are rejected; an unretained installed path in
history stays pending. There is no newest-file, working-directory or
model-supplied identity fallback. Claude processing accepts stable 2.x releases
from 2.1.307 after rechecking effective settings, tools and context; other
clients return `PROCESSING_CLIENT_VERSION_UNSUPPORTED`, and a policy cap on the
requested effort returns `PROCESSING_EFFORT_UNAVAILABLE`.

Known native bookkeeping rows are excluded. Claude prompts with a prompt identity
are collected without origin fields, so text resembling local-command output may
be retained; rows without a prompt identity are reported gaps unless native
metadata marks them as bookkeeping. Image and tool-reference blocks produce
omission notices. A Stop hook may precede final persistence; durable retries and
idle reconciliation collect late rows. Automatic enrollment retains the first
post-setup prompt identity and waits for that exact boundary before collecting;
older history stays excluded. Claude prompt enrollment also requires the fresh
`UserPromptSubmit` hook context linked to that prompt by its native parent chain;
a copied prompt ID alone never authorizes collection. The proof accepts at most
256 linked native rows and keeps missing or unsupported proof pending. This also
protects chats whose fork happened before setup, without recording unconfigured
or manual-mode chats. `TRANSCRIPT_BOUNDARY_PENDING` means the boundary is
not yet synchronized: let the turn and background collection finish, then check
status. `TRANSCRIPT_BOUNDARY_AMBIGUOUS` means the native identity does not uniquely
locate it. Preserve the chat and queued work; use a new chat without forking for
future automatic tracking or ask to save selected content as a direct note.
Resetting tracking does not resolve an ambiguous boundary.

Claude rewrites copied fork rows to the fork's current prompt ID, so that ID cannot
separate inherited history from new input. A Claude fork already registered with
an unknown inherited boundary retains its fork policy and stays pending with
`HISTORY_INHERITED_BOUNDARY_UNKNOWN` until
a trusted inherited prefix is available. Status reports this limitation. Codex
uses verified history cutoffs to omit parent history. A prompt hook without its
native prompt identity is ignored. Automatic tracking requires enabled supported
native hooks, and a stopped host keeps state without running an OS service.

## Processing isolation

Queued processing runs in a private working directory with an ephemeral native
launch, hooks and unrelated plugins disabled, no general shell or network access,
and only the draft workspace MCP capability; the native client contacts its own
model provider with its own authentication. The launch disables prompt logging and
telemetry exporters and verifies the effective floor, including filesystem
canaries, before source input is delivered; if the floor cannot be verified,
processing fails without releasing input. Codex on Windows requires its explicit
MXC sandbox, a compatible host and access to the requested model, with no weaker
fallback. macOS private storage checks native ACLs as well as owner and mode bits
and returns `PRIVATE_ACCESS_UNVERIFIED` when `node:ffi` is unavailable.

## Note publication and filesystem metadata

These rules apply to direct notes, queued processing and activity-log writes.
Windows public-file metadata preservation needs verifiable security metadata;
missing privileges refuse the replacement rather than discard ACLs.

Existing-note saves capture the destination in a recorded recovery directory
before replacement and refuse a newly arrived file. An interrupted save can
briefly leave the original only in that directory; retry or `skip` restores or
completes it without overwriting a newer note, and conflicting recovery files are
preserved. Staging names end in `.tmp` and are never discovered as notes.

On macOS, the replacement inode has OS-managed `com.apple.provenance` metadata
that may differ from the original's. Cuefluent does not guarantee the original
value survives replacement and does not clear or set this attribute explicitly.
It is excluded from the preservation fingerprint and attribute limits. The writer
preserves ordinary extended attributes, including quarantine, and the original
ACL's explicit and inherited entries. When preparing an update, it reconciles
attributes assigned to its new temporary file with the inspected original. It
restricts the owned stage to owner-only mode before clearing its ACL during
preparation, including a retry interrupted with a deny-write ACL still present;
the original ACL and permissions are restored before publication. Changes detected
after staging still refuse publication. A macOS update records
its completed-stage checkpoint only after bytes, permissions and metadata are
restored, verified and flushed. Before that checkpoint, a retry can finish
interrupted preparation; afterward, it verifies and reuses the stage without
preparing it again. The original note's attributes and ACL are never cleared to
enable copying. Content, file identities, ownership, permissions and flags remain
checked.

The macOS attribute profile allows 128 ordinary attributes with a combined
256 KiB value payload. Unsupported names and values are refused. A changed note
whose owner or group cannot be reproduced by the current account is refused before
staging. A group inherited unchanged from the destination folder can be preserved
without membership; the completed stage must still match the original metadata. `NOTE_METADATA_UNSUPPORTED` means native metadata cannot be preserved or
verified: keep the note and pending draft, inspect filesystem capabilities,
ownership, group membership and permissions, and resolve the cause before
retrying. Do not strip attributes or ACLs to bypass the refusal.

## Output profile

The supported Cuefluent Markdown profile limits a file to 10 MiB, each source line
to 64 KiB, body structure to 20,000 nodes per section and 100,000 per document, and
metadata to a 64 KiB payload within a 2 MiB inspected source, with further bounds
on nesting and decoded content. The app's 256-document and 250,000-node corpus
allowances apply across its library, so per-file validation cannot guarantee admission into a full
library; annual logs count toward them and appear in app search. Review pages are
48 KiB of serialized JSON, sized for the output a host passes to its model from one
tool result (Claude Code's default is 25,000 tokens). Direct submissions are
128 KiB of content and 192 KiB of complete draft. Direct reads share the 48 KiB
serialized-result budget with review pages: a note that fits arrives whole;
otherwise it arrives in bounded UTF-8 ranges. A requested range can be up to
48 KiB of note bytes, reduced as needed for the result including its other fields
and JSON escaping. Queued processing has separate budgets: 8 KiB read ranges,
64 KiB of cumulative tool responses and 128 KiB of cumulative draft submissions. A queued
full-content replacement requires reading the whole original; exact edits can
preserve unread content without resubmitting it. A note stores at most 128
sources, and a newly supplied source locator is limited to 120 UTF-16 code units;
see [source metadata](notes.md#source-metadata). A note check reads at most 1,024
notes and 32 MiB, in at most 512 folders to a depth of 16, and reports anything
beyond that as partial coverage. A file that cannot be read counts as a note,
one that turns out not to be UTF-8 counts toward the bytes, and a note larger
than the bytes that remain is not opened. Its pages share the 48 KiB budget, and
it lists
at most 20 items per finding with the remainder counted. Nothing is kept between
pages: each one reads the notes again, so a long report costs one full read per
page.

## What is verified

Deterministic checks cover protocol framing, the writer's atomic publication and
conflict rules, crash and interruption recovery, Windows ACL verification, hook
budgets and diagnostics on macOS, Linux and Windows. Rendered previews were
checked in Claude Desktop's Code tab and Codex Desktop. Checks do not establish
desktop rendering of diagnostics, live hook activation, native processing
isolation on an unaudited platform, reboot recovery, Cuefluent corpus admission or
search ranking, and per-file validation does not prove admission into a full
corpus. A note check's alias counts follow the consumer's warning rule and were
compared on synthetic notes with the app's own parser and corpus assembly; the
check does not run the app, and a note the app refuses to load raises no warning
there while the check still counts its aliases. The chat-decision flow (an accepted save, a declined decision that leaves
the draft pending, and a discard, with saved bytes compared to the retained draft,
and a full 48 KiB page delivered inline including CJK text) is not yet verified
live on Claude Code in Terminal, Claude Desktop's Code tab or Codex Desktop; nor
are ordinary Claude chat and Cowork. The Codex processing transport has native
macOS coverage; its Windows and Linux acceptance, Linux processing and
metadata-preservation branches, and Windows desktop command rendering are pending.
Do not describe deterministic coverage as native platform support.
