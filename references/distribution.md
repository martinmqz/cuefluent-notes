# Package requirements

Each client package contains the v2 runtime, its exact production dependency
closure, license notices, skill references, native manifest, MCP descriptor and
hooks. Node.js 26.12.1 or a newer Node 26 patch is required. Packages do not require
npm, a source checkout or the Cuefluent app to validate generated notes.

Use the package for the intended native client. Verify an archive and inventory
against a trusted supplied checksum before copying it. Inventory consistency alone
does not establish external provenance. An explicit destination copy does not
register a plugin, trust hooks, configure a project or enable tracking.

Use the client's supported plugin flow for registration and hook trust. Keep
existing native login and authentication settings unchanged. Then explicitly set
up the project and notes destination using [setup](setup.md). New installations
track nothing; fresh settings default to manual tracking and review saving.

V2 has no legacy state reader, migration or mixed-version runtime. Existing
Markdown notes remain user content. Use fresh v2 settings and private storage;
do not copy old runtime state into it. Published versions and their checksums
remain immutable; a development package does not replace historical releases.

See [verification](verification.md) before relying on native client or platform
behavior. Repository build, CI and publication procedures are maintained separately
from installed workflows.
