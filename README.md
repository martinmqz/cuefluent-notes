# Cuefluent Notes

Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes has two independent steps: a local worker collects selected parts
of Codex or Claude sessions as immutable JSON evidence; an agent turns selected
evidence into clear, searchable Markdown. Directly saving user-selected material
also works without session collection. Notes stay ordinary files with descriptive
names and optional type folders.

**v0.8.0** introduces this replacement workflow. Published versions through
**v0.7.1** use the prior workflow. The new workflow does not import old capture
settings. Fresh setup leaves collection off and processing Manual. Installation
and hook trust enable neither process.

The plugin requires no Cuefluent app or Devlog. User notes, raw evidence and private
settings belong outside the replaceable package; examples in this repository are
fictional.

## Install in Codex or Claude Code

### From the marketplace

For a [published release](https://github.com/martinmqz/cuefluent-notes/releases),
you need **Git, Node.js 22+, and a current client CLI** on Windows, macOS, or
Linux. Runtime dependencies are included; no npm install or source checkout is
needed. The commands install the published version, which may differ from this source.

**Codex:**

```sh
codex plugin marketplace add martinmqz/cuefluent-notes --ref main
codex plugin add cuefluent-notes@cuefluent
```

**Claude Code:**

```sh
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#main
claude plugin install cuefluent-notes@cuefluent --scope user
```

These commands use our GitHub-hosted `cuefluent` marketplace on `main`. Its
catalogs point to complete released packages in this repository. Development
changes do not update those packages until a release is published and its
package-update PR is merged. This is
separate from an OpenAI or Anthropic public-directory listing.

Keep only one active Cuefluent Notes installation per client. If you previously
installed from source or copied a standalone skill, remove that registration
and move its package aside before switching. Keep your private notes and capture
settings. Marketplace packages include optional hooks; capture still requires
the [first-use choices below](#start-using-it).

### From source

You need **Git, Node.js 22+ with npm, and a current client CLI** (`codex` or
`claude`). Native Windows, macOS, and Linux are supported. On Windows, use
PowerShell or Command Prompt; WSL is not required.

Clone once:

```sh
git clone https://github.com/martinmqz/cuefluent-notes.git
cd cuefluent-notes
```

Then choose your client:

| Codex | Claude Code |
| --- | --- |
| `npm run install:codex` | `npm run install:claude` |

In Windows PowerShell, use `npm.cmd run install:codex` or
`npm.cmd run install:claude` if execution policy blocks `npm.ps1`. No global
execution-policy change is needed. Paths with spaces must be quoted.

Run both commands if you use both clients. Each command installs the locked
build dependencies, builds a complete plugin, and installs it for your user.
There is no JSON to write or separate packaging step.

You can also ask the agent to do it:

```text
Install Cuefluent Notes from https://github.com/martinmqz/cuefluent-notes
for this user. Clone the repository and run its install:codex npm script
(or install:claude in Claude Code). Leave capture mode selection to setup.
```

### Start using it

1. Start a fresh session after installation and review the plugin's hooks in
   your client. Codex exposes hook trust through `/hooks`.
2. Say **“Set up Cuefluent Notes.”** Select a project and where Markdown should go.
   The agent prepares private, machine-local evidence and state directories.
3. Choose collection and processing separately. Collection can cover selected
   sessions or future sessions in the project. Processing can be Manual,
   Prompted (approve Save / Skip), or Automatic within your chosen scope.

The current client transport is not verified for automatic processing or
conversational current-turn controls. **Use an explicit processing request** and
select the native session/units; the agent must not infer identity from the current
folder. Automatic collection can run after setup and hook trust. New selection
starts at the current file boundary, excluding the initial boundary unit; it does
not sweep historical session contents. Explicit historical capture reviews a
fixed byte window and named units.

For example: “Process the pending captures from this selected session into a
meeting note; show me the proposed change before saving.” Or: “Save this supplied
meeting summary to my notes.” The latter needs no session capture setup.
See [setup](references/setup.md) and [explicit controls](references/workflow-cli.md).

New folder destinations default to type folders. The agent infers the type from
context: `meetings/`, `tasks/`, `knowledge-base/`, or `decisions/`; general content
stays at the root. Explicit files and suitable existing notes take precedence.
No type questionnaire, automatic renaming, or duplicate category copy is needed.
Prompted processing shows the complete proposed path, edit and new folders before
approval; Skip creates no notes or folders. An explicit flat layout is supported.
Cuefluent's recursive loading and search ranking remain separately unverified.

### Update a marketplace installation

Before updating from v0.8.0 to v0.9.0, follow the
[coordinated upgrade steps](references/setup.md#existing-settings): stop collection
and processing and update every client sharing its storage before starting fresh
sessions. Mixed-version access and downgrades of that storage are unsupported.
Existing workflow settings, paths and notes are preserved; fresh setup is not
required.

For Codex:

```sh
codex plugin marketplace upgrade cuefluent
codex plugin add cuefluent-notes@cuefluent
```

For Claude Code:

```sh
claude plugin marketplace update cuefluent
claude plugin update cuefluent-notes@cuefluent --scope user
```

Review changed hook definitions after updating.

#### Switch an older marketplace registration to main

If you originally installed using `--ref marketplace` or `#marketplace`, change
that registration once. Ordinary marketplace updates retain its old branch.
Close sessions using the plugin and let workers finish first. Remove only the
`cuefluent` marketplace registration, then register it from `main` and reinstall:

**Codex:**

```sh
codex plugin marketplace remove cuefluent
codex plugin marketplace add martinmqz/cuefluent-notes --ref main
codex plugin add cuefluent-notes@cuefluent
```

**Claude Code** (user installation):

```sh
claude plugin marketplace remove cuefluent --scope user
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#main --scope user
claude plugin install cuefluent-notes@cuefluent --scope user
```

For a project-scoped Claude installation, use its existing scope instead of
`user`. Keep private notes, workflow settings and evidence storage; no fresh
setup is needed. Start a new session and review hooks afterward. The former
`marketplace` branch retains its existing packages; release publication adds a
migration notice to its README. Future releases become available on `main` after their package-update PR merges.

### Update or customize a source installation

To update an installation made by these commands, pull the repository changes
and repeat the command for your client. Follow the same
[coordinated upgrade steps](references/setup.md#existing-settings) before updating
any clients that share storage:

```sh
git pull --ff-only
npm run install:codex
# Or: npm run install:claude
```

Updates preserve the previous package in a backup directory printed by the
installer. A package installed by another method is left untouched: use that
method to update it, or remove/move that copy before switching to this installer.
Start a new session after updates and review changed hook definitions.

Append `-- --manual` for a package with no hooks, or `-- --cli /absolute/path`
to choose a client executable. Run `node scripts/install.mjs --help` for options.
The source checkout is needed for updates; installed helpers run independently.

See [installation details and troubleshooting](references/distribution.md#guided-installer)
for locations, compatibility, and recovery. The `main` branch contains both the
development source and generated, directly installable release packages.
`release.json` identifies the currently published marketplace version; source
version fields may already target the next release.

## Use the workflow

Say **“Use Cuefluent Notes”** with selected sources and the desired outcome.
The agent follows the configured collection/processing boundaries and checks
[status](references/setup.md). Direct saves use the same guarded writer as
processed session evidence.

Start with [SKILL.md](SKILL.md), or ask an agent to use it with selected evidence
and a requested destination. For example:

- “Log this decision in the existing project note.”
- “Prepare tomorrow's standup from these dated findings.”
- “Update this feature explanation with the verified behavior and its limits.”
- “Check these notes and infer useful lookup phrases.”

[Log, Prepare, Update, Refresh, and Check](references/workflow.md) share ordinary
Markdown and [evidence rules](references/evidence.md). No keyword questionnaire,
Q&A template, daily file tree, or output bundle is required. H1/H2 headings and
optional aliases supply search vocabulary; body text and deeper headings do not.
The [checker](references/retrieval.md) reviews documented structure and vocabulary
without claiming Cuefluent rendering or search ranking.

[Safe updates](references/refresh.md) apply reviewed text against inspected
hashes. Derived manifests track source drift and detect manual edits. The writer
replaces one file atomically at a time and supports bounded recovery; it does
not infer facts, merge competing edits, or make a collection-wide transaction.

## Run from the source checkout

Use Node 22 or later, Git and Bash, plus `unzip` and `tar` for the release extraction
tests. From this repository:

```sh
npm ci --ignore-scripts
npm test
npm run check:examples
node scripts/check-notes.mjs /absolute/private-notes/project.md
```

The tests and examples use synthetic material. Keep real query cases, proposals,
and source mappings in selected private locations. See [retrieval](references/retrieval.md)
for checker commands and [refresh](references/refresh.md) for write plans.

## Build a standalone plugin package

The builder produces separate Codex and Claude plugin directories:

```sh
npm run package
npm run package -- --hooks
```

The first command builds `dist/manual`; the second builds `dist/hooks`.
Each contains `codex/cuefluent-notes` and `claude/cuefluent-notes`, with the full
skill, guides, examples, helpers, and runtime dependencies. The default manual
variant registers no hooks. Select one variant per client because both use the
same plugin identity. Existing output directories are not overwritten; use
`--out /absolute/fresh-package-output` for another build.

Packaged helpers require Node 22+, but no npm install or development checkout at
runtime. See [distribution](references/distribution.md) for layout, validation,
client-specific loading and installation, and supported-platform limits.
Building packages does not install, trust, publish, or register a marketplace.

To prepare marketplace catalogs, four versioned plugin ZIPs, a marketplace
snapshot, and SHA-256 checksums:

```sh
npm run release:build
```

This creates a fresh `dist/release`. See the [publisher guide](references/publishing.md)
for release automation, first publication, and public-directory submission materials.

## Optional session collection

Hook packages register SessionStart, UserPromptSubmit, Stop, SessionEnd, and
Codex Interrupt or Claude StopFailure. Ingress stores bounded native metadata
and launches a short-lived local worker only with fresh collection permission.
Unconfigured and fully disabled projects cause zero filesystem writes.
Synchronous hooks never scan source text, call models, write Markdown, block a
prompt, or request a recovery continuation. There is no old Stop completion check.

The worker reads only selected source ranges. Codex supports verified turn
boundaries and completed/interrupted/failed flags. Claude currently retains
proven human input only, marked unconfirmed; assistant parentage is insufficient
proof of ownership. Source text is untrusted evidence, not instructions.
See the [reader coverage matrix](references/session-workflow.md) and
[hook limits](references/hooks.md).

Collection and processing can be paused independently; user opt-outs override
saved permission. Raw evidence is private and may contain sensitive information;
collection does not automatically redact it. Pruning and abandoned-lock recovery
require explicit, reviewed commands. Intake and writer state must stay on local
storage, outside projects, notes and the plugin.

## Verification and licensing

Verification covers synthetic readers, consent boundaries, private storage,
writer conflicts/recovery and detached packages. CI uses Node 22 on native
Windows, Linux and macOS, including Windows shells and a standard-user ACL check.
See [verification scope](references/verification.md) for automated coverage,
pinned-client registration tests and remaining limits. Historical live-model
checks for v0.7.1 do not certify this replacement. Live current-turn transport,
native Save / Skip rendering, desktop launch PATH and Cuefluent loading/ranking
remain unverified. Publication status is on the
[releases page](https://github.com/martinmqz/cuefluent-notes/releases).

The project has no assigned license. Bundled dependencies retain their own
license notices; no project license is inferred from those dependencies.
