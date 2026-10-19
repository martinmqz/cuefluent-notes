# Cuefluent Notes marketplace

Capture and organize your knowledge for fast recall—right on cue.

This snapshot contains complete generated plugins for Codex and Claude Code.
Its catalogs and packages become available on the repository's `main` branch
when the package-update PR merges. The snapshot's `release.json` identifies its
version. Requires Git, Node.js 22+ on your client's PATH, and a current client CLI.
No npm install or source checkout is needed.

Cuefluent Notes is source-available under the
[Sustainable Use License 1.0](plugins/cuefluent-notes/LICENSE.md).
See the [licensing summary](plugins/cuefluent-notes/skills/cuefluent-notes/README.md#license)
for permitted use, licensing inquiries, and how the license applies to your notes
and bundled dependencies.

## Installation

Once the catalogs are published on `main`, use the commands for your client.

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

For a **fresh installation or a setup with only legacy capture settings**, start
a fresh session, review hooks and the bundled `cuefluent_control` MCP server
registration and permissions, then say **Set up Cuefluent Notes**. Choose
collection and processing separately: collection starts off and processing
starts Manual. Legacy settings are preserved without import. Use the
[settings inspection guidance](plugins/cuefluent-notes/skills/cuefluent-notes/references/setup.md#existing-settings)
to distinguish them from a recognized workflow configuration; a failed status
check is not a reason to start over.

## Updating

For recognized `cuefluent-workflow` settings with collections and routes,
preserve settings, paths, captures and active operations. Do not rerun setup
unless the selected release requires it. Before replacing packages, stop
collection entrypoints and processing, close affected sessions, and let workers
and processing clients finish. Update every client plugin/helper sharing the
store to the same released version before resuming. Check the release notes for
storage compatibility and downgrade boundaries; a patch does not necessarily
change stored formats. Follow the
[coordinated upgrade guide](plugins/cuefluent-notes/skills/cuefluent-notes/references/setup.md#existing-settings)
and [marketplace update commands](plugins/cuefluent-notes/skills/cuefluent-notes/README.md#update-a-marketplace-installation).

Review hook or MCP registration and permission changes when prompted. Both hook and
manual packages contain `.mcp.json`, which registers `cuefluent_control`; the
client may start it when loading the plugin. An explicit processing request uses
its native CLI authentication and model resolution. Processing-enabled routes may
register source metadata even with collection off; the explicit handoff can
inspect bounded source content to verify the native call. See
[processing chat prerequisites and privacy](plugins/cuefluent-notes/skills/cuefluent-notes/references/processing-chat.md).

Existing Windows package stores are preserved, with additions needing missing
roots frozen pending separate migration. Do not create a second writer or move
paths to bypass a refusal; follow
[Windows storage selection](plugins/cuefluent-notes/skills/cuefluent-notes/references/setup.md#windows-storage-selection).

## Processing

Prefer the reusable processing chat: type `$cuefluent-notes process` in Codex
(type `$` and pick cuefluent-notes from the list) or `/cuefluent-notes process`
in Claude. Invoke the same skill with `review` to
write the exact proposal to a private review folder, then type `save <code>` or
`skip <code>` to decide; `help` lists every action.
This remains an explicit request in every mode, including Automatic.
The restricted session disables inherited collection hooks; formal controls use
verified native identities. Mixed work and corrections remain eligible evidence.
If the native tool or binding is unavailable, leave the work pending and report
the limitation; without a review form, review through the folder and typed
decisions. Standalone agents can use the explicit CLI workflow from
an uncaptured context; do not silently process inline in a captured work chat.
See [processing and recovery](plugins/cuefluent-notes/skills/cuefluent-notes/references/processing-chat.md)
and [verification limits](plugins/cuefluent-notes/skills/cuefluent-notes/references/verification.md).

Keep notes outside the installed package. Remove any previous standalone or
source-installer copy before switching installation methods, so only one copy is
active per client. For packages without hooks, use the client-specific `manual.zip`
files on the [release page](https://github.com/martinmqz/cuefluent-notes/releases).
Both variants use the same plugin identity; choose one per client.

This is a publisher-hosted marketplace, not an OpenAI or Anthropic public-directory
listing. Edit source and templates on `main`, not generated packages. If your
existing marketplace registration selects the old `marketplace` branch, follow the
[branch migration instructions](plugins/cuefluent-notes/skills/cuefluent-notes/README.md#switch-an-older-marketplace-registration-to-main)
once the replacement catalogs are available.
