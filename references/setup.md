# Setup and private storage

## Agree the choices

Setup is an explicit user operation. Agree the project root, the exact notes
destination (a directory, or one Markdown file), tracking and saving modes, and
activity logging before configuring anything. Offer logging on for a new directory
destination and show its reserved `logs/` path and timezone. Keep the user's
explicit opt-outs and current settings when editing a configuration. Installation,
hook trust or an ordinary chat message is not consent.

| Preference | Choices |
| --- | --- |
| Tracking | `manual` (default), `auto` for new chats going forward |
| Saving | `review` (default), `auto` after explicit processing |
| Activity log | On by default for directory destinations, with a recorded IANA timezone; explicit off is kept. Single-file destinations are off and cannot log. |

Mode changes do not untrack existing chats or override opt-outs. A pending run pins
its destination, saving preference and logging settings; logging changes apply to
later runs. The nearest configured ancestor owns a newly bound chat, and ownership
does not move when nested projects are added.

## `cuefluent_setup`

Call `cuefluent_projects` to see what is configured, then `cuefluent_setup` once
with the agreed choices: `id`, `root`, `destination`
(`{ "kind": "directory" | "file", "path": ... }`), `tracking`, `saving` and
`activityLog` (`{ "enabled": ..., "timezone": ... }`). Every field is optional;
paths are absolute, normalized and free of symbolic links. The tool takes no
settings hash and no logs path: it reads the current settings itself and applies
the change only if they are unchanged, and logs always live at `logs/` inside a
directory destination.

A new project needs `root` and `destination`. The root must exist; setup may create
the notes directory, or a file destination's parent, after checking its ancestors.
Without `id`, the project takes one derived from the root folder name: lowercase,
each run of other characters replaced by `-`, starting with a letter or digit, at
most 128 characters, with `-2`, `-3`, … appended when another project has that id.
Omitted preferences take the defaults above.

An existing project is selected by `id`, or by its exact `root` when no `id` is
given. Only the supplied fields change; omitted fields keep their values, including
an explicit logging opt-out and an established timezone. A root never changes, and
an `id` and `root` that belong to different projects are refused
(`SETUP_PROJECT_MISMATCH`). `activityLog: { "enabled": true }` without a timezone
keeps the timezone of a project that already logs and otherwise uses the system's
IANA timezone; an established log series always keeps its recorded timezone. A
timezone is valid only with `"enabled": true`, and moving a logging project to a
file destination also needs `activityLog: { "enabled": false }`.

The result is `state: "configured"`, `created`, the saved `project` and the `logs`
report (`valid`, `absent`, `empty`, `problem` or `not-applicable`; a valid report
includes the series id, timezone and years). Tell the user the saved destination,
preferences and logs path. The tool creates the private store on first use at the
connector's location, and a connector started before setup serves the new
configuration on its next call.

## Refusals

A refused setup changes nothing and returns a stable code with recovery guidance.
Resolve the cause and inspect the current state before proposing a different
change; never delete private state to force setup.

- `SETTINGS_PENDING_RUN`: a pending run pins its destination and saving mode.
  Settle it first (decide its review set, or read `cuefluent_status` while it
  works); tracking and logging remain editable.
- `SETTINGS_RETAINED_PROJECT`: a project with retained chats or work keeps its
  root and cannot be removed; change only its destination or preferences.
- `SETTINGS_CONFLICT`: the settings changed concurrently. Call `cuefluent_projects`
  and repeat with the intended choices.
- `SETTINGS_INVALID`, `PATH_*`, `PROJECT_ROOT_NONCANONICAL`: a path or preference
  is not valid, such as a non-canonical or missing path, a file destination that is
  not a `.md` file, or logging on a file destination.
- `PRIVATE_LOCATION_OVERLAP`, `PRIVATE_LOCATION_REPOSITORY`: the private store
  would overlap a project root or notes destination, or sit inside a repository.
- `LOG_*`: existing `logs/` content that is not a valid series is preserved and
  reported, and blocks enabling logging until it is repaired.
- `SETUP_TOOL_ARGUMENT`: the arguments are missing or invalid; nothing is written.
- `SETUP_PENDING`: an interrupted setup retains its exact proposal. Repeat it with
  the same choices to complete it.

## Activity logging

Setup records the exact `logs/` path, establishes the first valid annual file under
the writer lock, then enables logging. An existing valid series supplies its
identity and timezone; machine-local preferences do not change them. Setup reports
pre-existing `logs/` content even when logging is off; those files stay readable
and untouched by ordinary drafts, and unrecognized or malformed annual files are
preserved and reported, never adopted, renamed or deleted. Read-only commands and
installation create no log.

Logs count toward the Cuefluent app's document and corpus allowances, their dates
are save times, coverage includes only opted-in projects, and failures can leave
gaps. The current desktop app does not open relative note links; the same standard
links remain useful to agents and other Markdown readers.

## Fallback: the CLI

When the connector tools are unavailable, the same setup runs from the package CLI
at `src/cli.mjs`: two levels above the skill directory in an installed package, and
beside `SKILL.md` in the source checkout. Do not search client configuration or
credential files to find it.

```text
node /absolute/package/src/cli.mjs settings
```

This read creates nothing and returns the private store location and the exact
`settingsHash` (null for a fresh store). Write the agreed JSON outside source
repositories with canonical absolute paths; on Windows use JSON-escaped drive paths
such as `C:\\Work\\Project`. The CLI applies the complete project it is given, so
repeat every preference to keep, and an existing project keeps its `id`.

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

Use the user's chosen IANA timezone or the system's, and `"activityLog":
{ "enabled": false }` to opt out. Apply only after the user approved the complete
choices, with the inspected `settingsHash` as `expectedHash` for an existing store:

```text
node /absolute/package/src/cli.mjs setup --config /absolute/private/setup.json
```

The same refusals apply. Never refresh the hash merely to bypass a conflict.

## Private location

Project settings, chat metadata, queues, complete draft bytes and current-run
recovery records live in a private store outside repositories and note
destinations: `~/Library/Application Support/Cuefluent Notes/runtime` on macOS,
`$XDG_STATE_HOME/cuefluent-notes/runtime` (or `~/.local/state/cuefluent-notes/runtime`)
on Linux, and `%LOCALAPPDATA%/Cuefluent Notes/runtime` on Windows. `CUEFLUENT_HOME`
is the only override; set it identically in each native client's launch
environment so the connector, hooks and workers use one store. `cuefluent_setup`
uses its connector's location; a CLI setup file may name `storeRoot`.

The store needs a supported local filesystem with verifiable ownership and
permissions; symbolic links, hard links, replaced parents and unsupported storage
are refused. Location selection reads or creates no files and searches no other
location; changing it does not move settings, queued input or pending runs. Fresh
setup refuses a directory with foreign entries and resumes only an empty
interrupted first initialization with its verified temporary metadata. Do not copy
or move store files (gate identities bind exact paths), and do not run separate
stores against the same notes. Preserve the directory when a privacy, layout or
schema conflict is reported; read-only commands never initialize or repair it.

Setup changes only Cuefluent Notes project state and the authorized notes and log
destination. Plugin registration, hook trust, authentication and client capture
settings are separate actions.
