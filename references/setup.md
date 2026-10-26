# Setup and preferences

## Agree the choices

Setup is an explicit user operation. Before configuring anything, agree with the
user on the project root, the exact notes destination (a directory, or one Markdown
file), tracking and saving modes, and activity logging. Offer logging on for a new
directory destination and show its reserved `logs/` path and timezone. Preserve the
user's explicit opt-out and the current setting when editing an existing
configuration. Do not infer consent from installation, hook trust or an ordinary
chat message.

## Set up with `cuefluent_setup`

Call `cuefluent_projects` to see what is configured, then call `cuefluent_setup`
once with the agreed choices. It takes `id`, `root`, `destination`
(`{ "kind": "directory" | "file", "path": ... }`), `tracking` (`manual` or `auto`),
`saving` (`review` or `auto`) and `activityLog` (`{ "enabled": ..., "timezone": ... }`).
Every field is optional, and paths are absolute, normalized and free of symbolic
links. The tool accepts no settings hash and no logs path: it reads the current
settings itself and applies the change only if they are unchanged, and the logs
path is always `logs/` inside a directory destination.

A new project needs `root` and `destination`. The project root must exist; setup
may create the notes directory, or an explicit file's parent, after checking its
ancestors. Without `id`, the project takes one derived from the root folder name:
lowercase, each run of other characters replaced by `-`, starting with a letter or
digit, at most 128 characters, with `-2`, `-3`, and so on appended when another
project already has that id. Omitted preferences take the creation defaults below.
An existing project is selected by `id`, or by its exact `root` when no `id` is
given. Only the supplied fields change; omitted fields keep their current values,
including an explicit logging opt-out and an established timezone. The root of an
existing project does not change, and an `id` and `root` that belong to different
projects are refused (`SETUP_PROJECT_MISMATCH`), so a name collision never touches
another project. `activityLog: { "enabled": true }` without a timezone keeps the
timezone of a project whose logging is already on and otherwise uses the system's
IANA timezone; an established log series always keeps its recorded timezone. A
timezone is valid only with `"enabled": true`. A file destination cannot log, so
switching a project that logs to a file destination also needs
`activityLog: { "enabled": false }`.

| Preference | Choices |
| --- | --- |
| Tracking | `manual` (default), `auto` for new chats going forward |
| Saving | `review` (default), `auto` after explicit processing |
| Activity log | On by default for directory destinations, with a recorded IANA timezone; explicit off is supported. Single-file destinations default to off. |

The result is `state: "configured"`, `created`, the saved `project` and the `logs`
report (`valid`, `absent`, `empty`, `problem` or `not-applicable`; a valid report
includes the series id, timezone and years). Tell the user the saved destination,
preferences and logs path. The tool creates the private store on first use at the
location selected for the connector (see Private location), and a connector that
started before setup serves the new configuration on its next call without a
restart.

Mode changes do not untrack existing chats or override opt-outs. A pending run pins
its destination, saving preference and logging settings; logging changes apply to
future runs. The nearest configured ancestor owns a newly bound chat, and existing
ownership does not move when nested projects are added.

## Refusals

A refused setup changes nothing and returns a stable code with recovery guidance.
Resolve the reported cause and inspect the current state before proposing a
different change; never delete recovery state to force setup.

- `SETTINGS_PENDING_RUN`: a pending run pins its destination and saving mode.
  Settle it first: decide its review draft set with `cuefluent_save_note` or
  `cuefluent_skip_note`, or read `cuefluent_status` for a run that is still working.
  Tracking and logging remain editable.
- `SETTINGS_RETAINED_PROJECT`: a project with retained chats or work cannot be
  removed or moved to another root.
- `SETTINGS_CONFLICT`: the settings changed concurrently. Call `cuefluent_projects`
  and repeat with the intended choices.
- `SETTINGS_INVALID`, `PATH_*`, `PROJECT_ROOT_NONCANONICAL`: a path or preference is
  not valid, for example a non-canonical or missing path, a file destination that
  is not a `.md` file, or logging on a file destination.
- `PRIVATE_LOCATION_OVERLAP`, `PRIVATE_LOCATION_REPOSITORY`: the private store
  would overlap a project root or notes destination, or sit inside a repository.
- `LOG_*`: existing `logs/` content that is not a valid series is preserved and
  reported, and blocks enabling logging until it is repaired (see Activity logging).
- `SETUP_TOOL_ARGUMENT`: the arguments are missing or invalid; nothing is written.
- `SETUP_PENDING`: an interrupted setup retains its exact proposal. Repeat it with
  the same choices to complete it.

## Fallback: the CLI

When the connector tools are unavailable, the same setup runs from the package CLI.
Use the package's `src/cli.mjs`. In an installed package it is two levels above
the skill directory; in the source checkout, `src/` is beside `SKILL.md`. Do not
search client configuration or credential files to find it.

```text
node /absolute/package/src/cli.mjs settings
```

This read creates nothing. It returns the private store location and the exact
`settingsHash`; a fresh store returns null. Never refresh the hash merely to bypass
a conflict. Place the agreed JSON outside source repositories, using canonical
absolute paths without symbolic links. The CLI applies the complete project it is
given: preferences left out take the creation defaults, so repeat every preference
to keep. An existing project keeps its `id`.

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

The timezone above is an example; use the user's chosen IANA timezone or the
system's detected one, and show it with the setup choices. To opt out, use
`"activityLog": { "enabled": false }`. On Windows use JSON-escaped local drive
paths, for example `C:\\Work\\Project`. For an existing store, `expectedHash` is its
inspected `settingsHash`. Apply only after the user has approved the complete
choices:

```text
node /absolute/package/src/cli.mjs setup --config /absolute/private/setup.json
```

The same refusals apply.

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

Defaults are `~/Library/Application Support/Cuefluent Notes/runtime` on macOS,
`$XDG_STATE_HOME/cuefluent-notes/runtime` (or `~/.local/state/cuefluent-notes/runtime`)
on Linux, and `%LOCALAPPDATA%/Cuefluent Notes/runtime` on Windows. `CUEFLUENT_HOME`
selects an explicit location consistently for the client and its workers.
`cuefluent_setup` always uses the location selected for its connector. A CLI setup
file may name `storeRoot`; subsequent client invocations must select that same
location with `CUEFLUENT_HOME` in each native client's launch environment, so its
hooks and MCP worker use the configured store. Never place it in a repository or
notes destination.
Private storage requires a supported local filesystem and verifiable permissions.

Do not copy or move store files: stored gate identities bind exact paths. Do not
run separate stores against the same notes concurrently; their writer gates cannot
coordinate with each other.

Location selection reads or creates no files and does not search other locations.
`CUEFLUENT_HOME` is the only environment override; without an explicit location,
the default is used. Changing the location does not move settings, queued input
or pending runs. The default's
`runtime` directory keeps setup separate from an existing application-data parent.
Fresh setup refuses a directory with foreign entries. Setup may resume
only an empty interrupted first initialization, including its verified temporary
metadata; it never adopts retained work as fresh settings. Unsupported private-state
schemas are refused before store use.
Preserve the selected directory when a privacy, layout or schema conflict is
reported. Read-only commands never initialize or repair it.

Setup changes only Cuefluent Notes project state and the explicitly authorized
notes/log destination. Native plugin registration, hook trust, authentication,
publication and existing capture settings are separate actions.
