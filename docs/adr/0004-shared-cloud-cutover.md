# Preserve both stores during a cloud cutover

Status: accepted.

## Context

A shared local store can contain work from several projects while a cloud store already contains connector checks or other work.
Replacing the destination loses those existing records.
Recreating local issues through the public API changes IDs, versions, attribution, timestamps, and creation receipts.

Separate stores can also assign one prefix and number to different work.
A larger version or later timestamp does not establish which record belongs to the intended history.

## Decision

The additive operator accepts disjoint keys and counter namespaces across all seven collections.
It validates both snapshots and the complete union before a write.
Overlapping issue IDs, comment IDs, request IDs, memory IDs, receipt targets, or counter namespaces stop the transfer.
The operator does not select winners or renumber records.

One D1 batch checks the captured destination and adds source rows through bound JSON chunks.
Plain inserts preserve existing destination rows and make an unexpected conflict abort the batch.
The operator reads every collection again and compares the canonical union before changing repository routing.

The final local snapshot comes from the connection holding `BEGIN IMMEDIATE`.
Write-rejection triggers retire ordinary local clients, including previously opened connections.
The operator commits retirement before it changes repository defaults, so a partial routing failure cannot split subsequent writes.
An uncertain cloud response also keeps the source retired until the operator checks the fixed snapshots.

Git common configuration files change under their existing mutation locks.
The operator compares their captured bytes before replacement and retains project, tool, prefix, and optional local actor.
Cloud operations use the authenticated actor; historical records keep their original attribution.

## Consequences

The old local store remains readable, and private snapshots retain recovery evidence.
Normal operation uses the cloud connection after cutover.
This transfer does not provide synchronization or an automatic return to the local store.

The source and destination must have canonical schema 3.
The current operator refuses additional restoration claim tables.
Operators must pause cloud writers for the exact final comparison and review namespace conflicts before another migration strategy.
Direct SQL administrators can remove retirement triggers; those triggers protect ordinary clients rather than administrative access.
