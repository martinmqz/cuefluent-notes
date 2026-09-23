# Cuefluent Notes

Capture and maintain useful information as ordinary Markdown. Standups, meeting
and task summaries, decisions, documentation, bug findings, and KB entries use
one workflow: preserve evidence and meaningful dates, infer search vocabulary,
and update the appropriate document without making parallel copies.

The workflow is self-contained. It requires no Cuefluent app, source checkout,
workspace packages, or Devlog. Suitable existing notes remain authoritative;
derived documents are created only when the requested purpose warrants them.
User notes, private evidence, local configuration, and update state stay outside
this public repository. The bundled examples are fictional.

## Install in Codex or Claude Code

### From the marketplace

For a [published release](https://github.com/martinmqz/cuefluent-notes/releases),
you need **Git, Node.js 22+, and a current client CLI** on Windows, macOS, or
Linux. Runtime dependencies are included; no npm install or source checkout is
needed. Windows requires plugin version **0.6.0+**.

**Codex:**

```sh
codex plugin marketplace add martinmqz/cuefluent-notes --ref marketplace
codex plugin add cuefluent-notes@cuefluent
```

**Claude Code:**

```sh
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#marketplace
claude plugin install cuefluent-notes@cuefluent --scope user
```

These commands use our GitHub-hosted `cuefluent` marketplace. They work after
the first release's **Publish marketplace** workflow succeeds. If no release
has been published yet, use the source installer below. This is separate from
an OpenAI or Anthropic public-directory listing.

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

1. **Start a new session** after installation. Restart the client if the plugin
   is not visible.
2. **Review the plugin hooks** in your client. Codex requires hook trust through
   its hook controls (`/hooks` in the CLI).
3. Say **“Set up Cuefluent Notes.”** Choose **Manual**, **Suggestions**, or
   **Automatic**. The agent guides you through any project and notes-location
   choices, then verifies the result.

Installation leaves existing capture settings unchanged. On a fresh install,
**capture stays off until you choose a mode**. Manual keeps it off; Suggestions
offers an optional Save / Skip choice after completing work in an interactive
conversation; Automatic captures eligible work within your chosen scope.
You do not need the Cuefluent app. Keep your notes outside the plugin and source
checkout.

Choose a notes folder to keep multiple files named for their content. The agent
reuses a relevant note or proposes a descriptive filename, such as
`v1.0-release.md`, when there is something useful to save. Filenames do not get
an automatic plugin-name prefix. You can also
select a specific Markdown file to keep using that file. Existing file-based
settings stay unchanged until you request a folder instead.

Folders default to a flat collection. Version **0.7.0+** also supports optional
**by-type** organization: `meetings/`, `tasks/`, `knowledge-base/`, and `decisions/`.
For example, a new meeting could use `meetings/release-planning.md`; general or
unclear content stays at the root. The agent first preserves explicit destinations
and suitable existing notes, so enabling this option does not move files or create
duplicate category copies. There is no required `type:` field or task lifecycle.

Suggestions show the complete proposed path, edit, and any folder creation before
Save / Skip. Skipping or leaving it unanswered creates neither notes nor folders.
Type folders require every installed reader of the shared policy to support
0.7.0+; installation alone does not change organization or capture consent.
Ask to change organization only after confirming a supported way to load those
files into Cuefluent. App loading of nested files, including recursive discovery,
has not been verified here; keep flat organization until it is. See
[note placement](references/workflow.md#note-placement) and
[verification](references/verification.md#note-type-folders-070).

### Update a marketplace installation

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

Start a fresh session after updating and review changed hook definitions.
Private capture settings and notes stay outside the replaceable package.

### Update or customize a source installation

To update an installation made by these commands, pull the repository changes
and repeat the command for your client:

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
for locations, compatibility, and recovery. The `main` branch contains source;
the generated `marketplace` branch contains released, directly installable packages.

## Use the workflow

After installation, start a fresh task and say **“Set up Cuefluent Notes”** or
**“Use Cuefluent Notes.”** The skill checks its status and walks you through
manual use, suggested updates, or automatic capture. For capture, it asks which
project to cover and where notes should go, then saves and verifies the settings.
You do not need to write JSON. See [first-use setup](references/setup.md).

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

Use Node 22 or later and Git, plus `unzip` and `tar` for the release extraction
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

## Optional capture assistance

The hook variant registers `SessionStart`, `UserPromptSubmit`, and `Stop`. After explicit private policy
configuration and each client's setup/trust, it reminds the current agent to use
the same workflow before completing eligible work. No useful change means no
note write. Read-only requests, opt-outs, scope, manual edits, and configured
routing take precedence.

Without configuration, a trusted startup hook displays a brief host notice and
leaves capture off. It adds no instructions to the model and no sentence to
assistant answers; unconfigured prompt hooks stay quiet. A saved manual
preference disables the shared capture policy and its notices. Hooks store no payloads,
transcripts, or markers and call no other model. An optional Stop check can ask
the working agent to finish a missed capture decision once. It requires separate
opt-in because the agent keeps a small private completion marker. Existing
settings stay unchanged; ask **“Enable the Cuefluent Notes completion check”**
after upgrading all installed clients to 0.6.0+. A Save / Skip proposal settles
the check without waiting for approval. See [completion checks](references/completion.md).
Use the helper only with existing permission to write its private state, without
requesting extra permission each turn. Recovery arms after the first successful marker
in that session and permission mode, and stays off in plan or unknown modes.
Duplicate avoidance depends on reading the destination and reviewing meaning; it is not an
exactly-once guarantee. Read [hook guidance](references/hooks.md) before opting in.

## Verification and licensing

Verification covers synthetic content and vocabulary, safe-update conflicts and
recovery, adapter routing and privacy, and standalone packaged helpers. Live
model checks used macOS with Node `26.2.0`. CI uses Node 22 on native Windows,
Linux, and macOS for helpers, shell hooks, packaging, and matching release
checksums. Real CLI registration checks use disposable Windows/macOS profiles;
live model hook behavior on Windows and Linux remains unverified.

Authorized live CLI smoke tests also exercised temporary plugin loading and
synthetic capture; see [verification results](references/verification.md) for
the tested clients, cases, and remaining limits. Real-user pilot usefulness,
actual Cuefluent rendering/loading/ranking, and already-open session reload
behavior remain unverified. Publication status is shown on the
[releases page](https://github.com/martinmqz/cuefluent-notes/releases).

The project has no assigned license. Bundled dependencies retain their own
license notices; no project license is inferred from those dependencies.
