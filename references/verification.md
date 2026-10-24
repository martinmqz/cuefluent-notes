# Compatibility and limitations

## Diagnostic coverage

CLI startup, fatal connector transport errors, and failed control/direct-note MCP
calls provide fixed explanations and recovery guidance alongside stable codes.
Checks cover early runtime refusal, missing runtime files, nonblocking hook error
responses, malformed or incomplete protocol frames, and exclusion of private
exception text. They do not establish how every desktop client renders diagnostics.
Host failures before process creation remain host-reported errors, and executable
discovery or automatic runtime installation is not provided. Existing retained
run warnings and results are not rewritten into the new tool-error format.

## Native clients

Direct note creation and updates use ordinary MCP content submission to an
explicitly selected configured project. They do not read native transcripts,
require an exact selected command, enroll a chat, or claim session provenance. The current
assistant authors the note; the plugin validates, previews or saves it. Each
request supports one file and up to 64 KiB of submitted UTF-8 content. The complete
draft, including retained metadata, is limited to 128 KiB. New targets must be absent;
updates require an existing note's inspected whole-file hash and complete read
coverage in the same Codex chat or Claude connection. A Codex update needs
host-supplied chat context; missing context is refused. Originals larger than 64 KiB are refused
by the direct replacement tool. Reads return bounded 8 KiB chunks, with the
original hash required on later chunks. Direct review saves and discards require
MCP form confirmation from the host; unsupported hosts leave drafts pending.
The agent-supplied content workflow and the writer's platform behavior need native
desktop acceptance separately from deterministic protocol and filesystem tests.
Existing published snapshots do not gain new source
features until a release is installed.

The following native binding requirements apply to tracking and queued processing.

The current adapters target Claude Code 2.1.307 and Codex CLI 0.163.0 native
contracts. Claude processing accepts stable 2.x releases from 2.1.307 while
rechecking effective settings, tools and context before delivering source; older,
prerelease or new-major clients return `PROCESSING_CLIENT_VERSION_UNSUPPORTED`.
A native policy cap that prevents the requested effort returns
`PROCESSING_EFFORT_UNAVAILABLE`; choose an effort the policy permits. These
checks do not establish acceptance of every later client release.
Claude uses direct plugin command expansion plus an exact native
attachment nonce for copied-history command boundaries. Codex uses native MCP turn
metadata, the selected skill item or its exact linked-text history representation,
exact thread source metadata and current-turn checks. The linked form must occupy
the entire user message: the installed skill link, one separating space, one
action, and at most one terminal newline. Action text uses the same surrounding
and repeated-space normalization as the selected-skill form. Quoted examples,
extra prose, annotations and other skill paths are rejected for current commands;
an unretained installed path in history remains pending for identity verification.
An identical hand-entered whole-message link is also an explicit
invocation; stored text cannot prove which UI gesture created it.
Different session/thread identity shapes remain unsupported until verified.
No newest-file, working-directory or model-supplied identity fallback exists.

Known native bookkeeping is excluded from collection, as are unlisted Claude
non-conversation row kinds that carry the chat's own session identity. Claude
prompts with a prompt identity can be collected without origin fields. Their text
is preserved even when it resembles local-command output; this may retain native
bookkeeping text when provenance is absent. Rows without a prompt identity remain
reported gaps unless native metadata identifies them as bookkeeping. Supported
non-text image and tool-reference blocks produce explicit omission notices while
surrounding text remains intact. Unknown conversation shapes remain reported gaps.

A Stop hook may precede final transcript persistence. Durable retries and idle
reconciliation handle delayed rows and supplementary output. Unsupported hook
shapes do not imply completed or interrupted conversation. Automatic enrollment of
a Claude fork with an unknown inherited prefix remains pending; the current file's
size or current command nonce cannot establish that inherited boundary. Codex uses
verified native history cutoffs and reports missing historical sources.

Native CLI checks do not establish desktop or TUI rendering, every lifecycle
variant, search ranking, or watcher behavior on another operating system.

## Processing and platform support

Private macOS storage checks native ACLs as well as owner and mode bits. Explicit
and inherited grants to other users or groups are refused, including grants that
apply only to new children. Existing ACLs are never stripped. Unavailable native
ACL verification returns `PRIVATE_ACCESS_UNVERIFIED`; use a supported Node build
with `node:ffi` enabled (and `--allow-ffi` when using Node's permission model).

Earlier macOS native checks covered GPT-6.1 and Claude Opus draft-only sessions
and a complete private-draft → review → save flow. The current Codex app-server
transport has separate native macOS coverage for configured-provider drafting;
earlier acceptance does not establish the revised direct-note workflow.
Native processing verifies an effective floor
before providing source input: no project instructions, hooks or unrelated
plugins, no general shell or network access, and only the explicit draft workspace
MCP capability. Codex retains its configured provider and model, with authentication
handled by the native client. Native global `AGENTS.md` guidance may remain; it
cannot change the selected input, destination, draft tools or save authority.
The processing launch disables prompt logging and all telemetry exporters before
starting the app-server, then verifies the effective configuration before input
delivery. Its network restriction does not prevent the native client from
contacting the configured model provider.
If that floor cannot be verified, processing fails without releasing source input.
Filesystem canaries check denied temporary locations as well as an allowed
working-directory location; macOS also checks `/private/tmp` independently of
the configured temporary directory.

Source-free client smoke checks exercise the shared Codex configuration, feature,
ephemeral thread and MCP admission, execute a fixed stdout-only program through
`command/exec`, and check generated schemas for the production request fields.
They send no model input and do not prove native sandbox isolation. Hosted smoke
therefore reports `sandboxCanary: false`; production processing still requires its
full native isolation checks before source delivery.

Earlier Windows native checks covered Claude Opus and explicitly selected Codex
GPT-6 Luna processing through private draft, review, exact-byte save and cleanup.
The Codex checks used the previous exec transport. Codex uses
its configured model unless the trusted host explicitly selects another available
model or deployment. The provider-preserving Codex transport has native macOS
coverage; its Windows and Linux acceptance must be repeated. Codex on Windows requires its explicit MXC
sandbox, a compatible Windows host, and access to the requested model; the native
filesystem and network floor is checked before source delivery, with no fallback
to a weaker sandbox. Linux processing and metadata-preservation branches require
native acceptance. Windows public-file metadata preservation requires verifiable
security metadata; missing native privileges are a refusal before replacement,
not permission to discard ACLs.
Do not describe deterministic test coverage as completed native platform support.

Existing-note saves capture the destination in a recorded recovery directory
before checking its exact identity, contents and metadata. Publication refuses a
newly arrived destination. An interrupted save can briefly leave the original
only in that recovery directory; retry or `skip` restores or completes the save
without overwriting a newer note. Conflicting recovery files are preserved.
If interruption occurs before the directory identity is recorded, the untouched
original remains public and unknown temporary objects are retained; `skip`
releases the run with a preservation warning so processing can start afresh.

Automatic tracking requires supported, enabled native hooks. A processing session
uses a private working directory outside configured projects and an ephemeral
native launch with hook/plugin isolation; it is never enrolled into the queue.
A host outage preserves state but does not run an OS service in the background.

## Output profile

The supported Cuefluent Markdown profile currently limits a file to 10 MiB,
body structure to 20,000 nodes per section and 100,000 per document, and metadata
to a 64 KiB payload within a 2 MiB inspected source. Additional parser bounds cover
nesting, lines and decoded content. Generated metadata must remain inspectable;
a metadata-bearing annual log cannot use the larger plain-file ceiling to bypass
metadata limits. Validate actual structure and bytes, not a presumed safe entry count.

The app's 256-document and 250,000-node corpus allowances apply across its selected
library. Per-file validation cannot guarantee admission into an already-full
library. Annual logs count toward those allowances and can appear in app search.
The current desktop app does not open relative note links; standard links remain
for agents and other readers. These are compatibility-profile constraints to
revisit as supported app versions change.

Staging filenames end in `.tmp` and cannot be discovered as Markdown notes merely
because they contain `.md` earlier in the name. Atomic publication keeps the final
path and verifies parent identity, original hash and supported metadata. External
editors can still race filesystem operations; detected changes are preserved and
reported, and no cross-process protocol can force an unrelated editor to cooperate.
