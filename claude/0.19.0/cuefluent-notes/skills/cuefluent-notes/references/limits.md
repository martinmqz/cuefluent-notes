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
relocated. Cleanup acknowledgments must match the current run (`RUN_INVALID`,
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
idle reconciliation collect late rows. A Claude fork with an unknown inherited
prefix stays pending for automatic enrollment; Codex uses verified history
cutoffs and reports missing sources. Automatic tracking requires enabled native
hooks, and a stopped host keeps state without running an OS service.

## Processing isolation

Queued processing runs in a private working directory with an ephemeral native
launch, hooks and unrelated plugins disabled, no general shell or network access,
and only the draft workspace MCP capability; the native client contacts its own
model provider with its own authentication. The launch disables prompt logging and
telemetry exporters and verifies the effective floor, including filesystem
canaries, before source input is delivered; if the floor cannot be verified,
processing fails without releasing input. Codex on Windows requires its explicit
MXC sandbox, a compatible host and access to the requested model, with no weaker
fallback. Windows public-file metadata preservation needs verifiable security
metadata; missing privileges refuse the replacement rather than discard ACLs.
macOS private storage checks native ACLs as well as owner and mode bits and
returns `PRIVATE_ACCESS_UNVERIFIED` when `node:ffi` is unavailable.

Existing-note saves capture the destination in a recorded recovery directory
before replacement and refuse a newly arrived file. An interrupted save can
briefly leave the original only in that directory; retry or `skip` restores or
completes it without overwriting a newer note, and conflicting recovery files are
preserved. Staging names end in `.tmp` and are never discovered as notes.

## Output profile

The supported Cuefluent Markdown profile limits a file to 10 MiB, body structure
to 20,000 nodes per section and 100,000 per document, and metadata to a 64 KiB
payload within a 2 MiB inspected source, with further bounds on nesting, lines and
decoded content. The app's 256-document and 250,000-node corpus allowances apply
across its library, so per-file validation cannot guarantee admission into a full
library; annual logs count toward them and appear in app search. Review pages are
48 KiB of serialized JSON, sized for the output a host passes to its model from one
tool result (Claude Code's default is 25,000 tokens). Direct submissions are
64 KiB of content and 128 KiB of complete draft; a whole read fits one 128 KiB
result and ranges are 8 KiB.

## What is verified

Deterministic checks cover protocol framing, the writer's atomic publication and
conflict rules, crash and interruption recovery, Windows ACL verification, hook
budgets and diagnostics on macOS, Linux and Windows. Rendered previews were
checked in Claude Desktop's Code tab and Codex Desktop. Checks do not establish
desktop rendering of diagnostics, live hook activation, native processing
isolation on an unaudited platform, reboot recovery, Cuefluent corpus admission or
search ranking, and per-file validation does not prove admission into a full
corpus. The chat-decision flow (an accepted save, a declined decision that leaves
the draft pending, and a discard, with saved bytes compared to the retained draft,
and a full 48 KiB page delivered inline including CJK text) is not yet verified
live on Claude Code in Terminal, Claude Desktop's Code tab or Codex Desktop; nor
are ordinary Claude chat and Cowork. The Codex processing transport has native
macOS coverage; its Windows and Linux acceptance, Linux processing and
metadata-preservation branches, and Windows desktop command rendering are pending.
Do not describe deterministic coverage as native platform support.
