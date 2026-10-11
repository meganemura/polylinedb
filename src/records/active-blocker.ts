// Names an active blocker. A blocker is active while its status is not closed.
export function blockerIsActive(status: string): boolean {
  return status !== 'closed';
}

export function activeBlockerStatusSql(alias = 'blocker'): string {
  return `${alias}.status <> 'closed'`;
}

export function activeBlockerExists(dependentId: string): string {
  return `EXISTS(SELECT 1 FROM dependencies JOIN issues AS blocker ON blocker.id = dependencies.blocker_id WHERE dependencies.dependent_id = ${dependentId} AND ${activeBlockerStatusSql()})`;
}
