# First-use setup

Guide the user through setup in conversation. They should not need to find a
configuration file, write JSON, choose a state directory, or know hook event names.
Use this flow for “Use Cuefluent Notes” with no concrete operation, “get started,”
“set up Cuefluent Notes,” or a capture-status question. A specific manual Log,
Prepare, Update, Refresh, or Check request does not require setup.

## Inspect before asking

Use the current client (`codex` or `claude`) and project directory:

```sh
node scripts/setup.mjs status --client codex --cwd /absolute/current-project
```

Use the helper's absolute path, or run it from its installed skill directory,
always supplying the user's project as `--cwd`. The argument is required; the
helper's installation directory is not the user's project. It selects
`CUEFLUENT_NOTES_CONFIG` when set, otherwise
`~/.config/cuefluent-notes/config.json`; `--config /absolute/private/config.json`
is an override for that invocation only. It does not persist a path for packaged
hooks. Prefer the default or the environment already supplied by the host, and
use the same selection throughout setup. Status does not create files or inspect
note content. Never set a different home directory to test
setup or put policy in this public repository or the installed package.

Explain the observed status in ordinary language:

- `unconfigured`: capture is off; offer the choices below.
- `disabled`: the shared policy is disabled. Manual requests remain available;
  do not infer that a later manual save enables capture.
- `client_not_configured`: this client is absent from the shared policy. Do not
  claim the user chose Manual here. For an explicit setup request, use the
  existing-settings flow below to add the client while preserving other settings.
- `configured`: describe the mode, project being checked, destination, and scope.
  Policy readiness does not prove the host runs the hook.
- `inactive`: settings exist, but no enabled route covers this project. Preserve
  exclusions and other projects; do not offer to reset the file.
- `invalid`: report the problem and stop setup writes. Preserve the existing file
  for a requested repair; never delete it to make initialization succeed.

`hookPackaged` reports whether this package includes both synchronous command-hook
registrations invoking the bundled adapter for the selected client, with
`SessionStart` matched on `startup`, and a valid client manifest. The manifest
check covers the metadata subset emitted by this builder, including plugin
identity, semantic version (with installation suffixes), and client-specific
fields. It is not a validator for arbitrary host plugins.
`hostTrust: not_checked` means this helper cannot establish host enablement or
trust. Accept the user's stated trust action, or use an available host status
surface. Do not claim that trusting a hook by itself enables capture.
If `hookIssue` is present, report the package problem separately from the
configuration status. Repair or reinstall the package before relying on capture.

Init, Update, and Status also return `hookConfigPath` and `hookConfigMatches`,
comparing normalized path selections in the helper's current environment without
reading the other configuration. If `hookConfigIssue` is present, explain that
setup cannot confirm that packaged hooks select this policy. Do not claim
Automatic/Suggestions is ready, or that a Manual choice has stopped the host's
capture or reminders. Use the hook-selected location for normal setup, or arrange
for `CUEFLUENT_NOTES_CONFIG` to be supplied in the host's launch environment, then
verify from a fresh task. Do not silently copy policy or change host settings.
Setting the variable only for a helper command does not configure the host.
Matching paths in this process do not prove the host inherited its environment;
aliases with different normalized spellings also require verification.

## Ask for the missing choices

For an unconfigured installation, begin with a short question such as:

> Cuefluent Notes is ready, and capture is currently off. Would you like to save
> notes only when you ask, get suggested updates, or save useful findings
> automatically for selected projects?

Use a choice tool when available, or ordinary conversation. No default selection
counts as an answer. Reuse choices already supplied by the user; do not ask for
another confirmation of an explicit setup request with complete choices.

| Choice | Behavior |
| --- | --- |
| Manual | Save only when asked; no automatic capture or setup reminders |
| Suggestions | Offer useful changes from eligible work, without saving automatically |
| Automatic | Save useful findings and decisions within the selected scope; no full-session transcripts |

Manual needs no destination or project questionnaire. Once the user chooses it
in this setup flow, save the disabled preference with the helper below. “Not
now,” silence, or a recording opt-out means no configuration write. Do not keep
asking during the same conversation.

For Suggestions or Automatic, ask for the missing project scope and notes
location. Offer the current project as a concrete starting scope. Accept an
existing Markdown file or a notes folder; if given a folder, propose a sensible
project filename. Reuse suitable existing notes instead of inventing a parallel
collection. Create a missing notes folder only when it is the user's selected
location. The helper requires that folder to exist and never creates a note
during setup.

Summarize what will be eligible in plain language, such as “verified findings,
decisions, and meaningful changes from this project.” Honor narrower or different
scope. Do not silently select all projects or enable both clients. Start with the
current client and selected project; a multi-project/client policy is an explicit
configuration change described in [hooks](hooks.md).

## Save and verify the chosen mode

The following are helper interfaces for the agent, not a questionnaire for the
user. Substitute their actual choices; never execute the example paths literally.

```sh
node scripts/setup.mjs init --client codex --mode manual

node scripts/setup.mjs init --client codex --mode automatic \
  --project /absolute/selected-project \
  --destination /absolute/private-notes/project.md \
  --scope "Verified findings, decisions, and meaningful changes from this project."
```

Use `--mode suggest` for suggestions. The helper chooses private writer state
beside the configuration, keyed by the canonical notes folder so notes in that
collection share a lock. Reuse an existing collection's selected state directory
with `--state-dir` when one is already established; do not start a competing lock
directory for the same collection. State is created by the writer when needed.

Initialization creates a complete `0600` configuration without replacing an
existing file or symlink, including a file created by a concurrent setup. It
never writes note content, creates capture receipts, installs plugins, or changes
hook trust. A refusal is a reason to inspect current settings, not to remove them
or invent an alternate config path. Honor host permissions for the selected path.
Atomic first-use publication requires same-directory hard links. If the filesystem
or its permissions do not support them, explain the failure and let the user
choose a supported private location; never fall back to writing a partial policy.

Run Status again against the selected project. Report the chosen mode, where
notes will go when relevant, and any remaining host setup. Keep configuration
filenames, status enums, helper commands, state hashes, and internal memory
details out of the normal completion message unless the user asks or needs them
to resolve a problem. If `hookPackaged` is false, explain that automatic
assistance requires the hook package from
[distribution](distribution.md); manual use remains available. If trust is
unknown, explain that it must be checked separately, without repeatedly asking a
user who already confirmed it. The adapter reads policy at the next eligible
prompt; a fresh task is the supported test boundary for newly installed or updated
packages. Do not claim a live capture succeeded just because the config is valid.

End with one useful next action: a manual-save example for Manual, or a small
in-scope task to try for Suggestions/Automatic. Do not save the setup conversation
as the first note. Keep this first-run state unchanged when the user is testing
onboarding and has not yet selected a mode or destination.

## Existing settings

`init` handles first use only. For a status question, report the existing mode and
stop. An explicit setup request for another project/client, or a mode change,
uses `update`; never rewrite the active configuration with an ordinary file write.

1. Run Status with the selected project and keep its `configHash`. Read that
   exact policy and prepare a complete proposed JSON in a separate private file.
   Preserve unrelated routes, clients, exclusions, and defaults. Add or change
   only what the user requested, following the [policy schema](hooks.md).
2. Review the actual differences. `enabled` is a global switch, and routes and
   modes are shared by all listed clients. A Manual preference does not encode
   separate per-client modes. If a requested change would also enable capture or
   change behavior in another client/project, resolve that scope choice before
   applying it; do not silently broaden consent.
3. Apply the reviewed proposal with the inspected hash:

   ```sh
   node scripts/setup.mjs update --client codex --cwd /absolute/selected-project \
     --proposal /absolute/private-review/proposed-config.json \
     --expected-hash INSPECTED_SHA256
   ```

Use the same `--config` selection as Status when overridden and address any
`hookConfigIssue` before presenting the update as effective for capture. The helper
validates the schema and changed route storage before writing, refuses stale bytes and
linked configuration files, and replaces the policy atomically with private
permissions. It never writes notes. Cooperating updates share a lock; an external
editor can still race the final check and rename. An interrupted lock requires
inspection, not automatic deletion or a blind retry. Unchanged unavailable routes
are preserved when their storage identities can be resolved safely; newly changed
routes must be resolvable on this machine.
Retained routes are matched one-for-one. Adding another copy counts as a new
route and must pass ambiguity checks even when updating from another project.

Before activating a policy or editing its routes/default, the complete proposal
is checked for shared collection state.
Routes and the default route that target the same canonical notes folder must use
the same canonical state directory, including disabled routes. Different state
directories would create separate locks for writes to the same collection. Path
aliases are resolved without creating notes or state. Fix a conflict in the
reviewed proposal; do not invent another state directory to bypass it. This check
covers one policy; separate policies and manual writer plans must also reuse the
collection's chosen state directory.
Turning a policy off while preserving its routes/default remains possible even
if those existing routes conflict; activation requires an explicit repair first.

Run Status again for the selected project. Never present a policy as active until
validated and the remaining host requirements are understood. Repairing malformed
JSON requires an explicit repair request and its inspected file hash, available
through the safe-update helper's `fingerprint` command; do not reset it through init.
