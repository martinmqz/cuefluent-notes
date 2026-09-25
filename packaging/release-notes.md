Capture and organize your knowledge for fast recall—right on cue.

This replacement separates two processes: a bounded local worker collects
explicitly selected Codex/Claude session evidence as immutable JSON; an agent
processes selected evidence into searchable Markdown. Collection starts off and
processing starts Manual. Prompted processing requires approval; direct saves of
user-selected material remain available without session collection.

**Breaking change: fresh setup is required.** The old capture policy, reminder
hooks and optional Stop completion check have been removed. Old private files are
preserved but not imported or activated. Keep unfinished old journals with the
v0.7.1 reference helper. Installation and hook trust do not grant collection or
processing consent.

Automatic collection is bounded by registered source offsets and native units;
it does not read earlier history by default. Explicit historical capture selects
a fixed range and named units. Codex supports completed, interrupted and failed
turns. Claude currently captures proven human input only, with unconfirmed coverage;
assistant ownership/finality remains unsupported.

Live current-turn transport is unverified, so automatic Markdown processing and
conversational current-turn controls are unavailable. Use an explicit processing
request with selected session/unit identities. Native Save / Skip rendering,
Cuefluent recursive note loading and search ranking remain unverified.

Reviewed writes preserve inspected content and directory hashes, one shared writer
state and recoverable receipts. The agent infers type folders from content,
preserving explicit destinations and existing notes. Private raw/state storage is
machine-local; pruning and abandoned-lock recovery require explicit commands.
Reader rebuild, automatic lock reclamation and a desktop Node override are deferred.

Complete Codex and Claude packages include runtime dependencies and require
Node.js 22+. Windows, macOS and Linux have native CI gates; consult the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/main/references/verification.md)
for automated coverage and live-client limitations.

After publication, wait for **Publish marketplace** to finish before updating
through the marketplace. Review changed hooks and run **Set up Cuefluent Notes**.
`SHA256SUMS` covers all four plugin ZIPs and the marketplace snapshot. Publishing
does not update an installed plugin; update it through your client after the
marketplace is ready.
