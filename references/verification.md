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
  review form; see
  [Claude form limitations](processing-chat.md#claude-form-limitations). Installation grants
  neither collection nor processing consent. See [installation](distribution.md)
  and [setup](setup.md).
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
