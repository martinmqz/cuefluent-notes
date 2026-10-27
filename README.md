# Cuefluent Notes

A Claude Code and Codex plugin that saves Markdown notes your assistant prepares at
your request, with review or automatic saving, and tracks chats for explicit
processing in a separate session.

## Install

Claude Code:

```text
claude plugin marketplace add martinmqz/cuefluent-notes
claude plugin install cuefluent-notes@cuefluent
```

Codex: add this repository as a plugin marketplace (`.agents/plugins/marketplace.json`)
and install `cuefluent-notes` from the `cuefluent` marketplace through the client's
plugin flow.

Installation registers the plugin and asks about hook trust. It configures no
project, starts no tracking and changes no client authentication. Node.js 26.12.1
or a newer Node 26 patch must be the Node the client launches; see
[requirements and limits](references/limits.md).

## Quick start

1. Open a chat in your project and ask: "Set up Cuefluent Notes for this project."
   The assistant proposes the project root, notes destination, tracking, saving
   and activity logging, and calls `cuefluent_setup` once you agree.
2. Ask for a note: "Use Cuefluent to save the meeting details above as a note."
   With review saving the assistant shows the complete draft and asks you to save,
   discard or keep it pending; with automatic saving it links the saved note.
3. To collect a chat: `/cuefluent-notes:cuefluent-notes track` in Claude Code, or
   select `$cuefluent-notes` and type `track` in Codex. Later, `process` drafts
   notes from the queue, and `status` is read-only.

Automatic tracking includes existing and new chats from their next prompt after
it is enabled. Earlier history stays excluded, and explicit untrack opt-outs remain.
Processing is always explicit.

Defaults are manual tracking, review saving and activity logging on for directory
destinations, where `logs/YYYY.md` records successful note changes. Repeat setup to
change a choice; only the choices you name change. If the connector tools are
unavailable, [setup](references/setup.md#fallback-the-cli) has the command-line
fallback.

## Data handling

Queues and draft bytes live in a private store outside repositories and notes;
original transcripts are never deleted, and successful saves consume only the
selected queue records. Existing notes are updated only under the writer's hash
and conflict rules, so manual edits are preserved. See
[setup](references/setup.md#private-location) for the store's location,
[notes](references/notes.md) for the note format and
[commands](references/commands.md) for the tools and commands.

## Source development

```sh
npm ci --ignore-scripts
npm run check:guidance
npm test
```

The runtime is in `src/`, synthetic tests in `test/`, and distribution sources in
`packaging/plugin/`. Maintainer build and release instructions live in
`.agents/publishing.md`. Building a candidate publishes nothing and changes no
immutable release snapshot.
