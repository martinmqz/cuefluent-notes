# Synthetic payment API

## Active authorization conflict

<!-- aliases: payment conflict, 409, active auth, payment intent -->

In this fictional API, the following endpoint returns `409` when an active
authorization exists:

```http
POST /v2/payment-intents
```

The source does not establish whether a charge occurred, whether duplicate
charges are prevented, or what the caller should do next.

<!-- source-review: Fictional source PAY-101, ../references/evidence.md#pay-101--feature-record. -->

## Request rate limit

<!-- aliases: rate limit, 429, throttle -->

This fictional API documents the following rate-limit behavior:

| Condition or response | Value |
| --- | --- |
| Trigger | Exceeding 60 requests per minute per client |
| Status | `429` |
| Retry header | `Retry-After: 30` |

The source gives no rationale for the request threshold or retry interval.

<!-- source-review: Fictional source PAY-102, ../references/evidence.md#pay-102--rate-limit-record. -->
