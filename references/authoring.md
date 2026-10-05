# Cuefluent authoring and compatibility

Use this guide to preserve useful Markdown structure, organize searchable
sections, and check compatibility with Cuefluent.

This guide describes the supported authoring contract.
Update the guide deliberately when separately supplied compatibility evidence
changes; do not discover rules by reading or running the app during note work.

## Start with existing Markdown

Review the selected original notes before proposing a rewrite. Cuefluent
preserves ordinary CommonMark/GFM section bodies. A section can begin with prose,
a list, a table, or code. Preserve useful structure and detail; a bold opening
answer is optional.

Use [note placement](workflow.md#note-placement) for category folders and naming.
Neither filenames nor folders supply search terms. Put useful type and subject
vocabulary in H1/H2 headings or faithful aliases; no required `type:` frontmatter
is added. Plugin filesystem support does not establish app ingestion of nested
files or recursive folder discovery; keep that evidence separate.

An optional leading `cuefluent` HTML comment carries portable note metadata;
see the [metadata contract](note-metadata.md). The standalone checker validates
its structure and detects duplicate note IDs among selected files. These fields
do not supply app search terms or establish series-aware retrieval. Ordinary
notes need no metadata. Keep summaries, decisions and event dates visible.

```markdown
# Topic context

## Descriptive section subject

<!-- aliases: relevant phrase, faithful alternate term -->

Ordinary prose with the facts and qualifications the reader needs.
It may span several source lines.

1. First step.
   - A relevant condition.
2. Second step.

### Further detail

> A source-backed quotation or qualification.
```

- Root-level H2 headings create searchable sections. H1 supplies topic context;
  a missing H1 is a warning. Both `#`/`##` headings and valid Setext headings
  participate. Headings inside lists, quotes, code, or raw HTML do not create
  independent entries.
- H3–H6 remain visible within their owning H2 body. They do not create entries
  or search terms. Useful text outside an H2 section is not an entry body; a file
  without any H2 sections fails validation. Check this explicitly for existing
  notes before recommending direct use.
- Each section needs visible body content. Whitespace, ordinary comments, alias
  metadata, or reference definitions alone are insufficient.
- Optional aliases use one terminated, single-line `<!-- aliases: ... -->`
  comment in the initial metadata position after the H2, before body content.
  Entries must be nonempty and comma-separated. Repeated or misplaced directives
  are fatal; repeated normalized aliases within a section produce warnings.
- Keep heading paths descriptive and distinct. Normalized collisions within a
  file are fatal; similar headings across files still need retrieval review.
  Do not rename working headings unnecessarily: they determine section identity.

## Preserved content and remaining limits

Bodies support paragraphs, inline formatting, hard/soft breaks, nested and
ordered lists, task lists, blockquotes, thematic breaks, fenced/indented code,
GFM tables, links, reference definitions, footnotes, deeper headings, and
sanitized HTML. Keep table relationships, procedure order, qualifications, and
significant code whitespace intact.

HTML is sanitized. Unsupported or unsafe content and attributes can be removed
with diagnostics. Inspect any resulting content loss; a body with no visible
content after sanitization is fatal. Do not assume arbitrary HTML, scripts,
embedded applications, or frontmatter metadata have special Cuefluent support.

## Images and resource paths

Preserve useful image references and informative alt text. Static PNG, JPEG,
and WebP are supported image formats.

- Use paths relative to the Markdown document for local images. Absolute paths
  and `file:` image URLs are unsupported. Moving a document changes how its
  relative paths resolve, so preserve or adjust them against the output location.
- Use HTTP(S) URLs for remote images. Preserve the intended destination rather
  than downloading or copying assets without a reason within the user's request.
- Image display is subject to user permissions, availability, and size limits.
  Preserve essential information in the text when the source provides it; do not
  infer unseen visual details from an image description alone.

Local image loading requires a revocable session folder grant. Remote images
require explicit activation per occurrence in the current entry/revision.
Unsupported, denied, or failed images remain placeholders. Neither Markdown
checks nor moving a document establish that an image will load.

Copying Markdown does not copy its assets. Check the supplied image references
and report missing assets or unresolved paths. Keep original images intact and
copy them only when that is part of the requested document preparation.

## Links and retrieval

Same-document fragments and footnotes support in-app navigation. Safe HTTP(S)
and mailto links support deliberate activation subject to app controls. Local
file and relative links remain non-opening references. Preserve evidence links
and locators; do not promise that every source reference can be opened in-app.
Detailed source-to-entry mappings can remain in private review material.

Search uses only H2 headings, H1 heading paths, and explicit aliases.
Body text, H3–H6, table cells, code, link labels, image descriptions, and footnotes
supply no search terms. Improve section organization or faithful aliases only
where realistic queries demonstrate a need.

## Review the Markdown

Review the completed `.md` or `.markdown` files against these rules:

- Each document has root-level H2 sections with useful visible content. Keep
  important introductory facts inside a section, and use H1 headings for context.
- Headings distinguish independently useful subjects. H3–H6 remain supporting
  structure within an H2 section.
- Alias comments have valid placement and syntax, with no duplicate directives
  or misleading vocabulary. Review overlapping terms across selected documents.
- Lists, tables, quotations, links, and code blocks preserve the source's meaning
  and relationships. Close code fences and check table structure after editing.
- Image and source references still identify the intended resources from the
  output location. Prefer supported Markdown over HTML that may be sanitized.

Compare the content with its evidence using [evidence.md](evidence.md), then
review heading and alias coverage using [retrieval.md](retrieval.md). Fix concrete
problems in the files and report unresolved content or resource gaps.

## Standalone check and its limits

With Node.js 22 or later, run from this skill's directory. In a source checkout,
install the pinned dependencies once; distributed bundles already include them:

```sh
# Source checkout only:
npm ci --ignore-scripts
# Both source checkouts and distributed bundles:
node scripts/check-notes.mjs /absolute/path/to/selected-note.md
```

The checker reads only explicitly supplied Markdown and optional query cases;
it does not write notes, load image/link targets, scan folders, run the app, or
send telemetry. Its standard Markdown parser recognizes root ATX/Setext H1/H2,
nested constructs, tables, code and footnotes. It checks missing/empty sections,
heading-path collisions, alias placement, duplicate aliases and shared aliases.
HTML and images receive review warnings. Warnings require judgment, not automatic
rewriting. A reference-only or comment-only body is not visible content.

This is an advisory subset check. It does not implement Cuefluent's parser,
sanitizer, ranking, desktop admission, body budgets or corpus limits. Raw HTML
visibility, unsupported-content loss, image resolution and factual completeness
remain review work. Keep these limitations with the result; a clean report is
not proof that every construct is admitted or displayed by the app.

Tool bounds (not Cuefluent limits): 100 explicit files, 2 MiB UTF-8 per file,
200 optional vocabulary cases and 100 displayed diagnostics. Severity totals
include omitted diagnostics. JSON reports include guide version and limitations.
Exit codes: 0 means no checker errors (warnings may remain), 1 means checker
errors, and 2 means an input/usage failure. The command never repairs files.

Developer verification from the source checkout: `npm test` exercises observable helper behavior;
`npm run check:examples` checks the selected synthetic documents and vocabulary.
