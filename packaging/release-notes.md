Capture and organize your knowledge for fast recall—right on cue.

New folder setups default to by-type organization. The agent infers each note's
type from content and purpose, placing clear new notes under `meetings/`, `tasks/`,
`knowledge-base/`, or `decisions/`. General or unclear material stays at the notes
root. Explicit destinations and suitable existing notes take precedence; no files
are moved, and no required `type:` field or task lifecycle is introduced.

Suggestions preview the full path, edit and any folder creation before Save /
Skip. Neither notes nor folders are created before approval. The safe writer
checks inspected note hashes and directory identities, preserves conflicts,
and supports guarded recovery. Interrupted writes can leave a reported empty
category folder; it is retained rather than removed automatically.
Existing category spellings such as `Meetings/` can be reused. When a directory
changes during an interrupted write, inspection reports the conflict and a
reviewed abort can archive the journal while preserving every note and stage.

No layout or note-type question is required during onboarding. Existing capture
settings stay unchanged; explicit flat placement remains available. By-type
uses schema 4 and requires all installed readers of the shared policy to support
0.7.0+. Explicit flat folder setup retains schema 2 (0.5.1+), or schema 3 with
completion checks (0.6.0+). Completion checks remain separately opt-in. Older
schemas and explicit files remain supported. All version-2 writes, including root-only manual saves,
require confirmation that every collection reader supports 0.7.0+; otherwise
retain version-1 writes with existing parents.

Synthetic checks cover both adapters and all four detached packages. Native
Save / Skip rendering, model classification and Cuefluent ingestion of nested
files remain unverified. Honor the user's chosen layout without requiring a live
app test; directory support does not promise recursive discovery or search ranking.

This release contains complete Codex and Claude Code plugins, with runtime
dependencies included. Each client has a hook-enabled ZIP and a manual ZIP
without hooks. Requires Node.js 22+ on native Windows, macOS, or Linux.
Windows supports native executables and command shims during source installation,
and packaged hooks run in Command Prompt or PowerShell without WSL.
All three CI platforms build identical release archives. Private Windows
configuration and state depend on the selected directory's ACL; read-only notes
are preserved, and directory-flush power-loss durability is unavailable.

After this release is published, the **Publish marketplace** workflow updates
the `marketplace` branch. Wait for that workflow to succeed before using the
[marketplace installation instructions](https://github.com/martinmqz/cuefluent-notes/tree/marketplace).
Capture stays off until you choose a mode during **Set up Cuefluent Notes**.

`SHA256SUMS` covers all four plugin ZIPs and the generated marketplace snapshot.
The snapshot is used by publication automation; users normally install through
their client's marketplace commands. These packages are not a public-directory
approval from OpenAI or Anthropic.
