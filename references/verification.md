# Compatibility and limitations

## Native clients

The current adapters target Claude Code 2.1.307 and Codex CLI 0.163.0 native
contracts. Claude uses direct plugin command expansion plus an exact native
attachment nonce for copied-history command boundaries. Codex uses native MCP turn
metadata, the selected skill item, exact thread source metadata and current-turn
checks. Different session/thread identity shapes remain unsupported until verified.
No newest-file, working-directory or model-supplied identity fallback exists.

A Stop hook may precede final transcript persistence. Durable retries and idle
reconciliation handle delayed rows and supplementary output. Unsupported hook
shapes do not imply completed or interrupted conversation. Automatic enrollment of
a Claude fork with an unknown inherited prefix remains pending; the current file's
size or current command nonce cannot establish that inherited boundary. Codex uses
verified native history cutoffs and reports missing historical sources.

Native CLI checks do not establish desktop or TUI rendering, every lifecycle
variant, search ranking, or watcher behavior on another operating system.

## Processing and platform support

macOS native checks cover GPT-6.1 and Claude Opus draft-only sessions and a complete
private-draft → review → save flow. Native processing verifies an effective floor
before providing source input: no inherited instructions/hooks/plugins, no general
shell or network access, and only the explicit draft workspace MCP capability.
If that floor cannot be verified, processing fails without releasing source input.

Windows native checks cover Claude Opus and explicitly selected Codex GPT-6 Luna
processing through private draft, review, exact-byte save and cleanup. GPT-6.1
remains the default Codex processing model; an explicit supported model selection
can accommodate host availability. Codex on Windows requires its explicit MXC
sandbox, a compatible Windows host, and access to the requested model; the native
filesystem and network floor is checked before source delivery, with no fallback
to a weaker sandbox. Linux processing and metadata-preservation branches require
native acceptance. Windows public-file metadata preservation requires verifiable
security metadata; missing native privileges are a refusal before replacement,
not permission to discard ACLs.
Do not describe deterministic test coverage as completed native platform support.

Automatic tracking requires supported, enabled native hooks. A processing session
uses a private working directory outside configured projects and an ephemeral
native launch with hook/plugin isolation; it is never enrolled into the queue.
A host outage preserves state but does not run an OS service in the background.

## Output profile

The supported Cuefluent Markdown profile currently limits a file to 10 MiB,
body structure to 20,000 nodes per section and 100,000 per document, and metadata
to a 64 KiB payload within a 2 MiB inspected source. Additional parser bounds cover
nesting, lines and decoded content. Generated metadata must remain inspectable;
a metadata-bearing annual log cannot use the larger plain-file ceiling to bypass
metadata limits. Validate actual structure and bytes, not a presumed safe entry count.

The app's 256-document and 250,000-node corpus allowances apply across its selected
library. Per-file validation cannot guarantee admission into an already-full
library. Annual logs count toward those allowances and can appear in app search.
The current desktop app does not open relative note links; standard links remain
for agents and other readers. These are compatibility-profile constraints to
revisit as supported app versions change.

Staging filenames end in `.tmp` and cannot be discovered as Markdown notes merely
because they contain `.md` earlier in the name. Atomic publication keeps the final
path and verifies parent identity, original hash and supported metadata. External
editors can still race filesystem operations; detected changes are preserved and
reported, and no cross-process protocol can force an unrelated editor to cooperate.
