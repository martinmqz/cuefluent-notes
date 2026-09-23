# Optional completion check

Read this when hook routing JSON contains `completion`, or when the user asks to
enable the Stop check. It catches a missed capture decision; it does not require
a note on every turn or create activity evidence for recaps.

## Handle the decision

Finish the requested work and follow the ordinary capture and
[Suggestions](../SKILL.md#suggestions) rules. Current instructions take precedence:
an all-logging opt-out or read-only request forbids even completion-marker writes.
In that case, do no capture work and finish without a marker. Never change policy
or create alternate storage just to satisfy a check.

Use the helper only when the current host already permits both its command and
the selected state writes without a new permission request. Do not escalate,
change host permissions, or ask on every turn just for bookkeeping. If access is
uncertain or denied, omit markers for the rest of the session and report the
limitation once. Hook-process filesystem access is not evidence of working-agent
access; a successful escalated command is not evidence of ordinary access either.

When checks are explicitly enabled and marker writes are permitted, record one
of these outcomes after handling the decision:

| Outcome | When to use it |
| --- | --- |
| `saved` | The authorized note change succeeded through the safe writer |
| `proposed` | A useful preview and Save / Skip question was sent, or is ready to accompany the final result |
| `no-change` | No useful new information or correction needs saving, including an already recorded manual save |
| `skipped` | A proposal was declined, or no proposal is appropriate (for example an unattended run), and metadata writes are permitted |
| `failed` | An attempted capture could not finish; report the actual failure without claiming a save |

A proposal counts as handled **without waiting for approval**. Silence is never
permission to save. Preserve an unanswered or skipped proposal in conversation
context; the marker is not a durable suppression list. A subsequent explicit
save still requires the preview, target, and inspected note to match.

Run the `completion.helper` path with Node, passing a JSON object on standard
input using a tool's structured stdin or safely quoted input. Copy these exact
fields from the hook's routing data; do not send the entire routing object:

```json
{
  "client": "codex",
  "session_id": "native-session-from-hook",
  "turn_id": "native-turn-from-hook",
  "cwd": "/project-from-completion",
  "configPath": "/private-config-from-completion",
  "permissionMode": "default",
  "policyHash": "64-character-policy-hash-from-completion",
  "outcome": "proposed"
}
```

Use `prompt_id` instead of `turn_id` for Claude. The first three fields come
from the top-level routing object; `cwd`, `configPath`, and `policyHash` come
from `completion`, along with `permissionMode`. Use a fixed outcome from the table,
with no summary or extra fields. Never invent native identity or refresh the
policy hash to make a refused operation pass. Helper errors end the attempt;
preserve state and finish without
retrying. The helper checks policy and filesystem state, not whether the agent
actually considered capture or obtained note approval.

## Stop recovery

The read-only Stop adapter checks the current native identity against the latest
marker for this client/session. Recovery is armed only after the working-agent
helper has successfully written a marker for this session, selected policy, and
host permission mode. A missing marker or changed policy/mode leaves recovery
unarmed, preventing a fresh restricted session from entering a futile retry.
The first decision before any successful marker is therefore not checked.

Once armed, a different turn identity requests one recovery continuation only
when the host supplies `stop_hook_active: false`. True, missing, or malformed
guards are quiet. Plan, unknown, and absent permission modes, missing identity,
subagents, excluded routes and disabled checks are also quiet. Busy, corrupt,
pending, or unsafe state produces a bounded warning identifying the affected state
without a continuation. Neither hooks nor the helper read transcripts or the
last assistant response.

During recovery, handle only the original capture decision. Keep the original
identity in the recovery JSON even if Codex assigns a new continuation turn ID;
the recovery itself is not new work to capture. If the decision was already
handled, mark its actual outcome when permitted, without repeating a question or
save. If user instructions prohibit capture or markers, finish without writes.
The next Stop with `stop_hook_active: true` cannot request another attempt.

The bound relies on the host's guard: replaying an identical first-Stop payload
can repeat the same response. Hooks keep no retry ledger. A deterministic hook
cannot see a conversational opt-out without reading the conversation, so an
opt-out in an armed session may cause one no-write continuation. The hook cannot
detect filesystem access being revoked while the host mode remains unchanged;
previous success is evidence, not a guarantee of future access. Never retry a
known denial in recovery. Disable completion checks if that extra continuation
is unwanted. Interruptions, crashes, missing host fields, and
model adherence remain outside the guarantee; this is not exactly-once capture.

## Private state and consent

Enabling the check explicitly permits a minimal marker, separately from note
approval. The working-agent helper creates `stateDir/capture-completion/`, using
the collection's existing writer lock. It stores one `0600` JSON file per client
and session, replacing that session's last decision as turns advance. Each marker
contains only its format version, hashed turn identity, hashed selected policy,
and outcome. It stores no note text, raw IDs, project paths, or occurrence dates.
It cannot answer “what happened yesterday?” and is not an activity log.

Markers persist until removed by the user; there is no automatic retention purge.
Overlapping work in one session can replace its last marker and cause a redundant
check, but cannot acknowledge a different turn. A marker for an earlier turn
can trigger recovery; an absent session marker leaves it unarmed. Neither grants
permission to duplicate a note. Configured writer state remains private
and outside the notes collection and replaceable package.

Use [Setup](setup.md#optional-completion-check) to enable or disable this feature.
Existing schema-1/2 policies never opt in automatically.

If completion context would exceed the bounded event budget, ordinary capture
guidance remains active and the optional completion check is omitted on both
events. No scope or routing data is truncated. Stop does not warn when private
configuration cannot be read well enough to establish opt-in; the prompt hook
and Setup still report configuration problems. Hook packages still launch the
registered Stop command on each response to read that private setting, but load
the completion module only for eligible opted-in events.

The continuation contracts are documented in
[Codex Stop](https://learn.chatgpt.com/docs/hooks#stop) and
[Claude Stop](https://code.claude.com/docs/en/hooks#stop). Both use exit-zero JSON
`decision: "block"` with a `reason`. The adapter never emits `continue: false`
or uses a failing exit code to block a prompt.
