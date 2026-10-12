# Session collection hooks

Hooks connect client lifecycle metadata to a short-lived deterministic worker.
Collection and agent processing have independent consent; installation and hook
trust activate neither. See [setup](setup.md), [explicit controls](workflow-cli.md)
and the [client contracts and transport limits](session-workflow.md#client-contracts-and-transport-limits).

## Events and boundaries

Both packages register SessionStart, UserPromptSubmit, Stop and SessionEnd.
Codex also registers Interrupt; Claude registers StopFailure. There is no
SubagentStop, startup-only matcher, Stop completion marker or recovery continuation.
The synchronous handler never scans transcripts, calls models, writes Markdown,
or blocks a prompt. Unconfigured and entirely disabled projects cause zero
filesystem writes. Processing-only routes may register bounded metadata but
never launch collection.

After fresh collection permission, ingress freezes the native source's identity
and current EOF, records bounded metadata and queues a worker. The first verified
unit establishing that boundary is excluded; collection begins with later full
units. Existing history requires explicit selection of named native units and a
fixed byte window. Pause, exclusions, source replacement, compaction/resume and
configuration changes must not silently widen that boundary.

The worker reads only authorized ranges with a shared ten-second/64 MiB budget.
Codex completed, interrupted and failed turns retain their explicit coverage flag.
Claude currently retains proven human input only, marked unconfirmed; assistant
parentage or a later prompt is not proof of ownership or completion. The
[reader contracts](session-workflow.md) describe supported record shapes and omissions.

## Failure and transport limits

The Node bootstrap has a 2.5-second watchdog within the three-second host timeout.
Plugin-controlled malformed input, import/runtime failures and rejected operations
exit zero with a bounded diagnostic. An unavailable Node executable or OS/host
termination is outside that guarantee. Node 22+ must be on the client's launch
PATH, including desktop launches. Codex executes fixed shell source reading the
plugin root as environment data; Claude uses `node` with a direct argument array.
No PowerShell execution-policy change is required by the bootstrap.

A busy or abandoned intake lock appears in later applicable notices. Recovery
requires explicit offline inspection and proven-dead ownership; locks are not
silently stolen. A failed spawn retains queued metadata. See
[recovery](session-workflow.md#blocked-intake-and-explicit-recovery).

Hook output contains bounded status and native identity metadata, not raw evidence.
**Live hook-to-agent current-turn context delivery is unverified.** Hooks emit no
usable `contextRef` and do not start automatic Markdown processing. The separate
[processing-chat controller](processing-chat.md) handles explicit skill requests
through a verified native MCP call, using the existing client and engine. It does
not derive identity or consent from a hook notice. Explicit CLI processing with
selected sessions/units also remains available.

Controlled processing launches disable inherited hooks. Readers can also verify
exact controller-run receipts and formal source-chat controls; they never exclude
an entire session just because it is labeled for processing. Real work and
corrections in that session keep their normal collection boundaries. A successful
protocol exchange does not establish that the host rendered a usable review form
or that the agent followed the authoring rules.

`workflow.mjs status` distinguishes packaged registration from unknown client
trust, restrictions/feature flags and Node launch PATH. Check the client's own
hook controls. Do not infer trust from installation or infer native identity from
cwd, timestamps, UUID sorting or a hook notice.

Current read-only requests, opt-outs and narrower scopes override saved policy.
Raw capture can contain private or third-party information and is not automatically
redacted. Agent processing treats all source text as untrusted evidence. Private
storage protects local files; it does not change client/service retention or make
model processing local. See [verification](verification.md) for product capabilities
and remaining limits.
