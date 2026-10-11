# Search vocabulary in the examples

## Vocabulary coverage

[These examples](../references/evidence.md#synthetic-sources-for-the-bundled-examples)
describe fictional payment API, client, and decision records. Their source facts are in
[evidence.md](../references/evidence.md#synthetic-sources-for-the-bundled-examples).
They are alternative outputs for different purposes, not a bundle to generate
for every request.

The author inferred these likely lookups from the source subjects, actions,
identifiers, and recorded nickname; no supplied keyword list was needed:

| Vocabulary | Section or scope | Where it appears |
| --- | --- | --- |
| payment conflict | Active authorization conflict | Alias |
| 409 | Active authorization conflict and Retry decision | An alias in each section, with different specificity |
| active auth | Active authorization conflict | Alias |
| throttle | Request rate limit | Alias |
| manual retry | Retry decision | Alias |
| payment | Both documents | H1 topic headings |
| Lantern | Retry decision | Alias inferred from the source's project nickname |
| standup update | Client conflict progress | Alias |
| client review meeting | Integration check before rollout decision | Alias |
| client error mapping | Authorization conflict investigation | Alias |
| client-conflict-04 | Authorization conflict investigation | Alias preserving the test identifier |
| verification limits | Contract and client verification boundaries | Alias |

`payment` is deliberately broad. `manual retry` identifies a narrower subject.
`Lantern` was included proactively because it names the decision's project.
The shared `409` vocabulary can locate both feature behavior and a decision;
the sections explain different things and the query does not promise a unique
result. More specific phrases distinguish them.

The vocabulary does not change the facts: the conflict section preserves the
endpoint and its qualifications; the rate-limit section preserves the threshold,
response code, and retry header; the decision remains a recorded decision without
claiming implementation.

[check-cases.json](check-cases.json) records positive vocabulary cases with the
information a reader should find. The standalone checker looks for every
normalized Unicode word in the target's H1 context, H2 heading, or aliases.
It does not rank the collection like Cuefluent or verify the factual meaning of
the expected description; a person or agent must compare the note to its source.

## Body-only diagnostic example

`Copperfinch` is deliberately left only in the body of
[Authorization conflict investigation](task-summary.md#authorization-conflict-investigation).
It names a low-significance trace annotation; its presence does not supply
search vocabulary. Likewise, that section's deeper heading `Remaining work`
does not supply searchable terms. Neither phrase is a positive checker case.

If the selected purpose made one of these lookups useful, add faithful heading
or alias vocabulary after reviewing its meaning and ambiguity. A body match or a
keyword list in prose alone would still leave the vocabulary gap. This example
demonstrates that gap without claiming the nickname is a cause, feature, or
operational guarantee.
