# Synthetic Atlas client knowledge base

## Contract and client verification boundaries

<!-- aliases: authorization conflict evidence, tested behavior, verification limits -->

The API contract and the client test answer different questions:

- **API contract:** `POST /v2/payment-intents` returns `409` when an active
  authorization exists. The contract does not establish whether a charge occurred,
  whether duplicate charges are prevented, or what the caller should do next.
- **Client observation:** on September 3, 2026 at 10:05 UTC,
  `client-conflict-04` mapped a fake-transport `409` to `AuthorizationConflict`,
  preserved `intent_demo_17`, and issued no automatic retry during one invocation.
  It does not establish live service behavior, repeated-call behavior, or
  deployment.

### Unresolved integration gap

As of the September 4, 2026 documentation review at 13:00 UTC, the live integration
check was pending, and the available evidence did not certify the deployed
client. The help-text discrepancy in the client investigation remained undated
and unresolved at that review. Neither its first occurrence nor its current
status can be inferred from that review date.

<!-- source-review: The September 3 test result was recorded on September 4 at 08:00 UTC. The documentation review on September 4, 2026 at 13:00 UTC retained these boundaries and the pending live check. Fictional sources PAY-101, TASK-12 and DOC-5; ../references/evidence.md#pay-101--feature-record, #task-12--client-investigation-record and #doc-5--client-documentation-review-record. -->
