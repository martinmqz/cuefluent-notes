Capture and organize your knowledge for fast recall—right on cue.

Folder setup now preserves a collection of notes instead of choosing one
catch-all file. Reuse relevant notes or name new files for their content;
Suggestions identifies the proposed filename before asking to save. Explicit
file destinations remain supported and existing settings are not broadened.
Folder policies use schema version 2 and record a minimum plugin version of
0.5.1. Setup requires a compatibility check before first publishing that schema:
upgrade every installed client that reads the policy, including unlisted clients.
Explicit-file policies retain version 1. Newer schemas produce upgrade guidance,
and unlisted clients ignore unfamiliar policy fields.

Overlapping notes folders must share writer state. Capture setup also refuses
state owned by a derived collection and explains how to choose a separate
authored collection without creating competing locks for existing outputs.

This release contains complete Codex and Claude Code plugins, with runtime
dependencies included. Each client has a hook-enabled ZIP and a manual ZIP
without hooks. Requires Node.js 22+; hook commands target macOS and Linux.

After this release is published, the **Publish marketplace** workflow updates
the `marketplace` branch. Wait for that workflow to succeed before using the
[marketplace installation instructions](https://github.com/martinmqz/cuefluent-notes/tree/marketplace).
Capture stays off until you choose a mode during **Set up Cuefluent Notes**.

`SHA256SUMS` covers all four plugin ZIPs and the generated marketplace snapshot.
The snapshot is used by publication automation; users normally install through
their client's marketplace commands. These packages are not a public-directory
approval from OpenAI or Anthropic.
