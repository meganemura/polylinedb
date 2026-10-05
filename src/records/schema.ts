// Owns the persistent vocabulary and schema; runtime adapters own database access.
export const statuses = ['open', 'in_progress', 'deferred', 'closed'] as const;
export const issueTypes = ['bug', 'task', 'epic', 'feature', 'chore'] as const;
export const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'] as const;
export const SCHEMA_VERSION = 5;

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
export const SCHEMA_V3_SQL = SCHEMA_V2_SQL.replace('VALUES (2)', 'VALUES (3)') + MEMORY_SCHEMA_SQL;
export const MEMORY_REVISION_STATEMENTS = [
  `CREATE TABLE memory_store_identity (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
    incarnation TEXT NOT NULL CHECK(length(incarnation) = 32 AND incarnation NOT GLOB '*[^a-f0-9]*')
  )`,
  'INSERT INTO memory_store_identity(singleton,incarnation) VALUES (1,lower(hex(randomblob(16))))',
  `CREATE TABLE project_memory_revisions (
    project TEXT PRIMARY KEY NOT NULL CHECK(length(project) > 0),
    revision INTEGER NOT NULL CONSTRAINT memory_revision_not_exhausted CHECK(typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991)
  )`,
  'INSERT INTO project_memory_revisions(project,revision) SELECT DISTINCT project,1 FROM memories',
  `CREATE TRIGGER memories_fixed_identity BEFORE UPDATE OF id,project ON memories
    WHEN NEW.id <> OLD.id OR NEW.project <> OLD.project
    BEGIN SELECT RAISE(ABORT,'memory_identity_immutable'); END`,
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map(event => {
    const row = event === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER memories_revision_${event.toLowerCase()} AFTER ${event} ON memories
      BEGIN
        INSERT INTO project_memory_revisions(project,revision) VALUES (${row}.project,1)
        ON CONFLICT(project) DO UPDATE SET revision = revision + 1;
      END`;
  }),
];
export const ROTATE_MEMORY_IDENTITY_SQL = 'UPDATE memory_store_identity SET incarnation = lower(hex(randomblob(16))) WHERE singleton = 1';
export const SCHEMA_V4_STATEMENTS = [
  ...SCHEMA_V2_SQL.replace('VALUES (2)', 'VALUES (4)').split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_REVISION_STATEMENTS,
];
export const SCHEMA_V4_SQL = SCHEMA_V4_STATEMENTS.join(';\n') + ';\n';
export const DEPENDENCY_STATEMENTS = [
  `CREATE TABLE dependencies (
    dependent_id TEXT NOT NULL REFERENCES issues(id),
    blocker_id TEXT NOT NULL REFERENCES issues(id),
    PRIMARY KEY(dependent_id,blocker_id)
  )`,
  'CREATE INDEX dependencies_blocker ON dependencies(blocker_id,dependent_id)',
  `CREATE TABLE dependency_revisions (
    dependent_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision BETWEEN 1 AND 9007199254740991)
  )`,
  `CREATE TABLE dependency_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    dependent_id TEXT NOT NULL REFERENCES issues(id),
    blocker_id TEXT NOT NULL REFERENCES issues(id),
    result_revision INTEGER NOT NULL CHECK(typeof(result_revision) = 'integer' AND result_revision BETWEEN 2 AND 9007199254740991),
    outcome TEXT NOT NULL CHECK(outcome IN ('added','already_present','removed','already_absent')),
    created_at TEXT NOT NULL
  )`,
  'INSERT INTO dependency_revisions(dependent_id,revision) SELECT id,1 FROM issues',
  `CREATE TRIGGER issues_dependency_revision AFTER INSERT ON issues
    BEGIN INSERT INTO dependency_revisions(dependent_id,revision) VALUES (NEW.id,1); END`,
  `CREATE TRIGGER dependencies_fixed_identity BEFORE UPDATE OF dependent_id,blocker_id ON dependencies
    WHEN NEW.dependent_id <> OLD.dependent_id OR NEW.blocker_id <> OLD.blocker_id
    BEGIN SELECT RAISE(ABORT,'dependency_identity_immutable'); END`,
  `CREATE TRIGGER dependencies_acyclic BEFORE INSERT ON dependencies
    WHEN NEW.dependent_id = NEW.blocker_id OR EXISTS (
      WITH RECURSIVE reachable(id) AS (
        SELECT NEW.blocker_id UNION
        SELECT dependencies.blocker_id FROM dependencies JOIN reachable ON dependencies.dependent_id = reachable.id
      ) SELECT 1 FROM reachable WHERE id = NEW.dependent_id
    ) BEGIN SELECT RAISE(ABORT,'dependency_cycle'); END`,
];
export function schemaUpgradeStatements(previous: 2 | 3 | 4): readonly string[] {
  return [
    `INSERT INTO schema_version(version) SELECT 0 WHERE (SELECT count(*) FROM schema_version) <> 1 OR NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${previous})`,
    ...(previous === 2 ? MEMORY_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean) : []),
    ...(previous < 4 ? MEMORY_REVISION_STATEMENTS : []),
    ...DEPENDENCY_STATEMENTS,
    `UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE version = ${previous}`,
  ];
}
export const SCHEMA_STATEMENTS = [
  ...SCHEMA_V2_SQL.replace('VALUES (2)', `VALUES (${SCHEMA_VERSION})`).split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_REVISION_STATEMENTS,
  ...DEPENDENCY_STATEMENTS,
];
export const SCHEMA_SQL = SCHEMA_STATEMENTS.join(';\n') + ';\n';
