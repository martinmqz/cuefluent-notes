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
| Private storage | Native permissions, path/link replacement, owner checks, local storage requirements, hidden raw roots and explicit maintenance |
| Processing and writes | Exact input claims, acknowledged evidence pages, proposals, conflict detection, coordinated receipts, retries and injected recovery failures |
| Portable note metadata | Bounded YAML structure, comment placement, safe unknown fields, unsupported schemas, selected-file ID collisions, descriptive dates/source references and unchanged heading/alias vocabulary; no app indexing or hash-freshness claim |
| Metadata generation and updates | Pure proposal preparation, stable identity/creation/source/unknown-field preservation, byte-identical no-ops, selected capture mappings, stale-write refusals, interrupted-write recovery and both detached client packages; no prose reconciliation or consent inference |
| Related-note authoring | Shipped synthetic examples and newly prepared members share a series while retaining distinct note IDs; explicit series-ID generation and portable quoted dates; guarded later-member updates and earlier-sprint corrections preserve the other member, prior sources and the selected period; this does not automate destination choice, infer membership or execute app series retrieval |
| Distribution | Dependency and documentation closure, detached manual/hook packages, installers, shell launchers, reproducible archives, published-package digests and source-preserving package-update branches, pre-commit digest validation and legacy migration notices |

Windows CI includes Windows PowerShell, PowerShell 7, Git Bash, and a separate
private-storage check under a real standard-user token. Tests for unavailable
local shells or another operating system skip explicitly; such skips are not
verification of that platform.

Functional capture and scheduler tests use controlled budget clocks so native
permission-check latency does not change their expected results. Separate tests
exercise budget expiration, retry, and the default monotonic clock. CLI checks
use the production clock; functional checks are not throughput benchmarks.
On Windows, the real-clock hook and detached-package checks run serially before
the other test files, so concurrent filesystem stress fixtures do not consume
their timing budgets. Production hook and worker deadlines remain unchanged.

## Client registration checks

`node scripts/client-smoke.mjs` downloads locked Codex **0.156.1** and Claude Code
**2.1.280** into temporary profiles and checks plugin registration. CI runs this
separately on macOS and Windows. It does not use the user's profile,
authentication, model calls or hook trust.

The registration checks cover both source installation and the released catalogs
committed on `main`, including removing and re-adding the `cuefluent` marketplace
without duplicate plugin registrations. Source-install checks use the full main
layout, including repo-scoped catalogs. Marketplace checks verify the installed
identity, release version and cached checker/workflow helpers. They use local
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

- Synthetic reader fixtures and emitted hook payloads do not establish live
  current-turn identity transport or context delivery. Native Save / Skip
  rendering, conversational current-turn controls and automatic Markdown
  processing are not verified; use the supported explicit CLI operations.
- Claude extraction preserves proven human input with unconfirmed coverage;
  it does not infer assistant ownership or completed turns from ordinary
  transcript parentage.
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
