# Synthetic Atlas payment client task

## Authorization conflict investigation

<!-- aliases: client error mapping, conflict test, intent_demo_17, client-conflict-04 -->

The task examined how the client handles an authorization conflict. It established
the following bounded results:

| Occurred | Finding | Evidence limits |
| --- | --- | --- |
| 2026-09-02, 16:20 UTC | A sandbox request for active-authorization fixture `intent_demo_17` received `409` from `POST /v2/payment-intents`. | The trace does not establish a charge outcome. |
| 2026-09-03, 10:05 UTC | Test `client-conflict-04` mapped a fake-transport `409` to `AuthorizationConflict`, preserved the intent identifier, and issued no automatic retry during one invocation. | Live service behavior, repeated invocations, and deployment were not tested. |

The September 3 result was recorded on September 4 at 08:00 UTC; its occurrence
date remains September 3.

### Remaining work

The live integration check is pending sandbox access. No result, owner, or due
date is recorded. An undated note says the help text still describes automatic
retries; when that wording appeared or was noticed, and whether it has since been
corrected, are unknown.

The trace annotation calls the fixture `Copperfinch`. The source gives that
nickname no operational significance.

Source: fictional [TASK-12](../references/evidence.md#task-12--client-investigation-record).
