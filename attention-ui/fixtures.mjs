// Sample project state for art review when pd is unreachable. The shape matches the live read, plus a host frame
// that pd does not record yet. Issue IDs are format-valid but point at no real issue.
const now = Math.floor(Date.now() / 1000);
const minutesAgo = (minutes) => new Date((now - minutes * 60) * 1000).toISOString();

export const fixtureState = {
  project: 'example/project',
  observedAt: now,
  blocked: [
    {
      id: 'pd-101',
      body: 'Decide the next step for the parser',
      updated_at: minutesAgo(95),
      blockers: [{ id: 'pd-98', status: 'open' }],
    },
    {
      id: 'pd-104',
      body: 'Check the connection to the store',
      updated_at: minutesAgo(40),
      blockers: [{ id: 'pd-102', status: 'in_progress' }],
    },
    {
      id: 'pd-107',
      body: 'Choose who takes over the import',
      updated_at: minutesAgo(12),
      blockers: [{ id: 'pd-101', status: 'open' }],
    },
  ],
  ready: [
    { id: 'pd-98', body: 'Write the parser fixtures' },
    { id: 'pd-110', body: 'Shorten the help text' },
  ],
  inProgress: [
    { id: 'pd-102', body: 'Rotate the store credentials', tip: '3f9c2a1d4b5e6f708192a3b4c5d6e7f809123456' },
    { id: 'pd-105', body: 'Measure the snapshot export', tip: null },
  ],
  activeClaims: [
    { issue_id: 'pd-102', agent_label: 'Codex', host: 'local', acquired_at: now - 1800, expires_at: now + 1800 },
    { issue_id: 'pd-104', agent_label: 'Claude', host: 'cloud', acquired_at: now - 600, expires_at: now + 3000 },
  ],
};
