# Field versions in a fixed issue row

Status: accepted.

The issue vocabulary has seven mutable fields.
Concurrent agents must preserve changes to unrelated fields and reject stale changes to the same field.

Use typed columns and one version column per field.
One conditional UPDATE checks all changed versions before changing any values.
SQLite and D1 can execute this statement without interactive transaction callbacks.

A normalized field table requires reconstruction for reads and a shared eligibility check for multi-field updates.
An event store adds projections and ordering rules to every query.
A single issue version rejects independent field changes.
The fixed row keeps those responsibilities inside a smaller storage implementation.

Store creation and last-update actor metadata, plus actor metadata on every comment.
Full event history is outside the initial operation contract.
Use explicit expected versions for close and reopen as well as update.
