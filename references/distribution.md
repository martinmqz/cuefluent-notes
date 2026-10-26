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

On Node 18 and later, the CLI entry script checks the Node version before loading
its storage and processing runtime. An unsupported runtime reports
`NODE_VERSION_UNSUPPORTED`, the required range, the detected version and executable,
and a recovery step. Earlier Node versions may fail in the native parser or loader
before this diagnostic can run. Missing runtime modules report reinstall guidance;
if the diagnostic module itself cannot load, the self-contained bootstrap reports
`CUEFLUENT_BOOTSTRAP_FAILED`. CLI and MCP startup
diagnostics go to stderr; hook failures use the native `systemMessage` response
and do not deliberately fail the user's prompt. An unavailable diagnostic pipe
does not interrupt an operation's completion or resource cleanup.

`ENTRY_STORE_ROOT_INVALID` identifies a malformed `CUEFLUENT_HOME` override.
Use the intended normalized absolute private-store path; preserve existing work
and do not select a different store merely to bypass an error. Diagnostics name
the variable without exposing its value. Loaded package versions are included
in later failures, but a version is not guessed when package validation fails.

`STORE_SCHEMA_UNSUPPORTED` refuses an unsupported private-state contract before use;
preserve that store and set up at a fresh [private location](setup.md#private-location).
`STORE_ROOT_OCCUPIED` means setup found foreign entries, and
`STORE_INCOMPLETE` means incomplete or changed initialization state needs inspection.
Neither authorizes deleting retained work or recreating settings around it.
`STORE_SETUP_BUSY` reports interference while opening the setup directory; wait
briefly and retry the same setup at the same location. Unrelated sibling activity
after directory acquisition does not invalidate setup.

The hook's Windows ACL budget includes child process startup, imports and
preflight, with a reserved margin for wrapper overhead and the reply. It cannot
guarantee a reply before a host deadline under arbitrary scheduling delays or
wrapper startup time outside the child process.

If the host cannot start an executable, load the entry script, or enter the configured working directory,
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

The connector, hooks and workers of one installation use the same package and
the same private store; restart the client after changing either. Markdown notes
remain user content and are preserved independently of private runtime state.
Published releases and their checksums remain immutable; a development package
does not replace them.

See [verification](verification.md) before relying on native client or platform
behavior. Repository build, CI and publication procedures are maintained separately
from installed workflows.
