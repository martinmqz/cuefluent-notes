# Verification scope

This page describes general coverage and the limits of the plugin's guarantees.

## Automated coverage

The source suite covers session readers, consent boundaries, private storage,
processing state, conflict detection, recovery, note metadata and package integrity
using synthetic inputs. CI runs on native Windows, Linux and macOS and compares
release archive checksums. The [Checks workflow](https://github.com/martinmqz/cuefluent-notes/blob/main/.github/workflows/ci.yml)
defines the current jobs.

Automated checks, package consistency and client registration do not establish hook delivery,
model behavior, host review rendering or Cuefluent app behavior. Supported source
formats are defined by the [reader contracts](session-workflow.md),
not by a matching client version string.

## Product limits

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
  on the client. Installation grants neither collection nor processing consent.
  See [installation](distribution.md) and [setup](setup.md).
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
