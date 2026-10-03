# Versioned project memory

Status: accepted.

Agents need current project knowledge across sessions, including after an issue closes.
Comments retain discussion but do not identify which statement currently applies.
Reconstructing knowledge from corrective comments would place that policy in every caller.

Store each memory as a dedicated project record with a title, body, version, and audit fields.
Keep the project and ID fixed. Update the title and body together with one observed version.
This preserves their meaning as one fact and rejects stale edits.
Issue fields retain independent versions because unrelated task fields can change independently.

Use readable `prefix-mN` IDs and separate memory counters.
Retain counters and creation receipts after deletion.
This prevents ID reuse and stops an uncertain creation retry from restoring deleted knowledge.
Snapshots preserve these records together with memory content and attribution.

Context retrieval returns complete entries within an entry and serialized byte budget.
It reports omissions explicitly and returns errors for unavailable storage.
The same operation serves CLI, HTTP, MCP, and future host lifecycle adapters.
The bundled skill tells agents when to call it; automatic host hooks require separate verification.

This design stores current knowledge. It does not add a full revision history, automatic merge, or semantic ranking.
