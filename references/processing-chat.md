# Processing in a reusable chat

The installed plugin can hand an explicit processing request to a dedicated
native Codex or Claude session. It reuses one session per collection, client,
machine and client profile. Claude also separates sessions by the selected
authentication mode. Several source projects can use that session. The existing
engine still owns evidence, claims, proposals, approvals, writer transactions
and recovery. Cuefluent does not need to be installed or running.

This path requires the matching native client executable on PATH and its normal
authentication. The native client resolves the model under the restricted
processing launch settings, including the supported Claude preferences described
below. Persistent status does not yet report the resolved model. The plugin does
not choose a provider or model independently of that configuration, install a
client, change authentication or run on a schedule. A desktop installation alone
does not establish that its CLI is available. Native protocol support is checked
at runtime; unsupported clients fail without inline processing. Desktop sidebar
visibility and navigation require separate live verification. Status, review and
registry recovery read the local client profile and stored state without
launching a native client. A native executable is needed only when a request
actually creates or resumes a processing run.

## Commands and replies

Type the skill, then one action: `/cuefluent-notes <action>` in Claude or
`$cuefluent-notes <action>` in Codex, for example `/cuefluent-notes review`.
Claude records the bare `/cuefluent-notes` as its full plugin name
`/cuefluent-notes:cuefluent-notes`, which also works; type the full name when
another command takes the bare one. In Codex, type `$` and choose cuefluent-notes
from the list: Codex inserts `$cuefluent-notes:cuefluent-notes` and attaches the
skill to the message. A mention typed out by hand attaches nothing, so it is no
command: whichever control the assistant calls for it applies nothing, and the
reply says how to type it and names the nearest commands. The actions are the
[formal processing controls](../SKILL.md#formal-processing-controls), typed
exactly as written. `help`, or the skill typed with nothing after it, lists them
and applies nothing. Before setup, while nothing is registered for the chat, a
command answered by the status tool (`help`, `status` or the skill alone)
returns the command list and how to start `setup`, which follows the
[setup workflow](setup.md) and is not itself a processing control; other actions
are refused there.

Replies are short, plain Markdown. They name a draft by its code and first note
path, list commands and other drafts as one list item each after a blank line
(a draft as its code, one space and its note path), and contain no hashes,
identifiers or diagnostic codes. A review reply links the review folder and each
listed file's proposed copy: in Claude as `file://` links, which open with one
click in Claude Desktop, in Codex as the local links Codex's model writes itself,
`[name](/absolute/path)` with the folder's or file's name (angle brackets around
a path with spaces or parentheses), so a relayed reply keeps its form. A very
long folder path, or in Codex a path Markdown cannot carry as such a link (for
example a Windows path, or one with `#` or `?`), is shown as a code span instead, so it reads exactly
as written; note paths are quoted with Markdown's inline characters escaped. A status reply or
completed decision that has diagnostics says to type `status --verbose`; that
reply adds the status, next action, diagnostics, request and chat identifiers,
scope, counts and each draft's exact revision. The review folder's `summary.txt`
also records the revision. A status reply also says when automatic collection has
stopped for this chat, as the latest collection pass reported it, for example at
a Claude Desktop Remote Control record (see
[capture prevention](#capture-prevention-and-limits)).

A refused or failed control answers with a plain sentence the assistant returns
as its reply. A refusal before the requested action started says that nothing was
applied (for `review`, `save`, `skip` and `review cancel`, also that nothing was
saved) and what to do next; a failure after it started says the outcome is not
certain and to check `status` first, unless it is a refusal that names its cause:
the native client's sign-in or launch settings, a run that could not be confirmed
stopped, a review shown again or decided before its reply was confirmed, another
Cuefluent Notes step still finishing, or, for a review, the collection being
busy. Those say what happened and to check `status`. The diagnostic code stays in the error's data
for tools, as described in the [workflow CLI](workflow-cli.md#processing-chat-controls).

Text after the skill that is not one exact action, such as a near miss or an
action mixed with other words, is not a command. When its typed input verifies
from the native transcript, no control applies anything and the reply names the
nearest exact commands to type. That text stays evidence, as described under
[capture prevention](#capture-prevention-and-limits).

## Claude launch settings

### Select the processor's authentication

The selected Claude CLI profile can use regular native account login or a
supported provider configuration; Foundry is not required. Codex retains its
native profile authentication and provider selection. Cuefluent does not read
either client's credential store or start a sign-in flow.

Claude defaults to `CUEFLUENT_CLAUDE_AUTHENTICATION=inherit` (also the behavior
when unset). It preserves the calling host's authentication rules below. Some
Desktop versions deliberately remove their managed credential from subprocesses,
so that credential cannot authenticate the separate processor.

To explicitly use an already authenticated Claude CLI profile instead, set
`CUEFLUENT_CLAUDE_AUTHENTICATION` to `native-profile` in Claude's environment.
For one local project, merge the following into that project's
`.claude/settings.local.json`, preserving its other settings and keeping the
file out of Git. For all your projects, use the selected user profile's
`settings.json` instead. These are Claude session settings, not a per-plugin
settings field; see [Claude's settings
scopes](https://code.claude.com/docs/en/settings#settings-files-and-who-they-affect).

```json
{
  "env": {
    "CUEFLUENT_CLAUDE_AUTHENTICATION": "native-profile"
  }
}
```

Restart the affected source session and reconnect its MCP server. Select the
intended CLI profile in the environment that launches Claude with
`CLAUDE_CONFIG_DIR` if needed; leaving it unset uses the native default. The
user must first confirm which account and provider that profile uses: matching
provider names alone do not prove matching accounts. This is a setup choice,
never an automatic fallback or a processing-tool argument. Do not enable it
merely because a processing call failed.

This mode uses the profile's stored native login or supported provider settings
in its user `settings.json` `env`. Provider values exported by a shell, terminal
or Desktop are ignored. A working CLI with those exports does not verify this
mode: use the native client's account/provider display outside project-specific
configuration, with the intended profile and those exports absent. Otherwise an
export-only provider can be lost and an existing native login selected instead.
Do not inspect credential values or start processing to verify setup.

In `native-profile` mode, the processor removes inherited Desktop credentials,
provider selectors, endpoints, model environment overrides and credential-chain
locators before loading the selected CLI user settings. Its normal native login
or configured provider credential chain supplies authentication. The plugin does
not copy host credentials, read the host credential file, disable subprocess
scrubbing, or run shell startup files. Native credential-chain executables must
be available on the calling environment's `PATH`. Supported connection and
tuning defaults remain available; selected user settings take precedence in this
mode. The existing restricted-tool and credential-helper limitations below still
apply.

Authentication modes have separate native processing-session bindings. Changing
the mode cannot resume a chat created with the other mode, transfer a claim, or
clear interrupted work. Existing claims and proposals remain guarded by their
original ownership and recovery requirements. CLI status and recovery commands
must use the same authentication mode and `CLAUDE_CONFIG_DIR` selection as the
original run; another namespace can report `missing` while the original remains
blocked. An already-open controller rejects reads and controls after a mode change
with `PROCESSING_CLIENT_IDENTITY_CHANGED`; reopen the helper to select the new
namespace. Status and review do not launch a model or require a fresh credential.
An unrecognized or ambiguous mode reports `PROCESSING_CLIENT_AUTHENTICATION_INVALID`
without dispatching; status, review and cancel also require correcting that
setting first.

### Inherited authentication and supported settings

Restricted Claude processing retains its existing native authentication and
supported provider, deployment and connection environment settings. Before each
eligible run, including session reuse, it reads the selected user profile's
`settings.json` (`~/.claude/settings.json`, or the profile chosen by
`CLAUDE_CONFIG_DIR`). A CLI launch outside Claude applies supported user `env`
values over inherited shell values, as native user settings do. A verified
Claude chat handoff, or a CLI launched from Claude with its native `CLAUDECODE`
nesting hint, preserves values already supplied by the host environment, using
the user profile only for missing values, except for host-managed routing
described below. The hint changes environment precedence only; it supplies no
session identity or permission. This keeps exported project account, endpoint
and model selections intact. Supported profile model preferences, mappings and
allowlists are passed as restricted settings; native managed policy and
environment-model precedence remain in force.

The user file is reread before each eligible run, but an inherited host value
still wins. The plugin cannot tell whether that value came from the old user
settings or an intentional project override. Rotating a profile credential does
not replace an inherited credential in a running MCP server. Restart the source
client and reconnect its plugin MCP server so the updated host environment
reaches the next request; do not discard the processing registry or captures. An
ordinary CLI launch without a host override picks up the new profile value on
its next run.

Some hosts declare managed authentication with
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` or `CLAUDE_CODE_HOST_AUTH_ENV_VAR`. A
managed host must provide an explicit credential locator and its nonempty
inherited value to the separate processor. Missing, empty or unusable handoffs
report `PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE` before acknowledging a finished
review, freezing a new shortcut workset, or reserving a native run. Exact
completed control replies can still replay. No model is started and no evidence
is claimed. The plugin does not fetch host secrets, replace them from user
settings, or switch to another provider.

The locator is an environment-variable name matching
`^[A-Za-z_][A-Za-z0-9_]{0,255}$`, not a credential value or file path. Supported
standard credential names are `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_FOUNDRY_API_KEY`,
`ANTHROPIC_FOUNDRY_AUTH_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK`. Other recognized
provider, connection or model settings are refused as locators, even when they
contain credentials. This includes `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
and `GOOGLE_APPLICATION_CREDENTIALS`.

A host-specific credential variable outside that recognized set is also accepted
if it is not a reserved control and its nonblank inherited value survives
child-environment preparation. Names are case-sensitive except on Windows.
Refused controls include host/profile/process variables such as `PATH`, `HOME`,
`CLAUDE_CONFIG_DIR` or the two managed-auth markers, unsupported provider
switches, or the removed `CLAUDECODE` and `CUEFLUENT_ENGINE_*` fields. A refused
locator reports the same diagnostic; use the independently authenticated
workflow below rather than renaming or copying credentials to bypass the check.

In host-managed mode, inherited routing and authentication own even absent
fields. Profile provider selectors, endpoints, model environment values,
credentials, client certificates and credential-helper commands are ignored.
Supported proxy, CA, timeout and output, thinking and effort defaults can fill
missing connection/tuning fields; inherited host values win. Supported
structured model preferences still pass as settings. A disabled managed-host
flag alone keeps ordinary profile projection. Credential presence only permits
launch; it does not verify authentication, expiry, or a host refresh channel.

When upgrading from v0.14.1–v0.15.0, a managed-host handoff no longer fills
missing model environment values such as `ANTHROPIC_MODEL` or
`ANTHROPIC_DEFAULT_*_MODEL` from the user profile. The host may therefore
resolve a different model, with different cost or quality. Controller status
does not report the resolved model. Use the host's supported model configuration
or supported structured profile model preferences under native precedence; do
not rely on the ignored profile `env` keys.

If the host cannot delegate its authentication, explicitly select a working CLI
profile as above, use the [standalone workflow](processing.md) in an uncaptured
chat whose normal authentication works, or invoke processing from an
independently authenticated Claude terminal. Do not manually unset host routing
or authentication markers to force a different account. With a valid
authentication-mode setting, status and pending-proposal review do not need this
launch credential. A run that already failed with an unknown outcome still
requires the existing recovery controls below; this preflight does not clear it.

The projection restores supported first-party/gateway, Foundry, Bedrock/Mantle
and Vertex environment settings. Connection controls include uppercase and
lowercase proxy variables, `API_TIMEOUT_MS`, certificate settings, and native
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` and `MAX_THINKING_TOKENS` tuning. Unrelated keys
and feature toggles are ignored, without interpreting every `CLAUDE_CODE_USE_*`
name as a provider. The known unsupported provider selectors
`CLAUDE_CODE_USE_ANTHROPIC_AWS` and `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` are
refused when enabled in projected user `env`. Host-managed routing ignores those
unused provider switches. Other unrecognized file environment keys are not
restored; use the standalone workflow when the native setup depends on them.
Execution controls such as file-based `PATH`, `NODE_OPTIONS` and engine
authorization are never restored.

Stored structured effort preferences (`effortLevel` and `modelSettings`) are not
restored. Their user-profile semantics differ from launch-level settings, so the
processor does not translate them into a global effort override. To select
effort for restricted processing, supply `CLAUDE_CODE_EFFORT_LEVEL` through the
host environment or the supported user-profile `env` settings. Otherwise the
native client resolves effort without those stored preferences; see its [effort
configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

Authentication values remain in process memory and environment, never command
arguments, proposal receipts or plugin diagnostics. A missing user settings file
retains the environment after the explicit authentication-mode selection. The
processor does not discover project settings, restore Claude's credential-helper
command settings, restore unrelated profile settings, or modify authentication.
In `inherit` mode, project-specific configuration must already be supplied
through the calling host's environment; `native-profile` instead requires the
selected user profile's supported provider settings. Project-specific structured
settings are not read. Hooks, plugins, slash commands and arbitrary tools remain
disabled; native runtime verification still requires the sole selected engine
and its exact tool set.

The inherited `CLAUDE_CONFIG_DIR` stays unset when unset, and keeps its exact
spelling when set. Changing it can change native credential-store selection even
when it names the same physical folder. The registry and exclusion lookup use
the verified canonical profile. Profile aliases are rechecked before dispatch
and engine calls, but are not locked across native startup; a changed or
unverifiable profile stops processing without granting an exclusion or replacing
state.

`PROCESSING_CLIENT_SETTINGS_INVALID`, `PROCESSING_CLIENT_SETTINGS_UNAVAILABLE`
and `PROCESSING_CLIENT_SETTINGS_LIMIT` stop before native admission when
settings are malformed, inaccessible, changing or over their bounded limits. The
`env` shape and entry-count checks still apply in host-managed mode, while value
checks apply only to eligible fields. File size, JSON/duplicate-key, structural
and supported model checks apply in both modes. Ask the user to resolve the
selected native settings in the client without printing settings or credential
values. Keep existing processing state intact.
`PROCESSING_CLIENT_SETTINGS_UNSUPPORTED`
reports a configured Claude credential-helper command outside host-managed mode
or an unsupported enabled provider switch in projected user `env`. The native provider SDK still owns its ordinary authentication;
the plugin neither reads credential stores nor starts sign-in commands. Use the
[standalone workflow](processing.md) from an uncaptured chat whose
normal authentication works. Status and existing-proposal review remain available
without reading these launch settings, but opening their registry still requires
a resolvable native profile directory. A missing or inaccessible profile reports
`PROCESSING_CLIENT_SETTINGS_UNAVAILABLE` without selecting a replacement namespace.
A previously interrupted or unknown run
still needs the [existing recovery controls](workflow-cli.md#processing-chat-controls).

Provider setup belongs to the native client; see its
[Foundry](https://code.claude.com/docs/en/microsoft-foundry),
[Bedrock](https://code.claude.com/docs/en/amazon-bedrock),
[Google Cloud](https://code.claude.com/docs/en/google-vertex-ai) and
[network configuration](https://code.claude.com/docs/en/network-config) guides.

## Entry and reuse

Use the existing skill with the exact argument `process`: type
`$cuefluent-notes process` in Codex or `/cuefluent-notes process` in Claude.
Loading the skill, setup, status and direct saves do not start a processing
session. In a configured source chat the skill calls
`cuefluent_control.process_selected_captures`. The source adapter verifies
native call metadata against that selected session's actual call record. If the
collection is omitted, bounded existing binding metadata (selection or
processing-only binding) must identify exactly one collection. It never selects
a recent session by project path.
Unprepared collections with no matching registration are skipped. A candidate
binding with unsafe storage still fails closed; explicitly select a healthy
collection when implicit discovery cannot complete. Claude can rebind a stale
MCP launch session ID after `/clear` only by finding the exact native tool-use ID
in one already registered, authorized source. Discovery and source reads have
finite entry, byte and attempt limits. Exceeding them reports `PROCESSING_SOURCE_DISCOVERY_LIMIT`; reconnect the MCP server in
the intended session instead of guessing a source.

Independent agent-created Codex chats are supported when they satisfy the
[root ownership contract](session-workflow.md#codex-reader-contract). Delegated,
forked and inherited histories remain unsupported.
`PROCESSING_CONTROL_REGISTRATION_UNVERIFIED` means an exact Codex hook registration
exists with a current collection grant, but no collection selection or
processing-only binding was found. This is an observation of metadata, not a
worker status: the source may be waiting for a native boundary or may have already
been refused. It does not promise that waiting or retrying will succeed. The
control does not read the transcript, launch a worker, or start processing from
this hint. Inspect collection status for a diagnostic matching the exact session;
an absent diagnostic does not prove verification is still pending. Follow any
identified refusal before retrying. When the session is still selected for active
collection, a registration that no longer matches its current grant reports
`REGISTRATION_REQUIRES_REVIEW`. Do not reset consent or the stored floor to clear
either message. When collection is off or the session is no longer selected,
old collection registrations do not request grant review; without another current
binding the control reports `PROCESSING_CONTROL_SOURCE_UNVERIFIED`. If collection
is intentionally off, use a processing-only binding under existing processing
policy, or the [standalone explicit workflow](processing.md), without enabling
collection. Excluded or unconfigured routes do not gain processing authority from
an old registration. A failed binding takes precedence over registration-only
hints in other collections; explicitly selecting a collection can disambiguate.

For Codex, `UNSUPPORTED_SESSION_OWNERSHIP` means authorized native verification
actually rejected the invoking session's ownership metadata. Use a supported
independent root chat; do not edit the transcript or bypass its ownership checks.
`UNSUPPORTED_CODEX_HISTORY` reports an unsupported or changed history mode;
`SOURCE_IDENTITY_MISMATCH` reports metadata inconsistent with the bound source,
including its project directory. These checks also apply to resumed metadata in
the authorized tail. Preserve the source and binding and inspect their mismatch;
do not rewrite the transcript, reset the floor or claim a new identity to bypass it.
Missing registrations and other unproven calls still report
`PROCESSING_CONTROL_SOURCE_UNVERIFIED`. These refusals
leave captures, proposals and notes unchanged. In Claude these source checks
report `PROCESSING_CONTROL_SOURCE_UNVERIFIED`, with a reply that nothing was
applied: its launch-session hint may be stale and another registered candidate
may have failed, so that failure does not establish that the invoking chat is
unsupported.

Explicit collection requests verify private storage and use guarded intake reads
before classifying source metadata. Known storage refusals remain path-free:
`UNSAFE_INTAKE_PATH`, `UNSAFE_PRIVATE_STORAGE`, `STORAGE_NOT_PRIVATE`,
`INTAKE_ROOT_CHANGED` or `PRIVATE_STORAGE_CHANGED`. Check the selected storage
against the [private-storage requirements](session-workflow.md#private-storage-and-explicit-pruning)
before retrying; do not relocate locks or discard state to bypass the refusal.

The adapter briefly retries missing native records in the selected source because
client persistence can lag tool dispatch. Claude's registered-source fallback
runs once after that wait, or immediately if the launch session is unavailable.
Stopped captures, over-limit tails and changed selections cannot supply a binding,
but do not block another registered session from proving the exact call. A matching
call with invalid arguments, tool identity or duplicate records is refused without
retrying or substituting another session. Within the same wait the adapter also
repeats a private-storage check that a concurrent collection worker kept busy
(directories still gaining or losing entries on every attempt while no privacy
check failed); if that outlasts the wait, the refusal is
`PRIVATE_STORAGE_CHANGED`. Other storage and source-identity failures still stop
verification at once.
A Codex code-mode call needs a separate verification handshake:
`verification-required` returns an opaque `retryToken` without delivering evidence,
starting processing or opening a review. End the current exec, then repeat the
same tool and arguments with that token in a new exec. The adapter checks the
original completed native MCP event, arguments, exact challenge response and
unchanged source selection. Tokens are short-lived, single-use and local to the
connection; they grant no authority themselves. An expired, cancelled, changed or
unverified request stops without dispatch. No JavaScript text is treated as proof.
The retry can briefly wait for the original inner event and outer result to finish
persisting. It never dispatches from a partial pair or retries the processing run.

Pausing collection preserves the registered source for independently authorized
processing, status and review. Verifying a new native control does not resume
collection, extend its saved boundary or create a capture of the paused input.
Sources selected only through explicit capture also support these controls.
When processing is enabled but collection is off, hooks register only source
metadata and its current byte boundary. The explicit control request verifies
the source and reads at most its recent 2 MiB after that boundary. No capture
interval or worker is created. A policy change requires a fresh applicable hook
binding. Unconfigured and entirely disabled hooks still write nothing; explicit
CLI processing remains available without a native source-chat binding.

Return only the tool's `statusText` for an exact formal control invocation. Do not
read packets or notes, synthesize a draft, print diagnostics containing source text,
or add commentary in the source chat. A natural-language request typed without
the skill command may also dispatch, but it is not proof that the input contains
no original work. Its text, facts, attachments and corrections remain eligible
for normal collection; this plugin's control traffic in that turn does not (see
[capture prevention](#capture-prevention-and-limits)). After the skill command,
verified inexact text dispatches nothing; see [review controls](#review-controls).

The processing client has only the selected engine tools: inventory, operation
status, bounded preparation, page reads and acknowledgments, note inspection,
note preparation, proposals and fully inspected no-change completion. It cannot
run arbitrary shell commands, browse, change settings, trust hooks or approve its
own proposal. Inherited hooks, plugins and unrelated tools are disabled and checked
before processing starts. Collection settings in the work project stay unchanged.

### Shortcut scopes and continuation

The [commands](#commands-and-replies) work alike in both clients. Plain `process`
selects pending retained evidence across the existing collection, including
configured repos and both clients. `process repo` uses the nearest verified Git checkout and excludes
separate nested repositories. `process chat` selects the invoking native session.
The invoking chat proves the request; it is not the default evidence boundary.
These actions never create a new route or change collection settings.
For worksets and operation resumes, the worker receives the invoking source
separately from its evidence binding. The engine's exact bound inputs retain
their original sessions and clients, even when another chat requests the run.

Selection begins with metadata, preserves exact head hashes, and resumes existing
unfinished operations with a verified stopped native owner before admitting more
evidence. A standalone claim without that proof stays preserved for explicit CLI
handling; the shortcuts cannot infer that its agent has stopped. Processing handles bounded
batches sequentially in the reusable isolated session. It stops for an exact
proposal, an unfinished operation, a conflict, recovery, lack of progress or a
run limit. A completed no-change operation allows another batch. Already handled
revisions are not admitted again. A changed head is new evidence, not permission
to replace an existing conflicted claim.

`process resume` keeps the saved evidence selection and inspection checkpoints. It does
not add captures that arrived later, and reports a no-op when no unfinished work
exists. A `process` request also resumes saved unfinished work first; it reports
that selection's actual scope. A conflicting narrower request is refused rather
than replacing it. After finishing prior work, `process` can select one fresh
bounded portion in the requested scope within the same request limits. Invoke
`process` again for later inventory portions. Discovery and selection limits are in the
[shortcut command contract](workflow-cli.md#processing-shortcut-checkpoints).
An incomplete inventory is never reported as an empty backlog. If the saved
selection reaches its continuation capacity, status directs you to cancel that
selection and use `process` for the remaining captures. Changed or unavailable
frozen inputs stay reported as conflicts; independent unchanged inputs can
continue without replacing their hashes.

The checkpoint contains scope, frozen inputs and continuation pointers. Existing
engine worksets, claims, acknowledgments, proposals and outcomes remain the
source of truth. It supplies no independent save or completion authority. Each
proposal still needs its exact review decision.

Redelivery of an exact verified formal call returns its original admitted response
without dispatching again, reopening a review form or rewriting its receipt. That
response can still describe admission after completion; use `processing_status`
to read current progress. New responses distinguish **Processing request accepted**
from **Already processing; no additional run was started**. A status read reports
**Processing is in progress** while the native run remains busy. Acceptance does
not prove that the model has started reading evidence or completed a note.
Older stored replies retain their original `busy` wording on exact replay.
If the native run stopped but its engine operation remains unfinished, status
reports **Processing stopped with unfinished work** and a resume or inspection
action. Status also separates frozen-selection progress from the bounded
collection inventory and lists the collection's unfinished operations and draft
count. Inventory counts describe only the examined page; partial inventory and
unknown source completeness remain explicit. An unknown outcome or recovery
requirement calls for inspection, not a replacement operation.
**No processing run is active** describes execution only; it does not
assert that the collection has no pending captures or that notes were saved.
Keep the source client and its MCP host open until processing reaches a review or
terminal state. A one-shot client that terminates the host after admission can
interrupt the run; use the existing status and recovery controls rather than
assuming the background work completed.

A native request cancellation received while admission is pending releases that
admission without starting the model turn or returning a response. Once admission
has completed, cancelling that finished request does not cancel the separate run
or undo a saved note. The separate `process cancel` action stops only native execution
owned by this connected controller and waits for a verified terminal result
before releasing unapplied claims. Unknown or externally owned execution reports
`PROCESSING_CANCEL_UNVERIFIED`; preserve it for recovery. Cancellation is durable
and resumable if interrupted; invoke `process cancel` again to finish it. It never adopts
unrelated standalone claims or drafts. Within the saved selection, it also cancels
owned unsaved proposals, which can no longer be saved through review. The evidence
and operation history remain on disk; generating a replacement proposal requires
processing again and can incur model usage. To preserve a proposal for later
approval, leave it undecided (or choose **Later** in the Codex form) instead. Cancellation keeps captures pending, preserves saved notes,
and leaves collection/processing preferences unchanged. A new `process` request
can select those pending captures after cancellation completes. This also provides
a fresh selection after a policy change or an unavailable frozen input, without
rewriting the old claim hashes. `PROCESSING_CHAT_HISTORY_FULL` requires guarded
`processing-chat-rollover` before resuming; see the
[shortcut command contract](workflow-cli.md#processing-shortcut-checkpoints).

The restricted channel accepts at most 256 KiB of serialized engine output per
tool result. A larger result returns `PROCESSING_ENGINE_OUTPUT_LIMIT` without
truncating evidence or terminating the chat. Use the explicit CLI from an
uncaptured context for material that cannot fit this channel.

### Unfinished operation ownership

`PROCESSING_OPERATION_OWNER_UNVERIFIED` means an unfinished engine operation cannot
be tied to a recorded native run that has stopped. It can affect standalone CLI
operations and operations from older archived runs whose operation-to-request
reference was never recorded. An operation's existence is not proof that its
processor is stopped. The shortcut does not invent ownership or replace its claim.

Before a fresh selection, unfinished work is checked across the collection;
unverified work can block `process` and `process resume` even when only another repository
or chat was requested. An operation outside a narrower requested scope can instead
report `PROCESSING_SHORTCUT_SCOPE_CONFLICT`. Existing authorized proposals remain
available through `review`, subject to the usual execution and recovery guards.

Confirm that the prior processor has stopped, inspect the affected operation and
use the [explicit processing workflow](processing.md#outcomes-and-recovery) to
finish it or safely cancel unapplied work. Shortcut `process cancel` refuses with
`PROCESSING_CANCEL_UNVERIFIED` when it cannot establish ownership; it is not a way
to clear standalone or unverified operations. Keep claims, proposals and recovery
state intact until the supported operation succeeds.

## Review controls

Invoke the same skill with `review` (or `review <code>` for one draft). Its
`cuefluent_control.processing_review` call writes the exact outstanding proposal
to a private review folder in the collection's private state, never in the notes
folder or the project, and replies with links to the folder and each listed
file's proposed copy (see [commands and replies](#commands-and-replies)), each
note path with its size, and the decision commands. A review the model started
without your typed command shows the draft too, but you still type `review
<code>` yourself before deciding; its reply says so. Open the folder in any editor:

- `proposed.md` holds the exact Markdown that Save would write, and `current.md`
  the note as it is now when the draft updates an existing note. A draft with
  several files numbers them (`1-proposed.md`, `1-current.md`, `2-proposed.md`;
  from ten files on, with leading zeros, as in `01-proposed.md`).
- `summary.txt` lists the note paths and sizes, new folders, source sessions and
  turns with their known limits, inspection coverage, the draft code, the exact
  decision commands and the revision's operation, claim and proposal hashes.

The folder is a read-only copy; editing it changes nothing. It is removed when the
draft is decided through review, or by a later review once the draft is replaced
or no longer pending, together with Finder's `.DS_Store`; other files an editor
added keep it until you delete them, and never affect a decision. At most 32
review folders are kept, the oldest removed first. Drafts whose sources are no longer authorized remain
preserved and are not offered. When several drafts are pending, `review` shows one
and lists the others by code and note path.

A draft code is six letters and digits derived from the exact proposal. A
replaced proposal gets a new code. Decide by typing one command yourself:
`save <code>` writes the exact proposal through the existing writer,
`skip <code>` handles only those captures without saving, and `review cancel
<code>` releases the unapplied operation and keeps its captures pending. To keep
the draft pending, type nothing. In Claude, prefix these with `/cuefluent-notes`;
in Codex, with `$cuefluent-notes`.

A decision applies only when all of these hold:

- the exact command was typed in the chat and verified from the native transcript;
  model text, a natural-language reply or a tool argument the model chose is
  refused. A near miss after the skill command (other case or spacing, a
  misspelling, a missing or extra word, an invalid code) or a command mixed with
  more words, lines or content is not a command and decides nothing; neither
  does a plain-language request that starts with `save`. When that typed input
  is verified from the transcript, no tool the model calls applies anything, and
  the reply names the nearest exact command to type;
- this chat was shown that exact revision by a typed `review` whose reply reached
  the chat, recorded durably in private state; a draft never shown here, shown only
  by a natural-language request or a model-initiated call, or whose review was
  cancelled before its reply, is refused even when its code is given;
- the draft's claim, proposal and destinations still match, rechecked before
  anything is staged. Otherwise nothing is applied, this chat's stale record and
  folder are removed, and the reply names the cause that applied: the draft
  changed after this chat was shown it (review it again), a note at its
  destination changed (restore the note or process again), the draft is not
  pending, or its review here is no longer current (review it again).

Without a code, `save`, `skip` and `review cancel` apply only to the revision this
chat was most recently shown by a typed `review`.
If that display came from a natural-language request or a model-initiated call, or
nothing was shown, the reply lists the pending drafts and nothing is applied. Being
the only pending draft or the only review folder never selects a draft. No
filesystem lock spans the decision.

Codex also opens its native host form for the same exact proposal, naming the review
folder in its header; a proposal too large for the form is reviewed through the
folder and typed decisions instead. When several proposals are pending, it first asks you to
choose one in a native selector; selecting a draft is not approval. Read the full
preview in the scrollable **Proposed changes** field, then advance to **Proposal
action**. Choose **Save exact proposal**, **Skip these captured turns without saving**,
**Cancel operation; keep captured turns pending** or **Later; keep proposal pending**. No
action is selected by default. The host's own **Skip** or dismiss control is not the
proposal's Skip action; it leaves the proposal pending. A host response is distinct
from a model tool argument; it does not establish that a person physically clicked
rather than a host policy answering the form. Codex accepts the same typed decisions,
for example after choosing Later in the form, including when Codex runs the tool
call through its code mode. A Codex host without form support reviews through the
folder and typed decisions only.

The **Proposed changes** field is optional, so a host that shows it empty (Codex
CLI 0.163 does) still lets you choose Later or close the form; read the proposal in
the review folder instead and decide by typed command. Save, Skip and Cancel in the
form apply only when the host returns the preview unchanged. Changes to
note contents, proposals, inputs or policy preserve a conflict and require fresh
review. The form requires MCP `2025-11-25` string-default support. The server offers
that protocol even if the host initially requests an older version. Hosts unable to
accept it must use the explicit CLI workflow. A proposal whose form text would
exceed the 256 KiB form limit is not truncated: Codex skips the form and reviews
it through the review folder and typed decisions.

The form preview displays the proposal; it is not an editor. Note-content lines
are prefixed with `│ `, and control characters and backslashes are visibly escaped
so note text cannot imitate the review's headings or terminal controls. Each
file's original and proposed line endings are summarized separately. These display
changes do not alter the Markdown that Save writes. Host LF/CRLF/CR line-ending
conversion is accepted when the rest of the preview is unchanged. If the host
returns edited, trimmed, collapsed or missing preview text, no form decision is
applied; the exact proposal remains pending and the stored draft is not treated as
changed. Later is the exception that needs no intact preview, because it applies
nothing.

The review result reports what happened, separately from whether a draft exists:
presented, completed (saved, skipped or cancelled), deferred with Later, declined
or closed, display altered, not shown in this chat, not typed by you, changed, or
no draft named. A decline does not show whether a form appeared. Return that result
to the user; do not describe a pending draft as a review that was displayed.

### Claude limitations

Claude Desktop 2.42304.0 declines review forms without displaying them, and Claude
CLI 2.1.294 and 2.1.299 clip form text, so Claude never uses the review form: it
reviews through the review folder and typed decisions. The review reply is a short
paragraph, and the skill has the assistant return it as its own reply, so the
folder path and commands stay visible however the client displays tool results.

A typed control also works as the first prompt of a new Claude session whose
hooks registered it: the control binds through that registration record within a
bounded read of the transcript's start, as described under
[processing chat controls](workflow-cli.md#processing-chat-controls). Claude can
create a new session's transcript only after that prompt's hooks ran; the
collection worker then records the session's starting point itself, and the
binding briefly waits for it. If Claude
keeps its tool process across `/clear`, the new session is found only among
sources that already have a selection or a processing-only binding, so a control
as its first prompt can still be refused until its collection is armed.

A presentation belongs to the chat lineage that showed it. When Claude CLI
continues a session into a new session ID, for example when it moves the session
to the background, and both sessions are registered for collection, the new
session joins the same lineage once both transcripts agree; see the
[Claude reader contract](session-workflow.md#claude-reader-contract). A typed
decision there, including a bare `save`, then applies to a draft reviewed before
the move. Claude CLI writes the new session's transcript only at its first prompt,
so the link is recorded when that prompt's hooks run; a typed `save` as that first
prompt then binds. Until the link is recorded, drafts reviewed before the move are
not decidable there, and controls in a Claude CLI background session are refused,
with nothing applied. Once the link is recorded, the original session has handed
its lineage on: a command typed there again, for example after resuming it, is
refused with `PROCESSING_CHAT_CONTINUED` and applies nothing. Continuations on
processing-only routes are not joined.

For a factual correction, leave the draft undecided (or choose Later in the Codex
form) and provide the correction in the ordinary work chat. Capture it through
the existing selected-source workflow before using
it to revise the proposal. A message combining approval and a correction remains
original input, never a pure control. The restricted processing session does not
silently admit new chat text as evidence. If original-input intake is unavailable,
retain the input in its native chat and report that incorporation is blocked.

## Capture prevention and limits

Dedicated processing starts with inherited collection hooks disabled. Completed
restricted runs can also seal exact native record ranges for subsequent selected
collection. The reader revalidates those bytes, identities and current permission;
a session title, stored role or matching text alone grants no exclusion. Codex
proof covers the completed restricted unit, including native code-mode cells
whose inner tool events are restricted to the engine contract. Claude proof covers its exact controller
input; ordinary assistant/tool parentage still does not establish Claude ownership.

A verified Codex control turn is excluded with its receipt in either message
form (the skill part of the message, or Codex CLI 0.163's mention from the `$`
list with its selection item) and either call form (a direct call, or code
mode's two verification cells with any `wait` on the second). The proof covers
the whole completed turn and admits only: the typed message and its mirror, the
selection item, native and hook context, the call with its native MCP items and
outputs, and the one final reply, which must be the control's own status text
byte for byte; a reply the model reformatted keeps the turn collectible, where
the relay rule below still leaves it out.
Commentary or any other assistant message is the assistant's own text and keeps
the turn collectible, however short. Each code-mode cell must print exactly what its
call returned. The receipt names both cells and the retry call by the native IDs
Codex sent with the call; model-written code is never read, so a nested tool that
leaves no native record is not visible to the proof. Anything else in the turn,
such as reading a file, another tool, another message or other printed output,
keeps the turn collectible as described below, so recorded work and corrections
are never hidden. Such a turn still never contributes its exact command, this
plugin's control calls or the assistant's repetition of the plugin's reply; see
the [command markup rules](session-workflow.md#generated-output-provenance-gate). A verified control that could not record that receipt, for example
because collection progressed during admission, reports
`PROCESSING_EXCLUSION_UNVERIFIED`.

Claude Desktop records a `bridge-session` row in a session connected for Remote
Control. The Claude reader does not read past such a record, so automatic
collection of that session stops there with `CLAUDE_HISTORY_REQUIRES_REVIEW`:
captures made before it stay valid and nothing after it is collected. When
collection had already started for the session, typed commands there still work,
and a `status` reply says that collection has stopped. When the session was
connected before collection started, as when Desktop connects every new session,
collection never starts for it: only a command typed as its first prompt is
confirmed, and later commands are refused as unconfirmed, however often they are
typed. Type commands in a session that is not connected, or turn off connecting
new sessions to Remote Control first. Resetting the selection or floor does not
resume collection of such a session.

In the source chat, only a verified formal skill control, actual controller call and
receipt can exclude processing control input. Claude also checks the exact
installed skill expansion and its native companion; it can verify the formal
input when the actual MCP result arrives, without relying on final assistant
wording. While proof is incomplete, the collector preserves the input and its
cursor as pending rather than calling it excluded. A later independent human
input releases an unsupported Claude candidate to ordinary capture. Genuine work
before and after the control retains its own identity and order. Mixed inputs, altered bytes, unknown
attribution and unsupported shapes remain evidence or explicitly pending. A
message that selects the skill without a verified control stays evidence: Claude
keeps the typed arguments without the command markup (empty arguments add
nothing), and Codex keeps the user text but not the skill block, the selection
item, the mention the `$` list inserted, or this plugin's own control-server
calls, results and code-mode cells that only made such calls in that turn. A
Codex mention typed out by hand attaches no skill, so its message is kept
exactly as typed, and so is a request in the person's own words without the
skill. In every Codex turn, with or without the skill, this plugin's control
calls, their results, code-mode cells that only made such calls and an
assistant message that only repeats one of their replies (a status, the command
list, a not-a-command reply or a refusal) are left out, identified by native
identity, never by text. The message and the reply are compared after one
[defined Markdown normalization](session-workflow.md#generated-output-provenance-gate),
so a relay the model only reformatted (its own link form, a blank line before a
list, indentation) is left out too. The assistant's own words, a paraphrase
(such as a refusal relayed in other words), a reply with words added, other
tools and a cell that also did other work stay. Claude captures only human
input, so no tool call, result or assistant reply is captured from it in any turn.
See the [session contract](session-workflow.md#generated-output-provenance-gate).
Existing captures, active claims and issued packet hashes are never rewritten by
this path. Copies printed in unrelated work chats are not automatically detected.
If collection progress changes during admission, processing rechecks its own
authorization and may continue without a parent exclusion receipt, reporting
`PROCESSING_EXCLUSION_UNVERIFIED`. The inspected selection hash is never silently
refreshed to manufacture proof. Policy changes still stop the request.

The processing execution state is separate from operation progress, source
completeness and knowledge outcomes. A finished processing turn can leave an
unread operation or pending proposal; reading every retained page can coexist with
omitted original evidence. Report those distinctions through the existing
[processing interface](workflow-cli.md#processing-selected-captures).

Unknown creation or dispatch outcomes never silently create another session or
steal an operation. A proven pre-dispatch failure releases admission for an exact
retry using freshly inspected status. A protocol-reported terminal releases the
execution even when exclusion sealing is unavailable; status reports
`PROCESSING_EXCLUSION_UNVERIFIED`, and no exclusion receipt is invented. A known
terminal whose engine state could not be inspected remains blocked with
`PROCESSING_OPERATION_OUTCOME_UNKNOWN`; reconciliation inspects that operation
without restarting the native turn.

For Claude CLI recovery, preserve the original run's
`CUEFLUENT_CLAUDE_AUTHENTICATION` and `CLAUDE_CONFIG_DIR` selection, including an
unset profile locator. Claude's settings-file `env` is not automatically present
when running the Node CLI directly in a terminal; explicitly select the same
mode and profile. Do not change namespaces to bypass a blocked run.
Use `processing-chat-status` and the exact guarded
`processing-chat-reconcile` command. Codex can reconcile a sealed completed,
failed or interrupted native unit after verifying its terminal and unchanged
source. Failure and interruption remain distinct in recovered status; neither
grants completed-output collection exclusion. Claude's
input-only proof does not establish that a crashed execution stopped, so its
unknown outcomes remain blocked. Unsealed or unverifiable unknown outcomes also remain
blocked with their operation intact.
Reconciliation refuses a live or unverified controller owner and never resumes
the native chat merely to inspect it.

If reconciliation cannot prove a terminal outcome, an operator can explicitly
retire that run with `processing-chat-abandon`. First stop the owning controller
and its native child client, inspect the exact chat hash and request ID, and
confirm the offline window with `offline: true`. A known live or unverified owner
is refused; older ownerless records require that explicit offline confirmation.
The command archives the prior binding without deleting captures, claims,
proposals, writer transactions or native chats. Inspect any unfinished engine
operation and use its ordinary resume, review or recovery commands. Abandonment
does not mark evidence handled, save a note or prove an exclusion. Only a later
explicit request with a new request ID can create a replacement session in the
same namespace; it never resumes the retired native chat. Retries of the abandoned
request are refused. After retirement, invoke `process resume` to continue the saved
selection, or `process` to apply its ordinary unfinished-selection-first behavior.
Both require a fresh native call and current launch authentication; neither
automatically resolves an unfinished claim or bypasses recovery. Status clears
the retired chat and request identifiers and any historical launch diagnostic.
A retained unfinished claim without verified terminal ownership instead reports
`PROCESSING_OPERATION_OWNER_UNVERIFIED` and requires inspection. Published proposals
remain `awaiting-review`; resolve them before starting another native run. Engine
reinspection reservations and unfinished input conflicts also block new runs,
even when the claim has a verified terminal owner. Collection-wide recovery also
blocks retired-session replacement after the last claim is released, until its
transaction cleanup completes. `PROCESSING_OPERATION_CONFLICT` requires inspecting
the retained operation for its exact conflict before any explicit resolution. An unknown outcome still requires inspection; it does not
establish that a client is still running.
A failure proven to precede `thread/start` needs no abandonment: it can retry using
freshly inspected status after the client issue is fixed.

After a settings change, `processing-chat-reauthorize` explicitly accepts the
current policy for the registry using its inspected hash and previous policy
hash. It does not change old claims, proposals, approval hashes or missing
execution proof. At the 128-run active-history limit,
`processing-chat-rollover` archives settled history with replay protection while
retaining the same chat. It refuses active or unresolved review state; it neither
deletes evidence nor starts a replacement session.
Rollover also preserves exact operation-to-request references to terminal runs,
so shortcut resume and cancellation can verify stopped owners after active
history is cleared. These references do not override a currently active or
unresolved native owner. Missing or invalid proof remains a refusal.
New sealed executions have a request-keyed recovery record, so recovery does not
scan the session's lifetime history after rollover. Older unindexed receipts retain
their bounded lookup and are never rewritten to infer missing authority.
Do not edit the private registry, delete locks or create a replacement to bypass
that state. The supported offline abandonment above is the explicit retirement
path. Hostname changes preserve the unique binding in the machine-local store;
ambiguous historical bindings are refused. Missing/archived chats and changed profiles require an explicit
resolution, not lookup by title. See the [CLI schemas](workflow-cli.md#processing-chat-controls).

The explicit CLI processing commands remain available for standalone agent use.
Run manual synthesis in a context outside automatic collection when avoiding
feedback is necessary. Automatic processing from hook notifications and transparent
exclusion of arbitrary natural-language turns are unsupported. Successful CLI/MCP
transport does not establish desktop sidebar visibility or review-form usability.
