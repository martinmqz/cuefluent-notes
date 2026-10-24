# Cuefluent Notes

Create Markdown notes from content your assistant prepares at your request,
with review or automatic saving. You can also track Claude Code and Codex chats
for later explicit processing in a separate session.

See [compatibility and limitations](references/verification.md) for supported
client formats and platform coverage. The source version in `package.json` and
published release snapshots are maintained separately.

## Workflow

To create a note from conversation details, supplied material, or task results, ask:

> Use Cuefluent to save the meeting details above as a note.

The current assistant drafts the requested information. Cuefluent validates and
saves it, or returns the draft for approval according to your saving setting.
This creates a new note without tracking, reading raw transcripts, or running a
second model. Existing notes are protected from overwrites.

For ongoing conversation collection:

```text
track → work in the chat → process → review → save
```

Use `untrack` to stop new collection while keeping queued input. `process project`
includes all queues owned by the project. `skip` releases inactive pending work
without rolling back saved notes. `status` is read-only.

Defaults are manual tracking, review saving and activity logging on for directory
destinations. Logging can be disabled. Automatic tracking follows new chats only;
processing remains explicit. Annual activity logs record successful note changes
at `logs/YYYY.md` within a directory destination.

## Requirements and setup

Use Node.js 26.12.1 or a newer Node 26 patch and a supported authenticated native
client. Runtime libraries and their licenses are included in each detached client
package; an installed package needs no npm install. The current Codex processing
transport has native macOS coverage; its Windows and Linux acceptance remains
unverified. Earlier Windows checks used the previous transport. Windows packaged
Desktop/TUI command acceptance also remains incomplete; see
[verification](references/verification.md).

Install or register the chosen client package through the client's explicit plugin
flow and trust its hooks only if desired. Plugin installation and hook trust do
not configure a project or start tracking. Never change client authentication to
set up this plugin.

The workflow entry is `SKILL.md` in the source checkout and
`skills/cuefluent-notes/SKILL.md` in a detached package. Its setup reference explains
fresh project settings, exact destinations, logging and private storage.

Claude command example: `/cuefluent-notes:cuefluent-notes track`.
Codex command example: select `$cuefluent-notes` and type `track`.

## Data handling

Queues and draft bytes remain in a private store outside repositories and notes.
Original native transcripts are never deleted. Successful saves consume only the
selected queue records; later arrivals remain. Hash checks preserve manual edits.
Activity-log failures are reported without blocking successful note cleanup.

Starting with 0.16.0, Cuefluent Notes uses fresh settings and storage. It does not
migrate or interpret runtime state from 0.15.1 or earlier. Existing Markdown notes
remain user content and can be updated under the current writer's conflict rules.

## Source development

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
```

The source runtime is in `src/`, synthetic tests in `test/`, and distribution
sources in `packaging/v2/`. Maintainer build and release instructions live in
`.agents/publishing.md` in the source checkout. Building a candidate does not
publish, install, or change immutable release snapshots.
