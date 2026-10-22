Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes 0.16.0 adds readable proposal copies with typed review decisions,
per-chat capture controls, and more reliable native-session handling. It also
removes legacy-state compatibility. Processing still starts only when requested;
installation and hook trust enable neither capture nor processing.

## Compatibility boundary

Only current storage formats are supported. There is no legacy migration or
mixed-version support, and an in-place upgrade from an older release is not
promised to preserve usable processing state. Unsupported settings, captures,
receipts or native-session records are refused rather than silently converted.
Existing Markdown notes remain ordinary files.

Before replacing an older installation, stop its workers and processing sessions
and preserve its settings, captures, pending drafts and writer state. Do not run
old and new helpers against the same private state, delete a conflict, or reset
state to force an upgrade. Keep the previous package available for unresolved
work. New setup requires explicit destinations and independent consent; it does
not import or activate old capture settings. See
[installation](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/distribution.md)
and [setup](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/setup.md).

## Review drafts as Markdown

`review` writes the exact proposed notes to a private review folder and returns
links, note paths and a draft code. Open `proposed.md` to read it; updates also
include `current.md`. These are read-only review copies: editing them does not
revise the pending proposal, change what `save` writes, or trigger a refusal.
A separate summary contains source and inspection details.
Claude uses these files and typed decisions instead of an unreadable native form.
Codex also offers its native review form.

After a typed review, `save <code>` saves that exact proposal, `skip <code>`
handles its captures without saving, and `review cancel <code>` releases its
unapplied operation while keeping the captures pending. Without a code, a typed
decision refers only to the draft most recently shown by a typed review in that
chat. To keep a draft pending, do nothing or choose Later in the Codex form.
Changes to the underlying pending proposal or destination are refused at save;
edits to the review copies are not checked. Viewing a folder does not itself
approve a save. Multiple drafts are identified by code and note path.

For corrections, leave the proposal pending and provide the correction in the
ordinary work chat. Capture it through the existing selected-source workflow
before revising the proposal, then review the revised proposal before saving.
See the [correction workflow](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/processing-chat.md#claude-limitations).

Use `/cuefluent-notes` before actions in Claude. In Codex, type `$` and select
Cuefluent Notes from the menu before the action; a mention typed out by hand is
not a verified command. `help`, or invoking the skill alone, lists the actions.
See [review controls](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/processing-chat.md#review-controls).

## Capture controls and session handling

- `capture` retains a bounded window of finished turns in a chat that Automatic
  capture does not cover, or has paused. It does not process them or write notes.
- `pause chat` stops Automatic capture for that chat; `resume chat` restarts it.
  Previously retained turns stay preserved.
- Fresh Claude sessions can verify a first typed control through their hook
  registration. Supported Claude CLI background continuation can retain the
  review lineage; the old session cannot decide after handing it on.
- Verified Codex command turns and the plugin's native control traffic are
  excluded under the documented transcript rules. Ordinary work and commentary
  remain eligible evidence; arbitrary copies of generated output are not filtered.

See [capture commands](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/processing-chat.md#capture-commands)
and [native source contracts](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/session-workflow.md).

## Processing and direct saves

Claude processing can explicitly use an already authenticated native CLI profile
when the host cannot pass its authentication to a separate processor. This is an
opt-in account/provider choice, not an automatic fallback. Regular native login
and supported provider configurations are supported; Foundry is not required.
See [Claude authentication](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/processing-chat.md#select-the-processors-authentication).

Retryable retired processing sessions can start a fresh guarded run. Unverified
claims, unfinished writes and conflicts still require inspection; status does not
present an unsafe resume or cancellation as a successful recovery.

An explicit request such as “save this meeting note” still uses direct-save.
A request mixing approval with corrections asks for clarification before calling
tools or writing notes. An exact `save` approves only the reviewed proposal
unchanged. Routing free text depends on the host model following the skill.

Processing uses the selected native client's account and model and can incur
model usage. Plain `process` covers a bounded portion of pending captures across
the configured notes destination's projects and clients; use `process repo` or
`process chat` for a narrower scope and `process resume` for an unfinished
selection. Keep the source host open while processing runs. An accepted request
is not proof that a draft is finished. See
[processing scopes](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/processing-chat.md#shortcut-scopes-and-continuation).

## Runtime and limits

Requires **Node.js 22+** and the matching native CLI for processing. Downloads
include Codex and Claude ZIPs in hook-enabled and manual variants, a marketplace
snapshot and `SHA256SUMS`. Choose one active variant per client. See
[package verification](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/distribution.md#verify-a-selected-package).

Marketplace availability follows the package-update PR's merge into `main`;
publishing a release does not update installed plugins. See
[marketplace updates](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/README.md#update-a-marketplace-installation).

Client registration, transcript formats, review rendering and file-link handling
remain host-dependent. A fresh Codex command can require a registration retry.
Claude source coverage remains partial; inspecting all retained evidence does
not establish completeness. The complete Windows Desktop/CLI workflow remains
unverified. See [product limits](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/references/verification.md).

Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](https://github.com/martinmqz/cuefluent-notes/blob/v0.16.0/LICENSE.md),
not an OSI-approved open-source license.
