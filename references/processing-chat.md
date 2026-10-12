# Processing in a reusable chat

The installed plugin can hand an explicit processing request to a dedicated native
Codex or Claude session. It reuses one session per collection, client, machine and
client profile. Several source projects can use that session. The existing engine
still owns evidence, claims, proposals, approvals, writer transactions and recovery.
Cuefluent does not need to be installed or running.

This path requires the matching native client executable on PATH and its normal
authentication. The native client resolves the model under the restricted
processing launch settings. Persistent status does not yet report the resolved model. It
does not supply a model override, install a client, select a provider, change
authentication or run on a schedule. A desktop
installation alone does not establish that its CLI is available. Native protocol
support is checked at runtime; unsupported clients fail without inline processing.
Desktop sidebar visibility and navigation require separate live verification.
Status, review and registry recovery read the local client profile and stored
state without launching a native client. A native executable is needed only when
a request actually creates or resumes a processing run.

## Entry and reuse

Use the existing skill with the exact argument `process`: select Cuefluent Notes
in Codex and enter `process`, or use `/cuefluent-notes:cuefluent-notes process` in
Claude. Loading the skill, setup, status and direct saves do not start a processing
session. In a configured source chat the skill calls
`cuefluent_control.process_selected_captures`. The source adapter verifies
native call metadata against that selected session's actual call record. If the
collection is omitted, bounded existing registration metadata must identify exactly
one collection. It never selects a recent session by project path.
Unprepared collections with no matching registration are skipped. A registered
candidate with unsafe storage still fails closed; explicitly select a healthy
collection when implicit discovery cannot complete. Claude can rebind a stale
MCP launch session ID after `/clear` only by finding the exact native tool-use ID
in one already registered, authorized source. Discovery and source reads have
finite entry, byte and attempt limits. Exceeding them reports `PROCESSING_SOURCE_DISCOVERY_LIMIT`; reconnect the MCP server in
the intended session instead of guessing a source.

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

Each request resumes existing selected work and handles at most one bounded
operation. It stops at a proposal, no-change result, a conflict or recovery
requirement. Further requests reuse the same processing session. Busy requests
do not dispatch duplicate work. An outstanding proposal must receive a disposition
before another operation starts. Engine page acknowledgments and proposal hashes,
not conversational recollection, determine the resume point.
A repeated process request while review is outstanding returns `awaiting-review`
without launching the client. A narrower unit-scoped operation in the selected
session resumes with its original selection. An operation spanning other evidence
is listed as a blocker with `resumeSupported: false` and
`nextAction: inspect-with-original-selection`; inspect it through the explicit CLI
with its original scope. It does not prevent listing the other pending work.

Redelivery of an exact verified formal call returns its original admitted response
without dispatching again, reopening a review form or rewriting its receipt. That
response can still say `busy` after completion; use `processing_status` to read
current progress. A `busy` result with no busy diagnostic acknowledges the
accepted run; it does not mean the request was rejected as another run.
Keep the source client and its MCP host open until processing reaches a review or
terminal state. A one-shot client that terminates the host after admission can
interrupt the run; use the existing status and recovery controls rather than
assuming the background work completed.

A native request cancellation received while admission is pending releases that
admission without starting the model turn or returning a response. Once admission
has completed, cancelling that finished request does not cancel the separate run
or undo a saved note; use current operation status and the explicit recovery or
cancellation controls.

The restricted channel accepts at most 256 KiB of serialized engine output per
tool result. A larger result returns `PROCESSING_ENGINE_OUTPUT_LIMIT` without
truncating evidence or terminating the chat. Use the explicit CLI from an
uncaptured context for material that cannot fit this channel.

## Review controls

Invoke the same skill with `review`. Its
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
requires MCP `2025-11-25` string-default support. A host negotiating an older
protocol or lacking form support leaves the proposal pending. An exact review
exceeding the 256 KiB form limit is refused without truncation; use the supported explicit
proposal and save commands from an uncaptured context instead.

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
feedback is necessary. Automatic processing from hook notifications, transparent
exclusion of arbitrary natural-language turns and live desktop integration are
not established by native protocol fixtures.
