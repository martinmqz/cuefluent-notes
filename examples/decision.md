# Synthetic retry decision

## Decision
<!-- aliases: retry policy, interrupted save -->
The fictional Cedar team keeps the inspected original hash when retrying a note save.

## Rationale
A changed original must remain available for a person to inspect before a new draft is prepared.
