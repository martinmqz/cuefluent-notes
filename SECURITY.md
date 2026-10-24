# Security policy

## Report a vulnerability

Report vulnerabilities privately: on the repository's **Security** tab, choose
**Report a vulnerability**. Do not open a public issue, pull request, or
discussion for a suspected vulnerability.

Include the affected version or commit, the client (Claude Code or Codex), the
operating system, and reproduction steps that use synthetic data. Never include
real notes, conversation transcripts, credentials, or tokens.

## Scope

In scope:

- the plugin runtime in `src/`, including its hooks and MCP servers
- the package build, verification, and copy tools in `tools/`
- the published packages and marketplace catalogs in this repository
- the CI and release workflows in `.github/workflows/`

Vulnerabilities in Claude Code, Codex, or the Cuefluent app belong with those
projects.

## Fixed versions

Published releases are immutable. A fix ships in a new release; earlier
releases are never modified.
