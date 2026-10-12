---
applyTo: "SKILL.md,references/**,examples/**,scripts/check-notes*.mjs,scripts/check-examples*.mjs,scripts/note-*.mjs"
---

<!-- agent-guidance-sync:generated:v1 source=".agents/rules/note-guidance.md" target=".github/instructions/agent-guidance/note-guidance.instructions.md" -->

# Note guidance and examples

`SKILL.md`, `references/`, and `examples/` contain installed product guidance,
compatibility limits, and synthetic examples. Keep detailed user workflows here
and repository-maintenance instructions in the root guidance, canonical rules and
[build/publishing guide](/.agents/publishing.md). Do not ship those maintainer
instructions in installed product references.
Link to existing canonical explanations rather than duplicating behavior across
references.

Apply the shared boundaries and development checks in the root
[repository guidance](/AGENTS.md).

`scripts/check-notes.mjs` provides advisory Markdown structure and vocabulary
checks. Run `npm run check:examples` when changing the checker, note guidance, or
examples, plus relevant tests for affected helpers. Keep examples synthetic and
verify that their instructions and commands match the implementation.

Follow [safe updates](/references/refresh.md) for
writer behavior and [processing](/references/processing.md) for captured evidence
and proposed Markdown. Do not turn ordinary Markdown editing into authorization
to collect sessions or enable processing.
