# Render issue reads as terminal text

## Problem

JSON works for scripts and agents. People need a readable view of issue pages and full issue details. Dynamic issue text can also contain terminal controls or Unicode line separators.

## Decision

A pure formatter accepts tagged `show`, `list`, and `search` results from the public records types. It returns text without a final newline. The CLI owns command selection, stream writes, and the final newline.

A page uses stacked rows. Each row shows the full issue ID, status, priority, type, project, tool, and a bounded body preview. A continuation page shows its complete cursor. `show` renders all issue fields, versions, the full body, and every comment.

When a result carries memory freshness, the formatter shows its status and project. A stale result also shows its reason. Stale and unavailable results tell the user to retrieve project memory before acting.

The formatter escapes C0, C1, DEL, U+2028, and U+2029 in dynamic text. It preserves LF only in indented body and comment blocks. It scans at most 41 body code points to render a 40-code-point preview and adds an ellipsis when text remains.

Fixed headings use bold cyan only when stdout is a TTY, `NO_COLOR` is absent, and `TERM` is not `dumb`. The formatter reads no process globals and imports no runtime adapter.

## Consequences

The CLI can keep JSON as its default output and choose this formatter only for human-readable issue reads. Full bodies remain available through `show`. Record values stay unchanged.

## Alternatives

Aligned tables require terminal-width measurement and can hide long issue scope or IDs. Stacked rows keep those values visible without a width dependency. Coloring dynamic values would make terminal controls harder to distinguish, so color applies only to fixed headings.
