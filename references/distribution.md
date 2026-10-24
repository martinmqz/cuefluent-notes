# Package requirements

Each client package contains the runtime, its exact production dependency
closure, license notices, skill references, native manifest, MCP descriptor and
hooks. Node.js 26.12.1 or a newer Node 26 patch is required. Packages do not require
npm, a source checkout or the Cuefluent app to validate generated notes.

## Startup troubleshooting

The connector and hooks launch `node` from the native client's environment.
Installing a supported Node version does not guarantee the desktop client selects
it. Check the executable and version actually used by that client, then restart
the client after correcting its launch configuration. A connector-only override
does not change the Node executable used by hooks.

The CLI checks the Node version before loading its storage and processing runtime.
An unsupported runtime reports `NODE_VERSION_UNSUPPORTED`, the required range,
the detected version and executable, and a recovery step. Missing runtime modules
report reinstall guidance instead of an exception stack. CLI and MCP startup
diagnostics go to stderr; hook failures use the native `systemMessage` response
and do not deliberately fail the user's prompt.

If the host cannot start an executable or enter the configured working directory,
Cuefluent has not started and cannot produce its own diagnostic. A host error such
as `No such file or directory` does not identify the missing path by itself.
Check the configured executable, installed plugin path, and working directory in
the client's connector settings or startup log. Do not assume reinstalling the
skill or repeating a note request will repair the connection.

Runtime diagnostics do not install Node, alter client configuration, or select a
different executable automatically. A manually pinned package path must be kept
current when upgrading. Client presentation of stderr and hook messages varies;
the diagnostic text is not a guarantee of a desktop notification.

## Installation and settings

Use the package for the intended native client. Verify an archive and inventory
against a trusted supplied checksum before copying it. Inventory consistency alone
does not establish external provenance. An explicit destination copy does not
register a plugin, trust hooks, configure a project or enable tracking.

Use the client's supported plugin flow for registration and hook trust. Keep
existing native login and authentication settings unchanged. Then explicitly set
up the project and notes destination using [setup](setup.md). New installations
track nothing; fresh settings default to manual tracking and review saving.

Cuefluent Notes 0.16.0 and later do not read or migrate runtime state from 0.15.1
or earlier or support mixing runtimes from those versions. Existing Markdown notes
remain user content. Use fresh settings and private storage; do not copy old
runtime state into it. Published versions and their checksums remain immutable;
a development package does not replace historical releases.

See [verification](verification.md) before relying on native client or platform
behavior. Repository build, CI and publication procedures are maintained separately
from installed workflows.
