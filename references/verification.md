# Product limits

This page describes the boundaries of the installed plugin. Use the linked
contracts for supported commands, formats, permissions and recovery procedures.

- Hooks do not start automatic Markdown processing or supply a usable processing
  `contextRef`. Processing requires an explicit request. See
  [hook transport limits](hooks.md#failure-and-transport-limits).
- The [dedicated processing controller](processing-chat.md) disables inherited
  hooks and supports exact native record exclusions. Arbitrary generated-output
  copy attribution is unsupported; inline processing in a collected chat can
  still enter later captures. Existing packet copies are not automatically
  filtered from processing.
- Collection budgets can omit original content. Inspecting every retained page
  does not establish source completeness, and future retention improvements
  cannot recover previously omitted output.
- Claude extraction retains proven human input with unconfirmed coverage. It
  does not infer assistant ownership or completed turns from ordinary transcript
  parentage. See the [Claude reader contract](session-workflow.md#claude-reader-contract).
- Processing uses the native client's model resolution. Persistent controller
  status does not report the resolved model; neither successful dispatch nor
  structural Markdown checks certify classification or summary quality.
- Host hook trust, launch PATH, session reload and native review rendering depend
  on the client. Tested Claude Desktop and CLI versions cannot complete a native
  review form, so Claude reviews through the private review folder and typed
  decisions; see [Claude limitations](processing-chat.md#claude-limitations).
  Opening or reading the review folder is not verified by the plugin. Installation grants
  neither collection nor processing consent. See [installation](distribution.md)
  and [setup](setup.md).
- Typed controls and decisions are verified against the client's native
  transcript: Claude's skill command with its skill expansion, or Codex's skill
  block or `$`-list skill selection with the typed text. Input recorded in another
  shape, including a Codex mention typed out by hand, is treated as unverified
  and decides nothing. These channels resist the chat model, not a local
  process: any process running as the user can drive the client or the helper
  commands. See [review controls](processing-chat.md#review-controls).
- A verified Codex control turn, direct or in code mode, is kept out of captures
  only when the whole completed turn has exactly the verified shape. Anything
  else in it, such as commentary, the assistant reading a file or calling another
  tool, keeps that turn collectible with the assistant's own words; its exact
  command, command markup, this plugin's control calls and the assistant's
  repetition of the plugin's reply are still left out. A mention typed out by hand
  is collected as typed. Code-mode cells are
  bound through the IDs Codex sends with the call, which Codex CLI 0.163's source
  shows model-written code cannot set; other Codex versions and the installed
  binaries themselves are not checked. A nested tool that leaves no native record
  is not visible to the check. A Claude Desktop session connected for Remote
  Control stops collection at its first `bridge-session` record. See
  [capture prevention](processing-chat.md#capture-prevention-and-limits).
- Routing text typed after the skill command, such as a plain-language request
  that starts with `save`, depends on the model following
  [the skill](../SKILL.md#formal-processing-controls). Verified inexact text
  applies nothing whichever control is called; text that cannot be verified
  binds as a model-chosen call, which can display a draft or run another control
  but never decides a draft.
- A control typed as the first prompt of a fresh Claude session binds through
  its registration within a bounded read; a Codex control binds once the session
  has a collection selection or processing-only binding. A continued Claude CLI
  session joins the review lineage only under the
  [continuation conditions](session-workflow.md#claude-reader-contract).
- Windows profile, package visibility and indexing policies vary by host. Existing
  package stores have limits on additions and replacement setup, and automatic
  migration is unsupported. No universal protection from third-party indexing or
  sync is claimed. See [Windows storage selection](setup.md#windows-storage-selection).
- The complete fresh Windows Desktop/CLI workflow, including setup, live
  collection, processing and a duplicate-safe retry, remains unverified.
- Recovery does not guarantee survival of every OS termination or sudden power
  loss. Windows lacks Node directory fsync, so its power-loss durability is weaker.
- Plugin filesystem and Markdown checks do not establish Cuefluent recursive file
  admission, rendering, image loading or search ranking. See the
  [authoring contract](authoring.md).
