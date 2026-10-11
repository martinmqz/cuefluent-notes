# Synthetic Atlas client knowledge base

## Contract and client verification boundaries

<!-- aliases: authorization conflict evidence, tested behavior, verification limits -->

The API contract and the client test answer different questions:

- **API contract:** `POST /v2/payment-intents` returns `409` when an active
  authorization exists. PAY-101 does not establish whether a charge occurred,
  whether duplicate charges are prevented, or what the caller should do next.
- **Client observation:** on September 3, 2026 at 10:05 UTC,
  `client-conflict-04` mapped a fake-transport `409` to `AuthorizationConflict`,
  preserved `intent_demo_17`, and issued no automatic retry during one invocation.
  That result was recorded on September 4 at 08:00 UTC. It does not establish
  live service behavior, repeated-call behavior, or deployment.

### Review history and unresolved gap

The documentation review on September 4, 2026 at 13:00 UTC retained these
boundaries and the pending live integration check. It did not certify the
deployed client. The help-text discrepancy in TASK-12 remains undated and
unresolved; its first occurrence must not be inferred from the review date.

Sources: fictional [PAY-101](../references/evidence.md#pay-101--feature-record),
[TASK-12](../references/evidence.md#task-12--client-investigation-record), and
[DOC-5](../references/evidence.md#doc-5--client-documentation-review-record).
