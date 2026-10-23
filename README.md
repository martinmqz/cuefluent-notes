# Cuefluent Notes v2

Turn selected Claude Code and Codex working chats into durable Markdown notes.
Tracking runs locally without a model. Processing starts only when requested and
uses a separate session to prepare notes for review or automatic saving.

See [compatibility and limitations](references/verification.md) for supported
client formats and platform coverage. The source version in `package.json` and
published release snapshots are maintained separately.

## Workflow

```text
track → work in the chat → process → review → save
```

Use `untrack` to stop new collection while keeping queued input. `process project`
includes all queues owned by the project. `skip` releases inactive pending work
without rolling back saved notes. `status` is read-only.

Defaults are manual tracking, review saving and logging off. Automatic tracking
follows new chats only; processing remains explicit. Optional annual activity logs
record successful note changes at `logs/YYYY.md` within a directory destination.

## Requirements and setup

Use Node.js 26.12.1 or a newer Node 26 patch and a supported authenticated native
client. Runtime libraries and their licenses are included in each detached client
package; an installed package needs no npm install. Processing isolation is verified on macOS and native Windows, including the
Windows Codex MXC sandbox. Windows packaged Desktop/TUI command acceptance and
Linux native acceptance remain incomplete; see [verification](references/verification.md).

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

V2 uses fresh settings and storage. It does not migrate or interpret earlier
runtime state. Existing Markdown notes remain user content and can be updated
under the current writer's conflict rules.

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
