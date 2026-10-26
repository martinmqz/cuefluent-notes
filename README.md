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
includes all queues owned by the project. `skip` releases inactive failed or
conflicted work without rolling back saved notes; a pending review set is shown
first and decided in chat. `status` is read-only.

Defaults are manual tracking, review saving and activity logging on for directory
destinations. Logging can be disabled. Automatic tracking follows new chats only;
processing remains explicit. Annual activity logs record successful note changes
at `logs/YYYY.md` within a directory destination.

### Quick start

1. Install the client package through the client's plugin flow: the Claude Code
   plugin marketplace, or the Codex plugin flow. Trust its hooks only if desired.
2. Open a chat in the project and ask the assistant to set up Cuefluent Notes for
   it. It proposes the project root, notes destination, tracking, saving and
   activity logging, and calls `cuefluent_setup` once you agree.
3. Ask for a note, for example the request in the workflow above.

Setup can be repeated to change a choice; only the choices you name change. If the
connector tools are unavailable, [setup](references/setup.md#fallback-the-cli)
describes the command-line fallback.

## Requirements and setup

Use Node.js 26.12.1 or a newer Node 26 patch and a supported authenticated native
client. Runtime libraries and their licenses are included in each detached client
package; an installed package needs no npm install. The current Codex processing
transport has native macOS coverage; its Windows and Linux acceptance remains
unverified. Windows packaged Desktop/TUI command acceptance also remains
incomplete; see [verification](references/verification.md).

Review decisions are asked in chat: the assistant shows the draft and relays your
answer together with the reviewed revision. Live acceptance of this flow on Claude
Code (terminal), the Claude Desktop Code tab and Codex Desktop is still pending.
See the [observed client limits](references/verification.md#native-clients).

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
Markdown notes remain user content and are updated only under the writer's
conflict rules; see [setup](references/setup.md#private-location) for where the
private store lives.

## Source development

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
```

The source runtime is in `src/`, synthetic tests in `test/`, and distribution
sources in `packaging/plugin/`. Maintainer build and release instructions live in
`.agents/publishing.md` in the source checkout. Building a candidate does not
publish, install, or change immutable release snapshots.
