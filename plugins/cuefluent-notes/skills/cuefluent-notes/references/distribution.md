# Packages and client setup

Codex and Claude Code packages contain the same skill and local runtime, with
host-specific manifests.
The deterministic helpers have no runtime dependency on this source checkout, npm,
Cuefluent, its app packages, or a network service. Node 22 or later must be
available to the client.
The optional [processing chat](processing-chat.md) also needs the matching native
client CLI and its normal authentication to run an agent; model usage belongs to
that client account.

## GitHub-hosted marketplace

Check the [README](../README.md#from-the-marketplace) for current availability.
A source-only checkout has no marketplace catalogs or published packages.
When a release is published, its packages use `main` and the marketplace name
`cuefluent`. Codex reads `.agents/plugins/marketplace.json` and installs
`plugins/cuefluent-notes`; Claude reads `.claude-plugin/marketplace.json` and
installs `claude/cuefluent-notes`. Each package has its own host manifest and
hook definition, plus the complete runtime. Catalog paths are relative to the
marketplace root.

The catalogs select the hook-enabled variant. Installation does not choose
collection or processing permission or notes destinations. Keep only one active copy per client;
remove a previous standalone or source-installer registration before switching.
The catalogs and packages coexist with development source on `main`. The
published package version is recorded in root `release.json` and can lag the
source version during development. Updating the source does not update an
installed plugin; follow the update procedure for its original installation
method. Registrations selecting the former branch need the
[one-time migration](../README.md#switch-an-older-marketplace-registration-to-main).

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
Fresh Windows setups use `<local user profile>\.cuefluent-notes\workflow.json`;
see [Windows storage selection](setup.md#windows-storage-selection) for existing
stores and explicit overrides. macOS/Linux settings default to
`~/.config/cuefluent-notes/workflow.json`. Raw evidence
and managed state must be private and machine-local. Setup verifies ownership and
permissions and only applies private permissions to newly created managed roots;
it never repairs an existing directory's ACL. Node chmod alone is insufficient
on Windows. See [private storage](session-workflow.md#private-storage-and-explicit-pruning).
Use full drive paths such as `C:\Users\Ada\Documents\Notes` or an explicit
UNC share; drive-relative paths such as `C:Notes`, device namespaces, reserved
device filenames, alternate streams, and trailing-dot/space aliases are refused.
Windows private settings and state require a local NTFS or ReFS volume; finished
notes can use separately selected document locations. ReFS storage behavior,
including first-use hard-link support and durability, remains unverified.
Network-share durability and cloud-sync behavior are not guaranteed. First-use
setup requires hard-link support.

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
when switching variants. Existing files are preserved; old capture settings are not imported or activated.
Both clients can use the same new workflow settings with explicit client/project routes.

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

The installer supports native Windows, macOS, and Linux. See
[product limits](verification.md) for product and client integration limits.

## Package layout

Each client package contains:

```text
cuefluent-notes/               # Codex package root
  .codex-plugin/plugin.json
  .mcp.json
  README.md
  LICENSE.md
  package-inventory.json       # exact files, sizes and SHA-256 digests
  skills/cuefluent-notes/
    SKILL.md
    README.md
    LICENSE.md
    references/
    examples/
    scripts/
    package.json
    package-lock.json
    node_modules/
  hooks/hooks.json             # hook variant only
cuefluent-notes/               # Claude package root
  .claude-plugin/plugin.json
  .mcp.json
  README.md
  LICENSE.md
  package-inventory.json
  skills/cuefluent-notes/      # same complete skill and runtime
  hooks/hooks.json             # hook variant only
```

The package includes the [project license](../LICENSE.md), the runtime dependency
closure and its separate license notices.
The README lives inside the packaged skill so its relative reference links
remain usable.

## Verify a selected package

Packages built with version 0.11.0 or later include an inventory of their exact
files. From the source checkout or the packaged skill directory, explicitly select
the whole plugin root (the directory containing its client manifest):

```sh
node scripts/package-integrity.mjs /absolute/path/to/cuefluent-notes
```

The check is read-only. It reports missing, changed and unexpected files, checks
the client/version/variant identity, and reads only the selected package. It does
not read notes, capture settings, session evidence or client credentials, fetch
anything, repair files, install a plugin or change hook trust. Use a known-good
copy of the checker when investigating a potentially modified installation.

`integrityVerified: true` means the files match their included inventory; it does
not prove where that inventory came from. For release verification, obtain the
matching archive entry's `inventorySha256` from a **separately trusted**
`release.json` in the reviewed marketplace snapshot or published package commit:

```sh
node scripts/package-integrity.mjs /absolute/path/to/cuefluent-notes \
  --expected-inventory-sha256 TRUSTED_64_CHARACTER_SHA256
```

Select the entry matching the version, client and `hooks`/`manual` variant.
`trustedReleaseVerified` is true only when the files pass integrity checks and
the inventory matches that supplied digest. Copying a digest from the same
untrusted installation does not establish release identity. Exit codes are 0
for successful requested verification, 1 for mismatches, and 2 for unsupported
or unsafe inputs. Existing packages without inventories remain verifiable through
their original release ZIP digests; do not add a new inventory to a published version.

Verification rejects symlinks (including the selected root), special files,
unsafe paths and detected changes during inspection. Bounds are 4,096 packaged
files, 8,192 total entries, 20 path components, 16 MiB per file, 128 MiB total and
2 MiB for the inventory. Each mismatch list displays at most 100 paths; counts
include all mismatches. Ordinary `.DS_Store`, `Thumbs.db`, `desktop.ini` files up
to 16 MiB and root `.in_use/<positive-decimal-PID>` markers up to 4 KiB are reported
as ignored host files. `ignoredCount` includes all ignored files and `ignored`
lists at most 100 paths. Links and special files under those names still
fail verification. Other files remain unexpected. An actively changing package
can fail inspection; retry after the client finishes its update.

Package verification does not prove client loading, hook trust, current-turn
transport or note retrieval behavior. The lightweight `workflow.mjs status`
diagnostics retain their existing scope; full verification runs only when requested.

Choose one variant for each client. Both variants have the identity
`cuefluent-notes`; do not install both or register the same adapter manually as
well as through the plugin. Manual packages contain no hook registration. Hook
packages register SessionStart, UserPromptSubmit, Stop, SessionEnd, and Codex
Interrupt or Claude StopFailure. No startup-only matcher or SubagentStop is used.
Hooks do nothing in unconfigured or entirely disabled projects. Trust is separate
from collection consent; processing requires explicit selection until the live
transport gate passes. See [hooks](hooks.md).

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

Validate an extracted Claude package without starting an agent session:

```sh
claude plugin validate --strict --json /absolute/extracted/cuefluent-notes
```

For explicitly requested temporary use, `--plugin-dir` loads the
package for that session rather than installing it permanently:

```sh
claude --plugin-dir /absolute/extracted/cuefluent-notes
```

The plugin skill name is `/cuefluent-notes:cuefluent-notes`; ordinary requests
can also select it by purpose. Claude documents local loading and plugin skill
namespacing in [Create plugins](https://code.claude.com/docs/en/plugins#test-your-plugins-locally).

For persistent personal use, place the complete chosen Claude plugin at
`~/.claude/skills/cuefluent-notes`, including its `.claude-plugin/plugin.json` and
nested skill/runtime. It loads as `cuefluent-notes@skills-dir` in the next session
without a marketplace. Extracting the package elsewhere does not place it in that
skills directory.
See [Skills-directory plugins](https://code.claude.com/docs/en/plugins-reference#skills-directory-plugins).

Review the exact hook command and workspace trust when opting into hooks.
After plugin changes, use `/reload-plugins` or restart as supported by the
installed version, and verify existing sessions as well as fresh ones. The
private capture policy remains outside the plugin directory.

## Codex persistent setup

For normal installation, use the [README quickstart](../README.md#install-in-codex-or-claude-code).
The commands below are for fitting an extracted Codex package into another
existing catalog.

Persistent setup uses a marketplace selected by the user. Copying or extracting
a package does not register it, create a personal marketplace or change a catalog.
Complete the selected client's registration before expecting it to load.

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

For a Codex CLI that provides the documented `plugin` commands, register with:

```sh
codex plugin marketplace add /absolute/selected-marketplace-root
codex plugin add cuefluent-notes@selected-local-catalog
```

The desktop plugin UI is another documented installation path. See
[verification scope](verification.md) for client integration limits. Restart or
begin a fresh session after installation and verify the skill is available. For
the hook variant, review and trust its current definition through `/hooks`;
enabling a plugin does not itself establish hook trust. Follow the
[Codex hooks reference](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## Opt in, update, or disable

Start a fresh task and say **“Set up Cuefluent Notes.”** The [setup flow](setup.md)
saves reviewed settings with collection disabled and processing Manual, prepares
private storage, then activates only separately authorized choices. It does not
write notes or import v0.7.1 settings. Use [explicit controls](workflow-cli.md)
for one-time capture, pause/exclude, pending discovery and note processing.

A route's `collection.enabled: false` stops ongoing collection. Processing mode
is independent; `excluded: true` denies the route. Removing hook registration
or switching to the manual variant also removes background collection ingress.
Direct user-selected saves remain available with a chosen destination/writer.
Never save real settings or evidence inside the plugin or public repository.

If you installed from a release ZIP, extract the new release's package into a
fresh directory and review the package and changes. This applies to both
hook-enabled and manual variants. Update the one installed variant through that
client's supported process; other installation methods keep their own update
procedures.
Keep user notes, private policy, and update state outside the replaceable package.
Changed Codex hook definitions need renewed trust; validate reload behavior for
each host rather than assuming both update the same way. Both variants also
register the `cuefluent_control` MCP server through `.mcp.json`; review its
registration and permissions on update. The client may start that server when
loading the plugin. Only an explicit processing request launches or resumes the
restricted agent session. Follow the [coordinated upgrade](setup.md#existing-settings)
and [processing chat](processing-chat.md) guidance before resuming shared storage.

## Compatibility limits

The replacement has its own workflow configuration and no legacy migration or
mixed-version support. Keep unfinished old journals with the v0.7.1 reference
helper; this implementation does not adopt old policy, completion markers or
session state. Existing user Markdown remains ordinary, reusable source material.
By-type writes preserve inspected directory identities and the collection's one
writer state. Version-1 plans handle existing/custom parents and derived outputs;
version-2 authored plans can create inspected immediate type folders. See
[safe updates](refresh.md).

Node 22+ is required. The fixed Codex shell bootstrap reads the plugin root as
environment data; Claude uses direct executable/argument invocation. See
[product limits](verification.md) for product and client integration limits.

`workflow.mjs status` reports packaged hook integrity, the current Node version,
and the unverified transport. Host hook trust, restrictions/feature flags and
desktop Node PATH remain unknown; inspect the client's hook controls and launch
configuration. A packaged handler does not prove it is loaded or trusted. Live
current-turn binding, native prompts, already-open session reload and Cuefluent
recursive discovery/ranking remain unverified.

The plugin uses the [Sustainable Use License 1.0](../LICENSE.md).
See the [licensing summary](../README.md#license) for permitted use and the scope
of the license. Included third-party dependencies retain their own licenses.
