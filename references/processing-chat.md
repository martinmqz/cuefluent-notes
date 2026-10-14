# Processing in a reusable chat

The installed plugin can hand an explicit processing request to a dedicated native
Codex or Claude session. It reuses one session per collection, client, machine and
client profile. Several source projects can use that session. The existing engine
still owns evidence, claims, proposals, approvals, writer transactions and recovery.
Cuefluent does not need to be installed or running.

This path requires the matching native client executable on PATH and its normal
authentication. The native client resolves the model under the restricted
processing launch settings, including the supported Claude preferences described
below. Persistent status does not yet report the resolved model. The plugin does
not choose a provider or model independently of that configuration, install a
client, change authentication or run on a schedule. A desktop installation alone
does not establish that its CLI is available. Native protocol
support is checked at runtime; unsupported clients fail without inline processing.
Desktop sidebar visibility and navigation require separate live verification.
Status, review and registry recovery read the local client profile and stored
state without launching a native client. A native executable is needed only when
a request actually creates or resumes a processing run.

## Claude launch settings

Restricted Claude processing retains its existing native authentication and
supported provider, deployment and connection environment settings. Before each
eligible run, including session reuse, it reads the selected user profile's
`settings.json` (`~/.claude/settings.json`, or the profile chosen by
`CLAUDE_CONFIG_DIR`). A CLI launch outside Claude applies supported user `env`
values over inherited shell values, as native user settings do. A verified Claude
chat handoff, or a CLI launched from Claude with its native `CLAUDECODE` nesting
hint, preserves values already supplied by the host environment, using the user
profile only for missing values, except for host-managed routing described below.
The hint changes environment precedence only;
it supplies no session identity or permission. This keeps exported project account,
endpoint and model selections intact. Supported profile model preferences,
mappings and allowlists are passed as restricted settings;
native managed policy and environment-model precedence remain in force.

The user file is reread before each eligible run, but an inherited host value
still wins. The plugin cannot tell whether that value came from the old user
settings or an intentional project override. Rotating a profile credential does
not replace an inherited credential in a running MCP server. Restart the source
client and reconnect its plugin MCP server so the updated host environment reaches
the next request; do not discard the processing registry or captures. An ordinary
CLI launch without a host override picks up the new profile value on its next run.

Some hosts declare managed authentication with
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` or `CLAUDE_CODE_HOST_AUTH_ENV_VAR`.
A managed host must provide an explicit credential locator and its nonempty
inherited value to the separate processor. Missing, empty or unusable handoffs
report `PROCESSING_CLIENT_HOST_AUTH_UNAVAILABLE` before acknowledging a finished
review, freezing a new shortcut workset, or reserving a native run. Exact completed
control replies can still replay. No model is started and no evidence is claimed.
The plugin does not fetch host secrets, replace them from user settings, or switch
to another provider.

In host-managed mode, inherited routing and authentication own even absent fields.
Profile provider selectors, endpoints, credentials, client certificates and
credential-helper commands are ignored. Supported proxy, CA, timeout and output,
thinking and effort defaults can fill missing connection/tuning fields; inherited
host values win. Supported structured model preferences still pass as settings.
A disabled managed-host flag alone keeps ordinary profile projection. Credential
presence only permits launch; it does not verify authentication, expiry, or a host
refresh channel.

Use the [standalone workflow](processing.md) in an explicitly selected uncaptured
chat whose normal authentication works, or invoke processing from an independently
authenticated Claude terminal. Do not unset host routing or authentication markers
inside the failing host to force a different account. Status and pending-proposal
review do not need this launch credential. A run that already failed with an
unknown outcome still requires the existing recovery controls below; this
preflight does not clear it.

The projection restores supported first-party/gateway, Foundry, Bedrock/Mantle
and Vertex environment settings. Connection controls include uppercase and
lowercase proxy variables, `API_TIMEOUT_MS`, certificate settings, and native
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` and `MAX_THINKING_TOKENS` tuning. Unrelated keys
and feature toggles are ignored, without interpreting every `CLAUDE_CODE_USE_*`
name as a provider. The known unsupported provider selectors
`CLAUDE_CODE_USE_ANTHROPIC_AWS` and `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD` are
refused when enabled in projected user `env`. Host-managed routing ignores those
unused provider switches. Other unrecognized file environment keys
are not restored; use the standalone workflow when the native setup depends on
them. Execution controls such as file-based `PATH`, `NODE_OPTIONS` and engine
authorization are never restored.

Stored structured effort preferences (`effortLevel` and `modelSettings`) are not
restored. Their user-profile semantics differ from launch-level settings, so the
processor does not translate them into a global effort override. To select effort
for restricted processing, supply `CLAUDE_CODE_EFFORT_LEVEL` through the host
environment or the supported user-profile `env` settings. Otherwise the native
client resolves effort without those stored preferences; see its
[effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level).

Authentication values remain in process memory and environment, never command
arguments, proposal receipts or plugin diagnostics. A missing user settings file
retains the inherited environment. The processor does not discover project
settings, restore Claude's credential-helper command settings, restore unrelated
profile settings, or modify authentication. Project-specific configuration must
already be supplied through the calling host's environment; project-specific
structured settings are not read. Hooks, plugins, slash commands and arbitrary
tools remain disabled; native runtime verification still requires the sole
selected engine and its exact tool set.

The inherited `CLAUDE_CONFIG_DIR` stays unset when unset, and keeps its exact
spelling when set. Changing it can change native credential-store selection even
when it names the same physical folder. The registry and exclusion lookup use the
verified canonical profile. Profile aliases are rechecked before dispatch and
engine calls, but are not locked across native startup; a changed or unverifiable
profile stops processing without granting an exclusion or replacing state.

`PROCESSING_CLIENT_SETTINGS_INVALID`, `PROCESSING_CLIENT_SETTINGS_UNAVAILABLE`
and `PROCESSING_CLIENT_SETTINGS_LIMIT` stop before native admission when settings
are malformed, inaccessible, changing or over their bounded limits. The `env`
shape and entry-count checks still apply in host-managed mode, while value checks
apply only to eligible fields. File size, JSON/duplicate-key, structural and
supported model checks apply in both modes. Ask the user
to resolve the selected native settings in the client without printing settings
or credential values. Keep existing processing state intact.
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

Use the existing skill with the exact argument `process`: select Cuefluent Notes
in Codex and enter `process`, or use `/cuefluent-notes:cuefluent-notes process` in
Claude. Loading the skill, setup, status and direct saves do not start a processing
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
leave captures, proposals and notes unchanged. Claude retains a generic refusal
when these source checks fail during discovery: its launch-session hint may be
stale and another registered candidate may have failed, so that failure does not
establish that the invoking chat is unsupported.

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
retrying or substituting another session. Storage and source-identity failures
still stop verification.
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
or add commentary in the source chat. A natural-language request may also dispatch,
but it is not proof that the input contains no original work. Its text, facts,
attachments and corrections remain eligible for normal collection.

The processing client has only the selected engine tools: inventory, operation
status, bounded preparation, page reads and acknowledgments, note inspection,
note preparation, proposals and fully inspected no-change completion. It cannot
run arbitrary shell commands, browse, change settings, trust hooks or approve its
own proposal. Inherited hooks, plugins and unrelated tools are disabled and checked
before processing starts. Collection settings in the work project stay unchanged.

### Shortcut scopes and continuation

Use the [formal skill actions](../SKILL.md#formal-processing-controls) in either
client. In Claude, append the action to `/cuefluent-notes:cuefluent-notes`; in
Codex, select Cuefluent Notes and type the action. Plain `process` selects pending
retained evidence across the existing collection, including configured repos and
both clients. `process repo` uses the nearest verified Git checkout and excludes
separate nested repositories. `process chat` selects the invoking native session.
The invoking chat proves the request; it is not the default evidence boundary.
These actions never create a new route or change collection settings.

Selection begins with metadata, preserves exact head hashes, and resumes existing
unfinished operations with a verified stopped native owner before admitting more
evidence. A standalone claim without that proof stays preserved for explicit CLI
handling; the shortcuts cannot infer that its agent has stopped. Processing handles bounded
batches sequentially in the reusable isolated session. It stops for an exact
proposal, an unfinished operation, a conflict, recovery, lack of progress or a
run limit. A completed no-change operation allows another batch. Already handled
revisions are not admitted again. A changed head is new evidence, not permission
to replace an existing conflicted claim.

`resume` keeps the saved evidence selection and inspection checkpoints. It does
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
proposal still needs its exact native review decision.

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
or undo a saved note. The separate `cancel` action stops only native execution
owned by this connected controller and waits for a verified terminal result
before releasing unapplied claims. Unknown or externally owned execution reports
`PROCESSING_CANCEL_UNVERIFIED`; preserve it for recovery. Cancellation is durable
and resumable if interrupted; invoke `cancel` again to finish it. It never adopts
unrelated standalone claims or drafts. Within the saved selection, it also cancels
owned unsaved proposals, which can no longer be saved through review. The evidence
and operation history remain on disk; generating a replacement proposal requires
processing again and can incur model usage. Choose **Later** in review to preserve
a proposal for later approval. Cancellation keeps captures pending, preserves saved notes,
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
unverified work can block `process` and `resume` even when only another repository
or chat was requested. An operation outside a narrower requested scope can instead
report `PROCESSING_SHORTCUT_SCOPE_CONFLICT`. Existing authorized proposals remain
available through `review`, subject to the usual execution and recovery guards.

Confirm that the prior processor has stopped, inspect the affected operation and
use the [explicit processing workflow](processing.md#outcomes-and-recovery) to
finish it or safely cancel unapplied work. Shortcut `cancel` refuses with
`PROCESSING_CANCEL_UNVERIFIED` when it cannot establish ownership; it is not a way
to clear standalone or unverified operations. Keep claims, proposals and recovery
state intact until the supported operation succeeds.

## Review controls

Invoke the same skill with `review`. When several proposals are pending, first
choose an authorized draft in the native selector. Drafts whose sources are no
longer authorized remain preserved and are not offered. They do not prevent
reviewing other authorized drafts. Selecting a draft is not approval. Its
`cuefluent_control.processing_review` call requests a native host form displaying
the exact proposal, original note contents, paths, new directories, input identities
and known evidence limits. Read the full preview in the scrollable **Proposed
changes** field, then advance to **Proposal action**. Choose **Save exact proposal**,
**Skip these captures without saving**, **Cancel operation; keep captures pending**
or **Later; keep proposal pending**. No action is selected by default. The host's
own **Skip** or dismiss control is not the proposal's Skip action; it leaves the
proposal pending. Draft bytes
travel through that host-control channel; they are not returned as model tool
output to the source chat. A host response is distinct from a model tool argument;
it does not establish that a person physically clicked rather than a host policy
answering the form.

Save uses the existing exact-proposal writer. Skip handles only those revisions;
Cancel releases an unapplied operation; Later, declining or closing the form leaves
it pending. No filesystem lock spans the decision. Changes to note contents,
proposals, inputs or policy preserve a conflict and require fresh review. The form
requires MCP `2025-11-25` string-default support. The server offers that protocol
even if the host initially requests an older version. Hosts unable to accept it
must use the explicit CLI workflow; hosts lacking form support leave the proposal
pending. An exact review exceeding the 256 KiB form limit is refused without
truncation; use the supported explicit proposal and save commands from an
uncaptured context instead.

The preview field displays the proposal; it is not an editor. Note-content lines
are prefixed with `│ `, and control characters and backslashes are visibly escaped
so note text cannot imitate the review's headings or terminal controls. Each
file's original and proposed line endings are summarized separately. These display
changes do not alter the Markdown that Save writes.

Host LF/CRLF/CR line-ending conversion is accepted when the rest of the preview is
unchanged. Edited, trimmed or collapsed preview text is refused with
`PROCESSING_REVIEW_PREVIEW_CHANGED`, leaving the exact proposal pending. Reopen
review to restore the preview; if the host cannot preserve it, use the explicit
proposal and save commands from an uncaptured context.

For a factual correction, choose Later and provide the correction in the ordinary
work chat. Capture it through the existing selected-source workflow before using
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

The Codex code-mode handshake currently leaves its small source control turn
collectible and reports `PROCESSING_EXCLUSION_UNVERIFIED` for formal controls.
This does not disable the restricted processing chat's verified exclusion, and it
never hides genuine work or corrections in the source chat.

In the source chat, only a verified formal skill control, actual controller call and
receipt can exclude processing control input. Claude also checks the exact
installed skill expansion and its native companion; it can verify the formal
input when the actual MCP result arrives, without relying on final assistant
wording. While proof is incomplete, the collector preserves the input and its
cursor as pending rather than calling it excluded. A later independent human
input releases an unsupported Claude candidate to ordinary capture. Genuine work
before and after the control retains its own identity and order. Mixed inputs, altered bytes, unknown
attribution and unsupported shapes remain evidence or explicitly pending. Existing
captures, active claims and issued packet hashes are never rewritten by this path.
Copies printed in unrelated work chats are not automatically detected.
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
request are refused. A failure proven to precede `thread/start` needs no
abandonment: it can retry using freshly inspected status after the client issue is
fixed.

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
