---
description: V2 dependencies, self-contained distribution, and immutable releases
activation: path
paths:
  - package*.json
  - .node-version
  - tools/**
  - packaging/**
  - .github/workflows/**
  - .agents/plugins/**
  - .claude-plugin/**
  - plugins/**
  - claude/**
  - release.json
  - README.md
  - LICENSE.md
  - .gitignore
  - .gitattributes
  - references/distribution.md
  - references/verification.md
  - .agents/publishing.md
---
# Distribution and releases

Apply [repository guidance](/AGENTS.md). Build v2 distribution from fresh source
and an explicit shipped-file inventory, without the former runtime, legacy
configuration, tests, development tools, repository guidance, or private planning.
Both client packages include their runtime dependency closure and license notices.
Pin current dependency versions and build from the lockfile.

Keep the source package version separate from the published version in
`release.json`. Published files under `plugins/` and `claude/`, their checksums,
tags, and release history are immutable. Updating source or building a candidate
does not authorize replacing them or installing/trusting a plugin.

Builders use a fresh output directory and refuse to overwrite existing artifacts.
Verify detached packages, inventory contents, dependency closure, and archives.
An inventory proves internal consistency, not external provenance. Release
authenticity depends on trusted checksums and an authorized publication.

Target supported current Node versions on Windows, macOS, and Linux in CI. Keep
permissions narrow, actions pinned, guidance checks separate, and third-party
client downloads separate from artifact production. Passing deterministic tests
and packages does not prove live desktop commands, hook activation, or app search.

Use synthetic disposable profiles for client checks unless the user explicitly
authorizes existing login use. Never read/copy credentials into fixtures or change
authentication, installed plugins, capture settings, or trust implicitly.
