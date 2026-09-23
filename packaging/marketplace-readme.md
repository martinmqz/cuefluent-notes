# Cuefluent Notes marketplace

Capture and organize your knowledge for fast recall—right on cue.

This branch contains complete generated plugins for Codex and Claude Code.
Requires Git, Node.js 22+ on your client's PATH, and a current client CLI.
No npm install or source checkout is needed.

## Codex

```sh
codex plugin marketplace add martinmqz/cuefluent-notes --ref marketplace
codex plugin add cuefluent-notes@cuefluent
```

## Claude Code

```sh
claude plugin marketplace add https://github.com/martinmqz/cuefluent-notes.git#marketplace
claude plugin install cuefluent-notes@cuefluent --scope user
```

Start a fresh session, review/trust hooks in your client, then say **Set up
Cuefluent Notes**. Choose Manual, Suggestions, or Automatic. Capture stays off
until configured; installation preserves existing private settings. Keep notes
outside the installed package. Remove any previous standalone or source-installer
copy before switching installation methods, so only one copy is active.

For packages without hooks, use the client-specific `manual.zip` files on the
[release page](https://github.com/martinmqz/cuefluent-notes/releases).
Both variants use the same plugin identity; choose one per client.

This is a publisher-hosted marketplace, not an OpenAI or Anthropic public-directory
listing. For usage, updates, and source installation, see the
[source repository](https://github.com/martinmqz/cuefluent-notes).
This branch is generated; submit changes against `main`.
