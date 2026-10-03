// Owns the persistent vocabulary and schema; runtime adapters own database access.
export const statuses = ['open', 'in_progress', 'deferred', 'closed'] as const;
export const issueTypes = ['bug', 'task', 'epic', 'feature', 'chore'] as const;
export const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'] as const;
export const SCHEMA_VERSION = 3;

export const MEMORY_SCHEMA_SQL = `
CREATE TABLE memories (
  id TEXT PRIMARY KEY NOT NULL,
  sort_key TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL CHECK(length(project) > 0),
  title TEXT NOT NULL CHECK(length(title) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  version INTEGER NOT NULL CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX memories_project ON memories(project, sort_key);
CREATE TABLE memory_counters (
  prefix TEXT PRIMARY KEY NOT NULL,
  last_number INTEGER NOT NULL CONSTRAINT memory_counter_not_exhausted CHECK(typeof(last_number) = 'integer' AND last_number BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE memory_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  memory_id TEXT NOT NULL UNIQUE
);
`;

const versionColumns = fields.map((field) => `${field}_v INTEGER NOT NULL DEFAULT 1
  CHECK(typeof(${field}_v) = 'integer' AND ${field}_v BETWEEN 1 AND 9007199254740991)`).join(',\n');
const sqlEnum = (values: readonly string[]) => values.map((value) => `'${value}'`).join(',');

export const SCHEMA_V2_SQL = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY NOT NULL CHECK(version > 0));
INSERT INTO schema_version(version) VALUES (2);
CREATE TABLE issues (
  id TEXT PRIMARY KEY NOT NULL,
  parent_id TEXT REFERENCES issues(id),
  sort_key TEXT NOT NULL UNIQUE,
  tool TEXT NOT NULL CHECK(length(tool) > 0),
  project TEXT NOT NULL CHECK(length(project) > 0),
  body TEXT NOT NULL CHECK(length(body) > 0),
  status TEXT NOT NULL CHECK(status IN (${sqlEnum(statuses)})),
  type TEXT NOT NULL CHECK(type IN (${sqlEnum(issueTypes)})),
  priority INTEGER NOT NULL CHECK(typeof(priority) = 'integer' AND priority BETWEEN 0 AND 4),
  labels_json TEXT NOT NULL CHECK(json_valid(labels_json) AND json_type(labels_json) = 'array'),
  ${versionColumns},
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE counters (
  scope TEXT PRIMARY KEY NOT NULL,
  last_number INTEGER NOT NULL CONSTRAINT counter_not_exhausted CHECK(typeof(last_number) = 'integer' AND last_number BETWEEN 1 AND 9007199254740991)
);
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id)
);
CREATE INDEX issues_scope ON issues(tool, project, status, id);
CREATE INDEX issues_parent ON issues(parent_id, id);
CREATE TABLE comments (
  id TEXT PRIMARY KEY NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  body TEXT NOT NULL CHECK(length(body) > 0),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX comments_issue ON comments(issue_id, created_at, id);
`;
export const SCHEMA_SQL = SCHEMA_V2_SQL.replace('VALUES (2)', `VALUES (${SCHEMA_VERSION})`) + MEMORY_SCHEMA_SQL;
