# Cuefluent Notes marketplace

Capture and organize your knowledge for fast recall—right on cue.

This snapshot contains complete generated plugins for Codex and Claude Code.
Its catalogs and packages are also published on the repository's `main` branch.
Requires Git, Node.js 22+ on your client's PATH, and a current client CLI.
No npm install or source checkout is needed.

Existing users: read the
[coordinated upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/setup.md#existing-settings)
before running update or installation commands against shared storage.

## Codex

```sh
codex plugin marketplace add martinmqz/cuefluent-notes --ref main
codex plugin add cuefluent-notes@cuefluent
```

## Claude Code

```sh
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#main
claude plugin install cuefluent-notes@cuefluent --scope user
```

For a **fresh installation or an upgrade from v0.7.1 or earlier**, start a fresh
session, review/trust hooks, then say **Set up Cuefluent Notes**. Choose collection
and processing separately: collection starts off and processing starts Manual.
Only the v0.7.1-or-earlier capture settings are preserved without import.

**Upgrading from v0.9.0–v0.11.0:** keep existing workflow settings, paths and
captures; fresh setup is not required. Update every client plugin/helper sharing
the store to the same version and start fresh sessions afterward.

**Windows storage:** fresh setups use `<local user profile>\.cuefluent-notes`.
Existing settings and paths are preserved; this is not a migration. Existing
package-backed collections may continue while their prepared storage verifies,
but missing roots cannot be recreated and additions needing new roots are frozen.
Private paths under the profile, outside verified non-roaming LocalAppData,
require a local, loaded, non-roaming profile and content indexing protection. Review
[Windows storage selection](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/setup.md#windows-storage-selection)
before changing paths or retrying a refused setup. Do not create a second writer
for the same notes. Fresh setup and the complete Desktop/CLI workflow in a clean
Windows account remain unverified; see the
[verification scope](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/verification.md).

**Upgrading from v0.8.0:** keep the existing workflow settings, paths and
captures; fresh setup is not required. Before updating, stop collection
entrypoints and processing, close affected sessions, and let running workers
finish. Update every client plugin/helper sharing the collection, including both
Codex and Claude when used, before starting fresh sessions or resuming work.
New stored captures and suspension metadata are unreadable by v0.8.0; mixed-version
access and downgrading that collection are unsupported. Updating does not rename
existing raw folders or rerun storage preparation. Follow the
[upgrade guide](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/references/setup.md#existing-settings)
before changing storage visibility or handling a blocked intake lock.

Use explicit processing commands until live current-turn transport is verified.
Keep notes outside the installed package. Remove any previous standalone or
source-installer copy before switching installation methods, so only one copy is
active per client. Review changed hooks after updating.

For packages without hooks, use the client-specific `manual.zip` files on the
[release page](https://github.com/martinmqz/cuefluent-notes/releases).
Both variants use the same plugin identity; choose one per client.

This is a publisher-hosted marketplace, not an OpenAI or Anthropic public-directory
listing. For usage, updates, and source installation, see the
[source repository](https://github.com/martinmqz/cuefluent-notes).
Edit the source and templates on `main`; do not edit generated packages.
If your existing marketplace registration selects the old `marketplace` branch,
follow the [branch migration instructions](https://github.com/martinmqz/cuefluent-notes/blob/v0.12.0/README.md#switch-an-older-marketplace-registration-to-main).
