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
you need **Git, Node.js 22+, and a current client CLI**. Runtime dependencies
are included; no npm install or source checkout is needed.

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
`claude`). The installer supports macOS/Linux shells; macOS is tested.

Clone once:

```sh
git clone https://github.com/martinmqz/cuefluent-notes.git
cd cuefluent-notes
```

Then choose your client:

| Codex | Claude Code |
| --- | --- |
| `npm run install:codex` | `npm run install:claude` |

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

The hook variant registers `SessionStart` and `UserPromptSubmit`. After explicit private policy
configuration and each client's setup/trust, it reminds the current agent to use
the same workflow before completing eligible work. No useful change means no
note write. Read-only requests, opt-outs, scope, manual edits, and configured
routing take precedence.

Without configuration, a trusted startup hook displays a brief host notice and
leaves capture off. It adds no instructions to the model and no sentence to
assistant answers; unconfigured prompt hooks stay quiet. A saved manual
preference disables the shared capture policy and its notices. Hooks store no payloads, transcripts, or
receipts, call no other model, and request zero continuations. Duplicate avoidance
depends on reading the destination and reviewing meaning; it is not an
exactly-once guarantee. Read [hook guidance](references/hooks.md) before opting in.

## Verification and licensing

Verification covers synthetic content and vocabulary, safe-update conflicts and
recovery, adapter routing and privacy, and standalone packaged helpers. Live
client checks used macOS with Node `26.2.0`. CI targets Node 22 on Linux and
macOS for standalone helpers, packaging, and publication logic; live client
hook behavior on Linux remains unverified.

Authorized live CLI smoke tests also exercised temporary plugin loading and
synthetic capture; see [verification results](references/verification.md) for
the tested clients, cases, and remaining limits. Real-user pilot usefulness,
actual Cuefluent rendering/loading/ranking, and already-open session reload
behavior remain unverified. Publication status is shown on the
[releases page](https://github.com/martinmqz/cuefluent-notes/releases).

The project has no assigned license. Bundled dependencies retain their own
license notices; no project license is inferred from those dependencies.
