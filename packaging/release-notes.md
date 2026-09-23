Capture and organize your knowledge for fast recall—right on cue.

Optional completion checks catch a missed capture decision in Codex and Claude
Code. With explicit opt-in, a read-only Stop hook can request one recovery
attempt. A Save / Skip proposal counts as handled without waiting for an answer;
it never authorizes a note save. Current instructions and recording opt-outs
still take precedence.

The working agent keeps a minimal private completion marker with hashed identity,
policy and outcome. It contains no note text or dates and is not an activity log.
Busy, corrupt, or unsafe state produces a warning without repeated recovery.
Recovery requires a previous successful marker in the same session and permission
mode; plan, unknown and unverified sessions stay quiet. The helper must already
have ordinary write permission, without escalating or prompting each turn.

Existing capture settings stay unchanged. Ask **“Enable the Cuefluent Notes
completion check”** after updating every installed client that reads the policy
to 0.6.0+. Setup requires the compatibility check before publishing schema 3.
Review and trust the added Stop hook through each client's normal hook settings.
Schema-1/2 policies and both explicit-file and folder routing remain supported.
Synthetic tests cover both adapters and detached packages; live Stop delivery and
model adherence have not yet been verified.

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
