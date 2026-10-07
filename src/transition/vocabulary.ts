// Names the issue vocabulary that every store and the transitions share.
export const statuses = ['open', 'in_progress', 'deferred', 'closed'] as const;
export const issueTypes = ['bug', 'task', 'epic', 'feature', 'chore'] as const;
export const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'] as const;
export type Status = typeof statuses[number];
export type IssueType = typeof issueTypes[number];
export type Field = typeof fields[number];
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
