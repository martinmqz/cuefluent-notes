# Packaging and client setup

The builder creates standalone directories for Codex and Claude Code.
Both contain the same skill and local runtime, with host-specific manifests.
The packaged helpers have no runtime dependency on this source checkout, npm,
Cuefluent, its app packages, or a network service. Node 22 or later must be
available to the client.

## GitHub-hosted marketplace

The [README marketplace commands](../README.md#from-the-marketplace) install
released packages from the `marketplace` branch under the marketplace name
`cuefluent`. Codex reads `.agents/plugins/marketplace.json` and installs
`plugins/cuefluent-notes`; Claude reads `.claude-plugin/marketplace.json` and
installs `claude/cuefluent-notes`. Each package has its own host manifest and
hook definition, plus the complete runtime. Catalog paths are relative to the
marketplace root.

The catalogs select the hook-enabled variant. Installation does not choose
capture mode or notes destinations. Keep only one active copy per client;
remove a previous standalone or source-installer registration before switching.
If the `marketplace` branch is absent, the first release has not completed;
use the guided installer or follow the [publisher guide](publishing.md).

Release assets also provide separate manual ZIPs without hook registration.
Extract one and use the client-specific local installation instructions below;
the extracted package root is `cuefluent-notes/`. The `marketplace.tar.gz` asset
is a complete catalog snapshot for publication/recovery, not an individual plugin
upload. `SHA256SUMS` covers all five archives.

The source installer and marketplace installation are distinct ownership paths.
Update each through its original method. A marketplace uninstall does not imply
deleting private capture configuration or notes. For installed source copies,
move only the installed skill/package and remove its old host registration;
do not delete a whole shared skills directory or marketplace.

Official contracts: [Codex marketplace commands](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace),
[Codex catalog paths](https://learn.chatgpt.com/docs/enterprise/plugin-management#supported-formats),
and [Claude marketplace installation](https://code.claude.com/docs/en/discover-plugins#add-marketplaces).

## Guided installer

Native Windows uses the same packages and commands as macOS/Linux. In PowerShell,
use `npm.cmd` if script execution policy blocks `npm.ps1`; do not relax global
execution policy to install this plugin. `--cli "C:\Program Files\client\codex.exe"`
selects a native executable; npm-style `.cmd`/`.bat` shims and explicit Node
scripts also work. WSL, administrator access, and developer-mode symlink
privileges are not prerequisites for ordinary installation or capture.

`~` in this guide means the current user's home (`%USERPROFILE%` on Windows).
The default private policy remains `.config/cuefluent-notes/config.json` under
that home on every platform, preserving existing configuration. Keep private
configuration, state, and notes in directories whose Windows ACL permits only
the intended readers: Node's `chmod(0600)` does not establish a private ACL.
Use full drive paths such as `C:\Users\Ada\Documents\Notes` or an explicit
UNC share; drive-relative paths such as `C:Notes`, device namespaces, reserved
device filenames, alternate streams, and trailing-dot/space aliases are refused.
Native CI verifies local NTFS; network-share durability and cloud-sync behavior
have not been verified. First-use setup requires hard-link support.

The [README quickstart](../README.md#install-in-codex-or-claude-code) uses
`npm run install:codex` or `npm run install:claude` from a Git clone. These
source-only commands install locked dependencies with lifecycle scripts disabled,
build only the selected client's hook variant, and install for the current user. Installation neither
reads nor writes capture settings, notes, or hook trust.

| Client | Installed package | Registration |
| --- | --- | --- |
| Codex | `~/plugins/cuefluent-notes` | Adds an entry to `~/.agents/plugins/marketplace.json`, preserving its name, metadata, and other plugins; runs `codex plugin add cuefluent-notes@<catalog-name>` |
| Claude Code | `~/.claude/skills/cuefluent-notes` | Loads as `cuefluent-notes@skills-dir` in a fresh session; no marketplace needed |

Claude's `CLAUDE_CONFIG_DIR`, when set to an absolute path, replaces `~/.claude`.
The installer validates its package with the Claude CLI before placing it. Use a
current version with [skills-directory plugin support](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins).
Codex's default personal marketplace is discovered automatically; no separate
`marketplace add` command is needed for this location. See
[Codex plugin commands](https://learn.chatgpt.com/docs/developer-commands#codex-plugin).
Before installing, Codex also checks for a standalone skill in `~/.agents/skills`
and the active `CODEX_HOME/skills` (default `~/.codex/skills`) to prevent duplicate
copies. Empty client-home overrides use the defaults. A nonempty configured
client home must be an absolute path. Selected home/configuration paths and
client-reported installed paths resolve OS and dotfiles aliases before comparison.

Use `npm run install:codex -- --manual` or `npm run install:claude -- --manual`
to omit hooks. Repeating either installer replaces its own package, including
when switching variants. Existing capture settings keep their values. Both
clients share the default private capture policy; setup can select which clients
and projects participate.

Previous packages are retained under `~/plugins/.cuefluent-installer/` for Codex,
or `~/.claude/.cuefluent-installer/` for Claude (respecting `CLAUDE_CONFIG_DIR`).
The installer prints the exact backup path. Backups stay outside Claude's skills
directory so they cannot become duplicate active plugins. Keep a backup until
you have checked the update; then it may be removed. Installed packages contain
all runtime dependencies, so deleting the source checkout does not break them.
Clone again when you next need to update.

### Troubleshooting the installer

- **Missing or outdated CLI:** install/update the selected client first. Pass
  `-- --cli /absolute/path/to/codex` (or `claude`) to choose a specific executable.
  A relative executable path containing `/` resolves once from the installer's
  working directory, so every client command uses the same binary.
  Node 22+ must also be on the client application's PATH for hooks to run.
- **Already installed another way:** the installer refuses an unmanaged target,
  conflicting marketplace entry, another installed plugin identity, or a plain
  skill with the same name. Update through the original method, or remove that
  registration and move its package aside before using this installer. Do not
  keep two active copies.
- **Linked or invalid installation paths:** aliases in selected client-home
  paths (including macOS `/tmp`) are supported. Linked package destinations,
  linked directories beneath the selected home, and linked, malformed, or
  ambiguous marketplace files are refused.
- **Download, build, or validation failure:** the active package has not been
  replaced. Fix the reported problem and repeat the command.
- **Codex registration failure:** the prepared package and catalog entry remain
  available. Fix the CLI error and repeat the installer; it will retry registration.
- **Replacement and rollback both fail:** the original replacement error is
  preserved and a separate message identifies the retained previous package.
  Inspect that backup and the destination before restoring or retrying.
- **Cleanup warning:** the installation result or original failure is preserved,
  and the warning identifies the exact leftover path. Inspect that path before
  retrying. Keep previous-package backups, and remove a leftover lock only after
  confirming no installer is running.
- **Interrupted installation:** a lock may remain in `dist/.install-lock` or the
  client's `.cuefluent-installer/lock`. Its `owner.json` records the installer's
  PID, hostname, start time, and ownership token. Confirm that process has stopped
  on the recorded host, then remove its owner file and empty lock directory.
  Missing/incomplete metadata also requires checking for a running installer;
  locks are never automatically stolen. If an interruption
  happened during replacement, the previous package remains under the printed
  workspace location's `install-*/previous` directory.
- **Skill still missing:** use a fresh session or restart the client. For Claude,
  update to a version that discovers full plugins in its skills directory; a
  plain copied `SKILL.md` does not include the bundled runtime or hooks.

The installer supports native Windows, macOS, and Linux. The automated installer
checks use disposable user and checkout-lock directories and stub client commands; they verify package
contents, settings preservation, conflicts, retries, and updates. Actual host
loading is covered separately in [verification results](verification.md).

## Build and inspect

In the source repository, install the locked build dependencies and run checks:

```sh
npm ci --ignore-scripts
npm test
npm run check:examples
npm run package
```

`npm run package` creates the manual variant under `dist/manual`. To include the
opt-in hook registration, use:

```sh
npm run package -- --hooks
```

That writes `dist/hooks`. For a repeat build, choose a fresh directory:

```sh
npm run package -- --hooks --out /absolute/fresh-package-output
```

The package builder refuses an existing output directory. It creates directories, not
an archive, marketplace registration, published package, or installed plugin.
Do not remove a previous build merely to reuse its name when a fresh destination
will suffice.

Each output contains:

```text
codex/cuefluent-notes/
  .codex-plugin/plugin.json
  skills/cuefluent-notes/
    SKILL.md
    README.md
    references/
    examples/
    scripts/
    package.json
    package-lock.json
    node_modules/
  hooks/hooks.json             # hook variant only
claude/cuefluent-notes/
  .claude-plugin/plugin.json
  skills/cuefluent-notes/       # same complete skill and runtime
  hooks/hooks.json             # hook variant only
```

The package includes the runtime dependency closure and its license notices.
Tests and the package builder are source-development tools; use the source
checkout to change or test the implementation. The source README lives inside
the packaged skill so its relative reference links remain usable.

Choose one variant for each client. Both variants have the identity
`cuefluent-notes`; do not install both or register the same adapter manually as
well as through the plugin. Manual packages contain no hook registration. Hook
packages add `SessionStart` matched on `startup`, `UserPromptSubmit`, and `Stop`.
The [Stop check](completion.md) is inactive unless separately enabled in the private
policy; it allows one recovery attempt for a missed capture decision. Missing private capture configuration produces
one host notice at startup without enabling capture or adding model context;
unconfigured prompts and Stop events stay quiet. A saved manual preference leaves
all hooks quiet. The Stop registration changes the hook definition; review and
trust the updated hooks through the host before relying on the check.

## Use a packaged helper without host installation

Run from the skill directory inside either package:

```sh
cd /absolute/package/skills/cuefluent-notes
node scripts/check-notes.mjs /absolute/private-notes/project.md
node scripts/safe-update.mjs fingerprint /absolute/private-notes/project.md
```

No `npm install` is needed there. The [manual workflow](workflow.md) can also be
read directly by an agent. Follow [refresh.md](refresh.md) for reviewed write
plans and ownership; packaging is not permission to capture unrelated data or
write into an unspecified destination.

## Claude Code loading and persistent setup

Validate a built Claude package without starting an agent session:

```sh
claude plugin validate --strict --json /absolute/output/claude/cuefluent-notes
```

For an explicitly authorized temporary host test, `--plugin-dir` loads the
package for that session rather than installing it permanently:

```sh
claude --plugin-dir /absolute/output/claude/cuefluent-notes
```

The plugin skill name is `/cuefluent-notes:cuefluent-notes`; ordinary requests
can also select it by purpose. Claude documents local loading and plugin skill
namespacing in [Create plugins](https://code.claude.com/docs/en/plugins#test-your-plugins-locally).

For persistent personal use, place the complete chosen Claude plugin at
`~/.claude/skills/cuefluent-notes`, including its `.claude-plugin/plugin.json` and
nested skill/runtime. It loads as `cuefluent-notes@skills-dir` in the next session
without a marketplace. This is a user-level installation and is not performed
by the builder. See [Skills-directory plugins](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins).

Review the exact hook command and workspace trust when opting into hooks.
After plugin changes, use `/reload-plugins` or restart as supported by the
installed version, and verify existing sessions as well as fresh ones. The
private capture policy remains outside the plugin directory.

## Codex persistent setup

For normal installation, use the [README quickstart](../README.md#install-in-codex-or-claude-code).
The commands below are for fitting a separately built package into another
existing catalog.

The reviewed Codex `0.146.0` CLI does not provide a `--plugin-dir` or plugin
validation command. Do not treat a folder build as a live Codex load test.
Persistent setup uses a marketplace selected by the user; the builder does not
create a personal marketplace or change a catalog.

For an authorized local marketplace, place the chosen Codex package at
`<marketplace-root>/plugins/cuefluent-notes` and add the following entry to that
marketplace's `.agents/plugins/marketplace.json`, preserving existing entries:

```json
{
  "name": "selected-local-catalog",
  "plugins": [
    {
      "name": "cuefluent-notes",
      "source": {
        "source": "local",
        "path": "./plugins/cuefluent-notes"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

The path is relative to the marketplace root. `selected-local-catalog` is an
example name; use the user's actual catalog identity. Official documentation
describes [local marketplaces and registration](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).

The reviewed CLI exposes these persistent setup commands:

```sh
codex plugin marketplace add /absolute/selected-marketplace-root
codex plugin add cuefluent-notes@selected-local-catalog
```

These commands were exercised with a disposable local marketplace in the
[live CLI smoke test](verification.md). The desktop plugin UI is another
documented installation path. Restart or begin a fresh session
after installation and verify the skill is available. For the hook variant,
review and trust its current definition through `/hooks`; enabling a plugin does
not itself establish hook trust. Follow the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Opt in, update, or disable

After installing, start a fresh task and say **“Set up Cuefluent Notes.”** The
bundled [Setup flow](setup.md) reads current status, asks for missing choices, and
saves the selected first-use policy. Manual use needs no notes destination;
Suggestions and Automatic require a project, destination, and capture scope.
First-use initialization preserves existing settings; guarded updates replace
only an inspected, approved policy. Neither operation writes notes.

Host installation and trust are separate from implementation authorization.
After choosing the hook variant, select private policy and note/state locations
using [hooks.md](hooks.md). The synthetic config starts with `enabled: false` and
`automaticUpdates: false`. Enable only the desired clients and routes after
reviewing their concrete scope. The Setup flow handles this first-use configuration
without asking the user to edit JSON. Do not save real policy in the installed plugin
or public repository.

Setting the private policy's `enabled` to `false` disables capture; removing a
client from `clients` disables that adapter. A route can be disabled, and an
exclusion overrides eligible routes. These choices leave the manual workflow
available. Removing the host registration or switching to the manual variant
also removes hook assistance; review the host's current update/removal process
before modifying its configuration.

For upgrades, rebuild into a fresh directory, review the package and changes,
then update the one installed variant through that client's supported process.
Keep user notes, private policy, and update state outside the replaceable package.
Changed Codex hook definitions need renewed trust; validate reload behavior for
each host rather than assuming both update the same way.

## Compatibility and verification status

New folder setups default to by-type placement using schema 4 and require every
installed reader of that shared configuration to support 0.7.0+. Setup requires an explicit caller
compatibility assertion after checking those installations; it does not discover
them automatically. Explicit flat folder setup uses schema 2 (0.5.1+) or schema
3 with completion checks (0.6.0+); it still requires the applicable compatibility
assertion. Existing schemas and explicit files remain supported, and
updating a package does not activate categories or move notes. Follow
[setup](setup.md) to change organization while preserving consent and shared state.
Directory-bound authored writes use journal version 2, which requires 0.7.0+
for recovery or abort; older writers refuse it. Preserve pending journals during
upgrades and resolve them with a compatible helper. See [safe updates](refresh.md).
This also applies to root-only v2 plans under older capture schemas or manual use:
the writer requires its own `confirmCompatibleReaders: true` assertion. Retain v1
for mixed-version collections until every installed reader supports 0.7.0+.

The declared Node baseline is `>=22`; development and isolated helper checks
run locally on macOS with Node `26.2.0`. CI checks native Windows, Linux, and
macOS with Node 22 and compares release checksums across all three. Bundled
hooks use a fixed Node bootstrap that reads the client-exported plugin root
inside Node, so path contents never become shell source. Native Windows tests
exercise Command Prompt, Windows PowerShell, PowerShell 7, and Git Bash. Live model
hooks on Windows and Linux remain unverified. Reviewed host contracts are Codex
`0.146.0` and Claude Code `2.1.278`; see [hooks.md](hooks.md) for native identity
requirements and the Claude `prompt_id` version boundary.

Standalone verification checks packaged dependency resolution, synthetic note
checking and vocabulary, safe update/no-op behavior, conflicts and recovery,
and adapter policy/routing without a Cuefluent app checkout. Semantic review
checks source fidelity, useful-change decisions, manual-save duplication, and
opt-out behavior on synthetic examples. These checks do not certify that an
agent will always make the right capture decision.

Authorized [live CLI smoke tests](verification.md) exercised temporary host setup
and synthetic capture. The results distinguish those checks from the reviewed
host contracts above. Already-open session reload, desktop capture, real-user
usefulness, and actual Cuefluent admission, rendering, image loading, and ranking
remain unverified. Check the
[releases page](https://github.com/martinmqz/cuefluent-notes/releases) for publication status.
The [type-folder checks](verification.md#note-type-folders-070) establish helper
and package behavior, not model classification, native Save / Skip rendering,
or a Cuefluent ingestion path. App loading is separate from the user's chosen
note layout; do not infer recursive discovery from directory support or require
a live app test before honoring a type-folder request.

The project has no assigned source license. Included third-party dependencies
keep their own license notices; no project license is implied by those notices.
