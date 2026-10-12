# Cuefluent authoring and compatibility

Use this guide to preserve useful Markdown structure, organize searchable
sections, and check compatibility with Cuefluent.

This guide describes the supported authoring contract.
Update the guide deliberately when separately supplied compatibility evidence
changes; do not discover rules by reading or running the app during note work.

## Durable content and provenance

The visible content you author should answer a useful question about the subject:
facts, decisions, rationale, explanations, procedures, actions or meaningful open
questions. Keep the context needed to understand those answers. A domain procedure
can be durable knowledge; the process of extracting, checking or writing this
note is provenance rather than subject content.

For a meeting, preserve its known identity, meaningful occurrence date,
discussion outcomes, decisions, rationale, action owners and unresolved matters.
Summarize the useful knowledge rather than reproducing the transcript. Keep who
reported or decided something and any uncertainty that changes its meaning
visible; a reported result must not become an independently verified fact.

Keep identifiers that name the subject, such as a ticket, task, test or decision,
visible when useful. Distinguish them from technical capture/source IDs and hashes.
Keep technical source IDs, locators, hashes, transcript offsets, transcription
mechanics and note-production/checking history out of visible prose. Retain useful
provenance in supported [source metadata](note-metadata.md#selected-sources-and-hashes)
or bounded ordinary `<!-- source-review: ... -->` comments after any leading
metadata block. An existing plain note can use ordinary comments without adding
structured metadata. Preserve existing metadata and unfamiliar fields under
their normal update rules; this content boundary does not authorize enrichment.

This boundary governs new or agent-drafted text. Preserve existing user-written
references, source footers and context during updates; preserve them when
authorship is unclear. Moving or hiding them requires a user-requested cleanup.
Do not turn an unrelated update into a content migration or discard recoverable
provenance.

Full transcripts and raw tool logs stay in the selected source or private
evidence. Retain useful excerpts only when needed to explain the durable
knowledge; do not copy complete dumps into the body, metadata or comments.
Do not create duplicate source documents just to populate provenance.
Explicit requests for a transcript or audit document retain their requested
purpose and consent boundaries; they do not change ordinary knowledge notes.

Keep material evidence gaps visible alongside affected claims. Routine details
about how a transcript was supplied or checked belong with provenance; missing
evidence that prevents a conclusion belongs with that conclusion. Before
proposing a save, read the visible text you drafted on its own and remove
extraction logs, processing narration and source bookkeeping that do not serve
the note's subject.

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
For recurring notes, [series authoring](note-series.md) explains how to retain
separate human-sized files with shared identity metadata and visible period
vocabulary, while honoring explicit destinations and existing plain notes.

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
file and relative links remain non-opening references. Preserve useful subject
links and recoverable provenance under the [content boundary](#durable-content-and-provenance),
including existing user-written references. Do not promise that every source
reference can be opened in-app. Detailed source-to-entry mappings can remain in
private review material.

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
# Explicit recursive folder selection; repeat --folder for separate roots:
node scripts/check-notes.mjs --folder /absolute/path/to/selected-collection
```

The checker reads explicitly supplied Markdown, Markdown beneath explicitly
selected folders, and optional query cases. It does not write notes, load
image/link targets, discover unselected folders, run the app, or
send telemetry. Its standard Markdown parser recognizes root ATX/Setext H1/H2,
nested constructs, tables, code and footnotes. It checks missing/empty sections,
heading-path collisions, alias placement, duplicate aliases and shared aliases.
Optional cases also flag [competing query vocabulary](retrieval.md#optional-reproducible-cases)
across the selected sections, without predicting search ranking.
HTML and images receive review warnings. Warnings require judgment, not automatic
rewriting. A reference-only or comment-only body is not visible content.

This is an advisory subset check. It does not implement Cuefluent's parser,
sanitizer, ranking, desktop admission, body budgets or corpus limits. Raw HTML
visibility, unsupported-content loss, image resolution and factual completeness
remain review work. Keep these limitations with the result; a clean report is
not proof that every construct is admitted or displayed by the app.

Tool bounds (not Cuefluent limits): 1–256 selected files, 2 MiB UTF-8 per file,
200 optional vocabulary cases and 100 displayed diagnostics. Severity totals
include omitted diagnostics; displayed diagnostics prioritize errors. JSON reports
include guide version and limitations.
The optional competition check has a separate budget of 1,000,000 query-word/section comparisons;
if exhausted, it reports incomplete competition coverage while other checks continue.
Exit codes: 0 means no checker errors (warnings may remain), 1 means checker
errors, and 2 means an input/usage failure. One unreadable, oversized or invalid
UTF-8 input aborts the run without a partial report; the selection was not completely
checked, and the error says `selection incomplete`. Usage and cases-file errors
report their own cause without that label. The command never repairs files.

Folder selection recurses through regular directories, including hidden directories,
and selects regular `.md`/`.markdown` files (case insensitive) in deterministic
path order across the whole selection, including explicit file arguments. It
counts all visited entries, including selected roots, ignored file
types and links, with one 4,096-entry budget across all roots. Roots have depth zero;
directory depth is limited to 64. Exceeding any bound fails the complete run.
Discovered symlinks and Windows junctions are not followed; `scan.skippedLinks`
reports their count and the report explains that their targets were excluded.
A selected folder's final component must not be a link, but linked parents
(including macOS `/tmp` and `/var`) resolve normally. Explicit file arguments
continue to resolve links to their real paths.

Repeated/nested folder roots, folder-plus-member-file selections, and duplicate
canonical file paths fail as overlaps. Select disjoint inputs; duplicates are not
silently merged. Checks for note IDs, aliases and cases cover the entire selected
set. A selected folder is not necessarily the app's whole library. The app's
10 MiB per-file allowance does not enlarge this checker's 2 MiB bound or prove app
admission. The writer retains its separate 100-operation and 100-file derived
manifest limits; checker coverage does not enlarge either.
