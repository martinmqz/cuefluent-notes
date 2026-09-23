# Headings and search vocabulary

Cuefluent searches H2 headings, their H1 heading paths, and aliases. Section-body
text, including H3–H6, tables, code, and footnotes, does not contribute search
terms. Organize vocabulary where it can help locate the supported content.

## Choose descriptive headings

Use H1 for the broader topic and H2 for independently useful subjects. Preserve
working headings when adapting an existing document. Avoid generic H2 headings
such as "Details" when a subject like "Request rate limit" conveys the content.

An H3 can organize a subsection but adds no search vocabulary. If it contains
an independently useful subject, consider an H2 section or a faithful alias for
the existing H2; choose according to the content's organization.

## Add aliases where useful

Infer realistic lookups on every creation or meaningful update from symptoms,
actions, causes, subject names, acronyms, identifiers, error codes and natural
alternate phrasing. User-supplied searches refine this selection but are never
a prerequisite. Aliases can cover acronyms, identifiers, and
faithful alternate terminology without adding unsupported factual claims; see
[evidence.md](evidence.md).

Place one optional alias comment directly after the H2, before body content:

```markdown
## Active authorization conflict

<!-- aliases: payment conflict, 409, active auth -->

The endpoint returns 409 when an active authorization exists.
```

Keep useful source terminology in the text. Avoid exhaustive synonym lists,
duplicate aliases, and unrelated terms that make several sections appear to
cover the same subject. A phrase that implies unsupported behavior is not a
suitable alias, even if it sounds like a plausible search.

## Review keyword coverage in the files

For each intended topic:

1. Locate the section containing the information and its qualifications.
2. Check whether the intended vocabulary appears in its H2, H1 path, or aliases.
   A word appearing only in the body does not provide search coverage.
3. Review other sections using the same or similar vocabulary. Keep broad terms
   when they usefully cover a group; distinguish terms meant for one subject.
4. Correct headings or aliases within the requested scope while preserving the
   facts. Do not change what the section claims merely to fit a keyword.

A short mapping can make the review clear:

| Keywords | Information | Vocabulary location |
| --- | --- | --- |
| payment conflict | When the API returns 409 | Alias on Active authorization conflict |
| throttle | Request threshold and retry header | Alias on Request rate limit |

The [vocabulary example](../examples/search-vocabulary.md) shows this review for
the bundled fictional documents. Describe the coverage found in the Markdown;
do not promise an exact result order from a vocabulary review.

## Optional reproducible cases

Choose expected information before tuning the vocabulary. Keep private cases
outside this public repository, next to the user's review material. A small JSON
file can make coverage checks repeatable:

```json
{
  "version": 1,
  "cases": [
    {
      "query": "payment conflict",
      "file": "notes.md",
      "heading": "Active authorization conflict",
      "expected": "The endpoint returns 409 when an active authorization exists."
    }
  ]
}
```

`file` is relative to the cases file (absolute paths also work); it must name an
explicitly selected input. `heading` is the exact visible H2 text and must select
one section in that file. If an H2 repeats under different topics, add optional
`h1` with the exact visible H1 text to select the intended heading path. A bare
H2 that matches multiple sections remains ambiguous. `expected` describes the information and qualifications
to review against evidence; the checker cannot validate that statement.

```sh
node scripts/check-notes.mjs --cases /private/collection/cases.json /private/collection/notes.md
```

The checker tests whether every Unicode word/number in a query occurs somewhere
in that section's H1, H2 or aliases, ignoring case and punctuation. This deliberate
coverage heuristic does not reproduce app tokenization, phrase matching or
ranking. Review near-synonyms, competing sections and broad vocabulary manually.
Exact shared aliases receive warnings; usefully shared vocabulary need not be
removed. Cases are optional for ordinary writing; infer vocabulary even without
a cases file. No query or expected text is printed in diagnostics.
