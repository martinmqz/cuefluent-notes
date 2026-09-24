# Opt-in capture hooks

The Codex and Claude adapters deliver the existing knowledge workflow to the
working agent at `UserPromptSubmit`. After per-client setup and consent, eligible
sessions receive this guidance without invoking the skill for every session.
The adapter supplies policy and native identity; the agent decides whether its
authorized work established useful information and applies ordinary Markdown
updates through the [shared safe writer](refresh.md).

The adapters are read-only. They do not capture at prompt submission, extract
facts from a transcript, generate text, or run another model. An optional
[Stop check](completion.md) reads a private working-agent completion marker and
can request one recovery attempt for a missed decision. It requires separate
opt-in; existing configurations request zero continuations. Capture remains
best-effort: a marker cannot prove semantic consideration or guarantee
exactly-once delivery, coverage of interruptions, or capture on every shutdown.

## Configuration and consent

There are two separate choices: configure the private capture policy, and enable
and trust the adapter in each supported client. Merely using the manual skill
does neither. Installing or trusting live hooks requires the user's explicit
authorization. The current source implementation does not install hooks or edit
host settings. [Standalone plugin packages](distribution.md) offer a manual
variant with no registration and a hook variant registering `SessionStart`
(matched on `startup`), `UserPromptSubmit`, and `Stop`.
Choose one variant per client; installation, trust, and private policy remain
separate from building the package.

For first use, say **“Set up Cuefluent Notes.”** The [Setup flow](setup.md) checks
status and guides the choice of manual use, suggestions, or automatic capture.
With no configuration, a trusted startup hook supplies one `systemMessage` host
notice. It supplies no model context or assistant-answer text. Unconfigured
`UserPromptSubmit`, resumed sessions, and compaction stay quiet; no persisted
reminder receipt is needed. Headless clients may expose the notice as a separate
hook/informational event, not part of the assistant result. Choosing Manual saves
a globally disabled policy and silences all hooks. Changes to packaged handlers
require host review/trust of the updated definition.

The adapter interface is:

```sh
node scripts/hooks.mjs codex --config /absolute/private-config/cuefluent-notes.json
node scripts/hooks.mjs claude --config /absolute/private-config/cuefluent-notes.json
```

The host sends its bounded event JSON on standard input. The hook package resolves
its bundled script through the host's plugin-root variable. When registering a
standalone command, resolve script and configuration paths explicitly; these
examples are interfaces, not installation commands. Configuration is selected in
this order: `--config`, `CUEFLUENT_NOTES_CONFIG`, then
`~/.config/cuefluent-notes/config.json`. Explicit and environment paths must be
absolute. Packaged commands do not include `--config`: they use the environment
inherited from their host, or the default path. Passing `--config` to Setup does
not persist that selection for hooks; Setup reports differing path selections.

The generated handler works on native Windows, macOS, and Linux. It invokes
`node` with fixed bootstrap code and reads `PLUGIN_ROOT` (Codex) or
`CLAUDE_PLUGIN_ROOT` (Claude) inside Node. Spaces, Unicode, and shell characters
in installed paths are never inserted into shell code. Windows checks exercise
`cmd.exe`, Windows PowerShell, PowerShell 7, and Git Bash. Node 22+ must be on the client's
PATH, including when launched from a desktop app. Updating this handler may
require renewed hook review/trust; it does not change capture consent.
For a custom location, supply `CUEFLUENT_NOTES_CONFIG` in the host launch
environment and verify from a fresh task, rather than setting it only for Setup.
No configuration file means a startup host notice only, with no capture
reads or writes authorized by that notice. Setup writes settings only after the user
chooses a mode and supplies the required scope and destination.

The [synthetic example](../examples/hook-config.json) is deliberately disabled,
has automatic updates off, and uses obvious placeholder paths. It omits a
default route so unrelated projects do not acquire a destination. Replace it
only in a user-selected private configuration location; do not put real notes,
project paths, policy, or state into the public skill repository. The adapter
rejects configuration loaded from within the skill package, so do not use this
versioned example directly as the runtime configuration.

| Field | Meaning |
| --- | --- |
| `version` | `1` for legacy explicit-file policies; `2` supports file and folder routes; `3` adds completion-check settings; `4` adds folder organization |
| `minimumPluginVersion` | `"0.5.1"` in version 2; `"0.6.0"` in version 3; `"0.7.0"` in version 4; omitted from version 1 |
| `completionCheck` | Required boolean in versions 3 and 4; `true` explicitly permits private completion markers and one Stop recovery. Absent from older schemas. Applies to every active route and listed client. |
| `enabled` | Explicit global enablement; `false` is quiet |
| `clients` | Enabled adapter names, selected from `codex` and `claude` |
| `automaticUpdates` | Whether configured capture may save; `false` supplies proposal-only guidance |
| `scope` | A nonempty single-line description of eligible information, at most 2,000 characters |
| `defaultRoute` | Optional `{notesDir, stateDir}` or `{destination, stateDir}` for sessions without a matching project route |
| `routes` | Optional project routes with `projectRoot`, `stateDir`, and exactly one of `notesDir` or `destination`; each can override `scope`, `automaticUpdates`, or `enabled` |
| `organization` | Optional `"flat"` or `"by-type"` on folder project/default routes in version 4 only. Omitted in stored policies means flat; new folder setup writes `"by-type"` by default. Forbidden on explicit-file routes. |
| `exclude` | Optional absolute project roots to exclude, including their descendants |

Complete policy writes reject unrecognized fields. Reads check client membership
before interpreting version-specific fields, then validate the common envelope,
all project selectors, and the selected route's storage. Unrelated storage fields
do not prevent a valid selected route from working. Unknown newer schema or
minimum plugin versions yield upgrade guidance for participating clients, and
cannot be overwritten by an older helper. All route paths are absolute. Project
and exclusion roots may be unavailable: missing roots and non-directory roots
cannot match an existing session. Permission failures are ignored only when a
readable ancestor proves the root is outside this session; otherwise capture
is skipped, including when an exclusion or disabled route could apply.
`notesDir` selects an existing notes folder. Flat organization keeps notes directly
in it. By-type uses [note placement](workflow.md#note-placement), preserving explicit
destinations and suitable existing notes before choosing a category for clear new
types; general/unclear material stays at root. No note is chosen or read by the
hook. Never follow linked notes. Use the selected folder as the safe-writer root;
category writes use inspected directory expectations, and Suggestions approval
covers both the note and any folder creation.
`destination` preserves an explicitly selected Markdown file; its parent
must exist, while the note itself may be new. An existing note must be a regular
file with a single hard link, matching the safe writer's replacement requirements.
`stateDir` may be new beneath an existing directory, including an ancestor alias
resolved to its real path.
A symlink selected directly as the state directory is refused. It is the private
state directory for the safe writer and, when opted in, its completion markers.
Hooks inspect this metadata but never create it. Reuse one state directory for all writes to the
same collection, as described in [refresh.md](refresh.md). The state directory
is shared by every route/default targeting that canonical notes folder or an
overlapping ancestor/descendant folder; Setup
updates reject conflicting choices, including disabled routes and path aliases.
Overlapping folder routes must also agree on effective organization, including
default and disabled routes; explicit files do not participate in that comparison.
Separate policy files still need the same collection state chosen explicitly.
Capture requires authored state. Setup, updates, and prompt hooks refuse a
selected state containing a derived manifest or pending derived journal without
reading its sources or outputs. Journal reads are bounded and refuse symlinks;
other pending journals require recovery before capture can proceed. Preserve a
derived collection and choose a separate authored notes collection;
assigning a second state to its existing outputs would defeat coordination.
The state directory must not contain the destination note or be nested under its
pathname. For a folder route, configuration and writer state stay outside the
notes folder, and state must not contain that folder. Existing file routes remain
supported; moving to a folder is an explicit configuration change. Before first
publishing version 2, Setup requires a compatibility assertion after inspecting
**every installed client that reads the policy**, including unlisted clients.
All must support `notesDir` (0.5.1+); older clients cannot gain the early membership
check retroactively. First publication of version 3 requires all installed readers
to support 0.6.0+; version 4 requires 0.7.0+ even when organization is omitted
or completion is off. See [setup](setup.md) for the preflight and version fields.
Keep policy concise: oversized input,
configuration, or emitted context produces bounded no-capture guidance.
Optional completion data that would exceed the context budget is omitted from
both prompt and Stop events while preserving ordinary capture guidance.

## Routing and inactive cases

The adapter compares the canonical session working directory with canonical
configured project roots using directory boundaries. Among matching routes,
the longest ancestor wins. For example, a route for `/work/atlas/client` is more
specific than `/work/atlas`; neither matches `/work/atlas-old`.

- An exclusion always skips capture, including a more specific enabled route.
- The selected route's `enabled: false` skips capture. An enabled nested route
  can supersede a disabled broader route because the most specific route is
  selected first.
- If there is no matching project route, use the explicitly configured default.
  Without one, the session is outside configured capture scope and is quiet.
  An enabled policy with no routes and no default is also quiet.
- Duplicate selected canonical roots are ambiguous. Supply routing-choice
  guidance and save nothing rather than choosing by array order.
- Missing configuration supplies only the startup host notice. A client absent
  from an enabled policy also receives this startup notice, while its prompt
  hook stays quiet. Global disablement silences all hooks. Unsupported events
  or missing native identity are quiet, including when configuration is absent.
- Malformed configuration, including a present JSON `null`, or unresolvable
  selected paths produce a bounded generic warning and no capture, without
  echoing raw configuration values.

The capture adapter accepts `UserPromptSubmit` with a nonempty native `session_id`,
the client's native turn identity, and a valid absolute `cwd`. Startup discovery
requires `SessionStart` with `source: startup`, `session_id`, and an absolute
`cwd`, but no turn identity. It does not
invent an ID, substitute a timestamp, or mine a transcript. Presence of
`agent_id` skips subagent capture. An `agent_type` alone can identify a custom
root agent and does not disable capture. Automatic capture is scoped to eligible
root sessions, not independently duplicated in subagents. Stop requires that same
native identity plus the explicit boolean `stop_hook_active: false`; true or
missing guards are quiet before reading policy or state.
Recovery also requires a known non-plan permission mode and an earlier successful
marker for the same session, selected policy and mode. No prior marker means the
check is unarmed, rather than evidence that a restricted agent should retry.

## Working-agent capture policy

Current user instructions take precedence over configured capture. Respect
read-only requests, “don't record this,” all-logging opt-outs, and narrower scope.
An all-logging opt-out includes completion metadata. The adapters write no such
metadata even when capture is enabled or skipped. A policy can permit capture;
it cannot authorize unrelated reads or override host filesystem permissions.

Before completing eligible work, the working agent should:

1. Evaluate evidence under the
   [selected-source rules](evidence.md#selected-sources-and-capture-scope);
   hooks do not read those sources. Mechanical edits, acknowledgments, and tool
   calls alone are insufficient. Unknown dates remain unknown; occurrence dates
   and verification limits follow the [evidence rules](evidence.md).
2. For a folder route, select an existing note or a descriptive new filename as
   described in [the skill](../SKILL.md). For a file route, keep its destination.
   Read the selected note and relevant current task evidence. Recognize a manual
   save or replayed instruction and avoid duplicating information already
   captured. Use suitable existing sections rather than creating scenario copies.
3. If automatic updates are permitted and a useful change is needed, prepare
   and review the ordinary Markdown change, infer faithful search vocabulary,
   and apply it with the safe writer using the configured `stateDir` and inspected
   hashes. Verify the result before responding, following the
   [Automatic outcome](../SKILL.md#automatic). Preserve manual edits, stop on
   conflicts, and report actual limits.
4. If there is no useful change, leave notes unchanged. For an enabled,
   applicable Suggestions route, read the JSON `skill` path and follow its
   [Suggestions guidance](../SKILL.md#suggestions) for interaction timing,
   unattended runs, declined proposals, and approval scope.
   The working agent chooses an applicable question tool; hook JSON itself does
   not open a prompt or detect interactivity; use the skill's host-context and
   live-conversation criteria. Do not save from hook policy alone. Missing routing
   requires a user choice before any automatic save.
5. Only when routing JSON includes `completion`, follow the
   [completion workflow](completion.md) to acknowledge the actual decision if
   metadata writes are permitted. A sent proposal counts as handled; do not wait
   for approval or repeat an unanswered question to satisfy the check.

The adapter cannot mechanically recognize whether an agent already captured a
fact. The native identity identifies the current operation, while destination
inspection and semantic review provide duplicate avoidance. Optional markers
acknowledge decisions, not note contents or exactly-once delivery. Replayed events can repeat guidance;
they must not become instructions to append duplicate notes.

## Privacy and bounded behavior

The adapter reads the selected configuration and necessary metadata from bounded
stdin JSON. It does not read prompt text to extract facts, open `transcript_path`,
persist raw payloads, inspect unrelated folders, or write notes. Emitted context
contains policy, route, and native identity, not source bodies or transcript
content. It never creates a skipped-event log, receipt, or hook state directory.
An opted-in Stop check also reads bounded completion metadata; only the separate
working-agent helper writes markers under the existing shared writer lock.

The working agent still reads selected evidence and may write a reviewed note
under the authorized policy. The host may retain its conversation and hook
output under its own behavior; this adapter does not change that boundary.
Do not claim that external agent processing or host retention is wholly local
or disabled merely because this helper stores no payloads.

A missing permission, source gap, conflict, or helper error ends that capture
attempt with an honest bounded report. It must not trigger another model call,
an unbounded retry, a new destination, or a completion-blocking loop. Manual
Log, Prepare, Update, Refresh, and Check remain available when hooks are inactive.

## Host contracts and verification limits

The reviewed baselines are Codex `0.146.0` and Claude Code `2.1.278`. They identify
the researched contracts, not a certification of live installation or every
client build. The adapter checks actual incoming identity rather than assuming
that an installed version will always supply it.

| Client | Required native identity | Context output contract |
| --- | --- | --- |
| Codex | `session_id` and `turn_id` | `hookSpecificOutput` with `hookEventName: "UserPromptSubmit"` and `additionalContext` |
| Claude Code | `session_id` and `prompt_id` | The same event-specific `additionalContext` shape |

Both clients' Stop check uses `decision: "block"` and `reason` on exit zero only
for eligible missing decisions in an armed session. Recovery relies on the host's `stop_hook_active`
guard; see [completion](completion.md) for native identity, failure and privacy
limits. Live Stop delivery and agent adherence still need host verification.

Both clients' startup notice uses the common `systemMessage` output and omits
`additionalContext`. See the [Codex startup contract](https://learn.chatgpt.com/docs/hooks#sessionstart)
and [Claude JSON output contract](https://code.claude.com/docs/en/hooks#json-output).

Codex documents the `UserPromptSubmit` turn field and context output; non-managed
hooks require review and trust of the current definition. User-level hooks and
project-level hooks have different discovery and trust scopes. See the
[official Codex hooks reference](https://learn.chatgpt.com/docs/hooks) and the
[Codex 0.146.0 UserPromptSubmit input schema](https://github.com/openai/codex/blob/rust-v0.146.0/codex-rs/hooks/schema/generated/user-prompt-submit.command.input.schema.json).

Claude documents `prompt_id` from version `2.1.196`, user settings across local
projects, and workspace trust requirements for interactive settings-file hooks.
Its `/hooks` menu inspects configured handlers. See the
[official Claude hooks reference](https://code.claude.com/docs/en/hooks).

Enablement in one client does not enable the other. Host registration and trust
must be reviewed separately, with no bypass of host trust. Once authorized,
verify fresh sessions and already-open sessions after the documented reload or
restart path for the exact host version; do not assume a universal hot reload.

Synthetic adapter and safe-writer tests can exercise event identity, routing,
opt-out guidance, malformed inputs, no state writes, conflicts, and no-op updates.
They do not prove that a live host loads a hook, delivers its context across
sessions, or that an agent semantically captures every useful fact. Separately
authorized [live CLI smoke tests](verification.md) exercised temporary plugin
setup and synthetic capture. Already-open session reload and desktop capture
remain unverified; successful examples do not guarantee every capture decision.
See [distribution](distribution.md) for package validation and separate
session-only loading versus persistent setup instructions.
