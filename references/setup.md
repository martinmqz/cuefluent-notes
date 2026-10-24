# Setup and preferences

Setup is an explicit user operation. Agree on the configured project root, exact
notes destination, tracking and saving modes, and activity logging. Offer logging
on for a new directory destination and show its reserved `logs/` path. Preserve
the user's explicit opt-out and the current setting when editing an existing
configuration.
Do not infer consent from installation, hook trust or an ordinary chat message.

## Find the package and inspect settings

Use the package's `src/cli.mjs` entry. In an installed package, it is two levels
above the skill directory. In the source checkout, `src/` is beside `SKILL.md`.
Do not search client configuration or credential files to find it.

```text
node /absolute/package/src/cli.mjs settings
```

This read creates nothing. It returns the private store location and exact
`settingsHash`; retain that hash for a settings change. A fresh store returns null.
Never refresh the hash merely to bypass a conflict.

## Apply the agreed configuration

Place the requested JSON outside source repositories. Use canonical absolute
paths without symbolic links. The project root must exist; setup may create the
chosen notes directory or an explicit file's parent after checking its ancestors.

```json
{
  "expectedHash": null,
  "project": {
    "id": "example-project",
    "root": "/absolute/project",
    "destination": { "kind": "directory", "path": "/absolute/notes" },
    "tracking": "manual",
    "saving": "review",
    "activityLog": { "enabled": true, "timezone": "America/Los_Angeles" }
  }
}
```

The timezone above is an example. Use the user's chosen IANA timezone or the
system's detected IANA timezone for a new log series, and show it with the setup
choices. An established series retains its recorded timezone. To opt out, use
`"activityLog": { "enabled": false }`. Existing configurations keep their
explicit setting; loading settings never applies creation defaults.

On Windows use JSON-escaped local drive paths, for example `C:\\Work\\Project`.
Apply only after the user has approved the complete choices:

```text
node /absolute/package/src/cli.mjs setup --config /absolute/private/setup.json
```

For an existing store use its inspected settings hash. Changing an existing
project uses the same ID. Complete proposals are validated; unsupported schemas,
stale settings, unsafe destinations and changes that would orphan retained work
are refused. Resolve the reported conflict and inspect current state before
proposing a different change. Do not delete recovery state to force setup.

| Preference | Choices |
| --- | --- |
| Tracking | `manual` (default), `auto` for new chats going forward |
| Saving | `review` (default), `auto` after explicit processing |
| Activity log | On by default for directory destinations, with a recorded IANA timezone; explicit off is supported. Single-file destinations default to off. |

Mode changes do not untrack existing chats or override opt-outs. A pending run
pins its destination, saving preference and logging settings. Settle it before
changing its destination or saving mode; logging changes apply to future runs.
Nearest configured ancestor owns a newly bound chat. Existing ownership does not
move when nested projects are added.

## Activity logging

Logging defaults to on when creating a project with a directory destination.
If omitted during project creation, its timezone defaults to the system's
detected IANA timezone. Use, for example,
`"activityLog": { "enabled": true, "timezone": "America/Los_Angeles" }`.
Setup shows and records the exact `logs/` path, establishes the first valid annual
file under the writer lock, then enables logging. An existing valid series supplies
its authoritative identity and timezone; machine-local preferences do not change it.
A single-file destination defaults to logging off and rejects explicit enablement
without creating siblings. Installation and read-only commands create no log;
the log is established during the approved setup.

Setup reports pre-existing `logs/` content even when logging is off. Those files
remain readable and untouched by ordinary note drafts. Unrecognized or malformed
annual files are preserved and reported; do not silently adopt, rename or delete
them. Interrupted setup retains its exact proposal for recovery.

Logs consume the watched app's document and corpus allowances. Their dates are
save times, coverage includes only opted-in projects, and failures can leave gaps.
Current Cuefluent desktop relative note links are not clickable; the same standard
links remain useful to agents and other Markdown readers.

## Private location

Defaults are `~/Library/Application Support/Cuefluent Notes/v2` on macOS,
`$XDG_STATE_HOME/cuefluent-notes/v2` (or `~/.local/state/cuefluent-notes/v2`) on
Linux, and `%LOCALAPPDATA%/Cuefluent Notes/v2` on Windows. `CUEFLUENT_V2_HOME`
selects an explicit fresh location consistently for the client and its workers.
A setup request may also name `storeRoot`; subsequent client invocations must
select that same location with `CUEFLUENT_V2_HOME` in each native client's launch
environment, so its hooks and MCP worker use the configured store. Never place
it in a repository or notes destination.
Private storage requires a supported local filesystem and verifiable permissions.

Setup changes only Cuefluent Notes project state and the explicitly authorized
notes/log destination. Native plugin registration, hook trust, authentication,
publication and existing capture settings are separate actions.
