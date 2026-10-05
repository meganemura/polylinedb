# polylinedb

polylinedb records work and knowledge for users and agents.

## Language

**Dependent**:
An issue whose work requires another issue to finish.

**Blocker**:
An issue that must finish before a dependent can proceed.

**Dependency**:
A directed relationship from a dependent to its blocker.
_Avoid_: Using a parent-child relationship to mean a dependency.

**Active blocker**:
A blocker whose status is not `closed`.

**Ready issue**:
An `open` issue with no active blockers.

**Blocked issue**:
An unfinished issue with at least one active blocker.
Being blocked is separate from the issue's stored status.
