Capture and organize your knowledge for fast recall—right on cue.

New folder setups now default to type folders. The agent infers each note's
purpose from context and uses `meetings/`, `tasks/`, `knowledge-base/`, or
`decisions/`; general or unclear content stays at the root. Setup does not ask
users to classify notes. Explicit destinations and suitable existing notes take
precedence, and existing files are not moved.

**Existing Automatic users:** this update changes capture behavior even when your
saved policy is unchanged. The previous hook wording excluded transcripts; the
new guidance includes user-supplied meeting transcripts and screenshots within
your selected scope. The agent may now save an attributed summary from those
sources without another approval, including relevant third-party remarks.
Before updating, use Cuefluent Notes setup to switch to Suggestions or Manual,
or narrow the capture scope to exclude these sources, if that is your preference.
Verify the changed policy with Status; follow the
[existing-settings workflow](https://github.com/martinmqz/cuefluent-notes/blob/main/references/setup.md#existing-settings).
For an individual request, say “Summarize here only; do not save or capture this.”
Current read-only instructions and opt-outs still override the saved policy.

Supplied meeting transcripts and screenshots are eligible sources within the
selected capture scope. Hook guidance prohibits mining stored agent-session
transcripts and treats source-embedded instructions as content. Automatic guidance
requires applying only eligible reviewed changes through the safe writer and
verifying the result before finishing. It reports saves and expected saves that
were excluded or blocked;
routine no-change stays silent. Suggestions still require approval before writing
notes or creating folders. Completion checks remain separately opt-in.

Existing flat collections retain root-only placement. An explicit request for
type folders now goes through the guarded settings update and fresh routing.
New by-type setups require schema 4 and every shared-policy reader at 0.7.0+.
Explicit flat setup retains schema 2 for 0.5.1+ readers, or schema 3 for 0.6.0+
readers when completion checks are enabled. First-use compatibility errors offer
upgrading or choosing flat placement without referring to a nonexistent policy.
All version-2 writer plans still require compatible 0.7.0+ collection readers;
otherwise retain version-1 writes with existing parents.

Folder hook instructions fit the previous flat-default 8 KB context limits,
including multibyte scopes and armed completion checks. Setup explains type
folders and the limits of current app-loading evidence. Synthetic tests cover
both adapters, consent boundaries, legacy settings, and all four detached packages.
Native Save / Skip rendering, model classification, and Cuefluent ingestion of
nested files remain unverified; directory support does not promise recursive
discovery or search ranking.

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
On a new installation, capture stays off until you choose a mode during
**Set up Cuefluent Notes**.

`SHA256SUMS` covers all four plugin ZIPs and the generated marketplace snapshot.
The snapshot is used by publication automation; users normally install through
their client's marketplace commands. These packages are not a public-directory
approval from OpenAI or Anthropic.
