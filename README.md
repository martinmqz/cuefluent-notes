# Cuefluent Notes

Capture and organize your knowledge for fast recall—right on cue.

Cuefluent Notes has two independent steps: a local worker collects selected parts
of Codex or Claude sessions as immutable JSON evidence; an agent turns selected
evidence into clear, searchable Markdown. Directly saving user-selected material
also works without session collection. Notes stay ordinary files with descriptive
names and optional type folders.

**v0.8.0** introduced this replacement workflow. Published versions through
**v0.7.1** use the prior workflow. The new workflow does not import old capture
settings. Fresh setup leaves collection off and processing Manual. Installation
and hook trust enable neither process.

The plugin requires no Cuefluent app or Devlog. User notes, raw evidence and private
settings belong outside the replaceable package; examples in this repository are
fictional.

## Install in Codex or Claude Code

### From the marketplace

Marketplace installation uses the published packages on the repository's `main`
branch. A release becomes installable this way after its package-update PR merges;
a GitHub release alone does not update the catalog. Check the
[main branch](https://github.com/martinmqz/cuefluent-notes/tree/main) for `release.json`
and both marketplace catalogs. If they are absent, use [source installation](#from-source).

Once the catalogs are available, choose your client:

**Codex**

```sh
codex plugin marketplace add martinmqz/cuefluent-notes --ref main
codex plugin add cuefluent-notes@cuefluent
```

**Claude Code**

```sh
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#main
claude plugin install cuefluent-notes@cuefluent --scope user
```

These complete packages need Git, Node.js 22+ on the client's PATH and a current
client CLI; no source checkout or npm install is needed. Published
[release downloads](https://github.com/martinmqz/cuefluent-notes/releases) also offer
manual ZIPs without hooks. See [package installation](references/distribution.md).
Keep one active installation per client and update through its original method.
This is a publisher-hosted marketplace, not an OpenAI or Anthropic directory listing.

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

1. Start a fresh session after installation. Review the plugin's hooks and the
   bundled `cuefluent_control` MCP server registration and permissions in your
   client; Codex exposes hook trust through `/hooks`. Both package variants
   include the server, which the client can start when loading the plugin.
2. Say **“Set up Cuefluent Notes.”** Select a project and where Markdown should go.
   The agent prepares private, machine-local evidence and state directories.
3. Choose collection and processing separately. Collection can cover selected
   sessions or future sessions in the project. Processing can be Manual,
   Prompted (approve Save / Skip), or Automatic within your chosen scope.

**Processing starts with an explicit request.** For the reusable processing chat,
select the Cuefluent Notes skill in Codex and enter `process`, or use
`/cuefluent-notes:cuefluent-notes process` in Claude. Invoke the same skill with
`review` to review an exact proposal through the client's supported native form.
The controller uses the existing native client and processing engine; it does not
require the Cuefluent app. See [processing chats](references/processing-chat.md)
for prerequisites, capture prevention and recovery.

Hook notifications do not automatically start Markdown processing. Explicit CLI
processing remains available with selected native sessions/units; identity is
never inferred from the current folder. Automatic collection can run after setup
and hook trust. New selection starts at the current file boundary, excluding the
initial boundary unit; it does
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

Before updating clients that share a collection, follow the
[coordinated upgrade steps](references/setup.md#existing-settings). Preserve notes,
settings, captures and active operations. The catalog's `release.json` identifies
the available package version; it may lag development source or a newly published
release until the package-update PR merges.

**Codex**

```sh
codex plugin marketplace upgrade cuefluent
codex plugin add cuefluent-notes@cuefluent
```

**Claude Code**

```sh
claude plugin marketplace update cuefluent
claude plugin update cuefluent-notes@cuefluent --scope user
```

Use the scope of your existing Claude installation if it differs from `user`.
Restart affected clients after all shared-store helpers are updated. Review changed
hooks and the `cuefluent_control` MCP registration and permissions before resuming;
neither installation nor server availability enables collection or automatic
Markdown processing. See [processing chat prerequisites](references/processing-chat.md).

#### Switch an older marketplace registration to main

Registrations pinned to `marketplace` do not follow `main` automatically. First
confirm that both catalogs and `release.json` are published on `main`, then follow
the [coordinated upgrade steps](references/setup.md#existing-settings). Do not
remove a working registration before its replacement is available.

For a Codex registration named `cuefluent`:

```sh
codex plugin marketplace remove cuefluent
codex plugin marketplace add martinmqz/cuefluent-notes --ref main
codex plugin add cuefluent-notes@cuefluent
```

For a Claude user installation registered as `cuefluent`:

```sh
claude plugin marketplace remove cuefluent --scope user
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#main --scope user
claude plugin install cuefluent-notes@cuefluent --scope user
```

Use the existing marketplace name and Claude scope if different. Keep notes,
workflow settings, evidence and writer state outside the replaceable package;
do not rerun setup or move storage for this registration change. Restart the
client and review changed hooks and MCP permissions. The old branch may be absent,
so a migration notice from that branch is not required to make this switch.

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
Start a new session after updates and review changed hooks and the bundled
`cuefluent_control` MCP registration and permissions.

Append `-- --manual` for a package with no hooks, or `-- --cli /absolute/path`
to choose a client executable. Run `node scripts/install.mjs --help` for options.
The source checkout is needed for updates; installed helpers run independently.

See [installation details and troubleshooting](references/distribution.md#guided-installer)
for locations, compatibility, and recovery. Published marketplace packages coexist
with development source on `main`; `release.json` identifies their version
independently of the source package version.

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
storage, outside projects, notes and the plugin. Fresh Windows setups use a
shared local profile directory; existing settings are preserved. See
[Windows storage selection](references/setup.md#windows-storage-selection) for
Desktop/CLI selection, package-store limits and profile checks.

## Verification

See [verification scope](references/verification.md) for general automated coverage
and product limits, including source completeness, processing feedback, client
integration and Cuefluent app behavior. Publication status is on the
[releases page](https://github.com/martinmqz/cuefluent-notes/releases).

## License

Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](LICENSE.md). You may use and modify it for personal,
non-commercial, or internal business purposes. Redistribution must be free of
charge and for non-commercial purposes. Selling the plugin, commercial
redistribution, or selling access to it requires separate permission from the
applicable copyright holders. For licensing inquiries, [open an issue with
Cuefluent](https://github.com/martinmqz/cuefluent-notes/issues/new). An inquiry does
not grant permission or guarantee that a separate license is available.
Contributors retain their copyrights; contributing under this license does not
assign ownership or grant Cuefluent additional sublicensing rights. This is not
an OSI-approved open-source license; the full license controls.

Using the plugin does not place this license on your inputs, captures, or authored
notes. Any plugin code or other third-party material copied into them retains its
applicable license. Bundled dependencies keep their own licenses and notices.
The Cuefluent app is a separate product with its own terms; it is not required to
use this plugin.
