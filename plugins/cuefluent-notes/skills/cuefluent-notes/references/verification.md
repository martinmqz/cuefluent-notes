# Verification scope

Automated checks exercise the selected-session workflow in disposable locations
with synthetic evidence. CI runs the source suite on Node.js 22 on native Windows,
Linux and macOS. It also builds detached release packages on each platform and
compares their checksums. See the [Checks workflow](https://github.com/martinmqz/cuefluent-notes/blob/main/.github/workflows/ci.yml)
in the source repository for the current jobs.

| Area | Automated coverage |
| --- | --- |
| Session readers | Supported Codex and Claude record shapes across varying version metadata, selected boundaries, native identity/order, bounded reads, exclusions, partial records and immutable revisions |
| Consent and controls | Independent collection/processing settings, opt-outs, stale settings, explicit selection and zero-write ingress for disabled or unconfigured projects |
| Private storage | Native permissions, path/link replacement, owner checks, local storage requirements, hidden raw roots, profile/indexing policy, aliased native folder facts and explicit maintenance |
| Processing and writes | Exact input claims, acknowledged evidence pages, metadata-only operation states, bounded packet admission, frozen worksets, cross-client admission, proposals, conflict detection, coordinated receipts, retries and injected recovery failures |
| Processing controller | Metadata-only status and review, guarded offline retirement with preserved engine work, pre-dispatch retry, historical namespace reuse, exact native-call rebinding, nonfatal host notifications, policy rechecks and narrower-claim resumption; synthetic native transports do not establish live Desktop behavior |
| Backlog acceptance | Synthetic repeated facts completed unchanged, multiple revisions mapped to one existing subject note, resumed/reversed-order correction review with rejection of prior proposal authority, unavailable-image and output-gap retention; authored fixture text tests engine preservation, not model synthesis |
| Capture fairness and echoes | Bounded per-call/kind tool text, explicit clipping descriptors, Unicode accounting, later failure/correction retention, old-reader replay and checkpoint continuity; forged markers and new identities retain unproven echoes |
| Portable note metadata | Bounded YAML structure, comment placement, safe unknown fields, unsupported schemas, selected-file ID collisions, descriptive dates/source references and unchanged heading/alias vocabulary; no app indexing or hash-freshness claim |
| Metadata generation and updates | Pure proposal preparation, stable identity/creation/source/unknown-field preservation, byte-identical no-ops, selected capture mappings, stale-write refusals, interrupted-write recovery and both detached client packages; no prose reconciliation or consent inference |
| Related-note authoring | Shipped synthetic examples and newly prepared members share a series while retaining distinct note IDs; explicit series-ID generation and portable quoted dates; guarded later-member updates and earlier-sprint corrections preserve the other member, prior sources and the selected period; this does not automate destination choice, infer membership or execute app series retrieval |
| Distribution | Dependency and documentation closure, detached manual/hook packages, installers, shell launchers, reproducible archives, captured shared inputs and client parity, metadata consistency, bounded read-only inventory verification and trusted inventory digests, published-package digests and source-preserving package-update branches, pre-commit digest validation and legacy migration notices |

Windows CI includes Windows PowerShell, PowerShell 7, Git Bash, and a separate
private-storage check under real standard-user tokens. It exercises local profile
creation and inherited indexing attributes, missing-attribute refusal, non-admin
profile policy queries and isolation from a second standard user with a positive
parent-access control. Synthetic settings tests isolate default/AppData discovery
from the developer's installed stores. Tests for unavailable
local shells or another operating system skip explicitly; such skips are not
verification of that platform.

Functional capture and scheduler tests use controlled budget clocks so native
permission-check latency does not change their expected results. Separate tests
exercise budget expiration, retry, and the default monotonic clock. CLI checks
use the production clock; functional checks are not throughput benchmarks.
On Windows, native ACL query comparisons, real-clock hook and detached-package
checks run serially before the other test files, so concurrent filesystem stress
fixtures do not consume their timing budgets. Production hook and worker
deadlines remain unchanged.
The native ACL comparison checks direct .NET queries against PowerShell provider
snapshots, including inherited permissions, denied and broad grants, junctions,
changed permissions and attributes. Long names retain the existing provider
behavior; a native comparison verifies matching results or matching refusal.
The comparison reports warm-query timings
without using shared-runner performance as a correctness threshold.

## Client registration checks

`node scripts/client-smoke.mjs` downloads locked Codex **0.156.1** and Claude Code
**2.1.280** into temporary profiles and checks plugin registration. CI runs this
separately on macOS and Windows. It does not use the user's profile,
authentication, model calls or hook trust.

The client-smoke job skips tag refs. It strictly validates a Claude package and
marketplace built separately in its disposable source checkout; these are not the
exact Linux CI archives attached to a draft release. Exact release-asset validation
and live acceptance remain separate [publication checks](publishing.md#publish-the-github-marketplace).

The registration checks cover source installation. When released catalogs are
committed on `main`, they also cover removing and re-adding the `cuefluent` marketplace
without duplicate plugin registrations. A source-only checkout reports the
marketplace checks as skipped; a partially present marketplace fails. Source-install
checks use the checkout layout, including repo-scoped catalogs when present.
Marketplace checks verify the installed identity, release version and cached
checker/workflow helpers. They use local
catalogs; remote Git
authentication, GitHub PR creation/CI dispatch and protected-branch merging still
require separate checks.

These versions pin reproducible registration tests; they are not runtime reader
requirements. Synthetic fixtures also vary release, prerelease and build version
labels and exercise Codex and Claude sessions across a client update, including
rejection of Codex history-mode changes. Changing a fixture's version label does
not verify that client's actual emitted format or future injection flags.

The [session workflow](session-workflow.md) documents the supported reader
formats and their source evidence. A matching client version or successful
registration does not prove that every session shape, hook event or desktop
integration works.

## Evidence limits

- Synthetic reader fixtures and emitted hook payloads do not establish live hook
  current-turn identity transport or automatic Markdown processing. Native-client
  protocol experiments use disposable profiles and synthetic provider responses
  outside the reproducible suite. They exercise restricted create/resume, tool restrictions, formal control
  identity and host review-form delivery. They do not establish desktop sidebar
  visibility, physical user approval, or a complete live desktop workflow.
  The native client resolves the processing model under restricted launch settings;
  persistent controller status does not yet report that resolved model.
- Arbitrary generated-output copy attribution remains unverified. The
  [dedicated controller](processing-chat.md) disables inherited hooks and supports
  exact native record exclusions; inline processing output in ordinary chats can
  still enter later captures. Processing does not filter existing packet copies.
  Budget fairness improves future retention but cannot restore previously omitted
  text. Complete page inspection does not establish complete original sources.
- Claude extraction preserves proven human input with unconfirmed coverage;
  it does not infer assistant ownership or completed turns from ordinary
  transcript parentage.
- A fresh default setup from Windows Desktop and CLI in a clean account,
  followed by live collection, processing and a duplicate-safe retry, remains
  unverified. Synthetic redirection tests and native permission fixtures do not
  establish that complete client workflow. Existing package stores are preserved;
  automatic migration is unsupported. Host profile, package visibility and indexing
  policies can differ; no universal third-party indexing/sync protection is claimed.
- Desktop Node PATH, already-open session reload and changed hook trust require
  verification in the user's client. Installation alone enables neither
  collection nor processing consent.
- Actual Cuefluent recursive file admission, rendering, image loading and search
  ranking remain unverified.
- Injected exceptions exercise recovery boundaries, not every OS termination or
  sudden power-loss scenario. Windows lacks Node directory fsync, so its
  power-loss durability is weaker.
- Historical live-model results for v0.7.1 do not certify the replacement
  workflow. Automated tests do not certify a model's classification or summaries.

## Reproduce the checks

From the source checkout with Node.js 22+ and the maintenance tools listed in
[publishing prerequisites](publishing.md#build-and-inspect-a-release):

```sh
npm ci --ignore-scripts
npm test
npm run check:examples
npm run release:build -- --out /absolute/fresh-output
```

Use a fresh build destination. Run the pinned-client smoke command explicitly
when client registration needs checking.
