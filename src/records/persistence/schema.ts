// Owns the persistent schema for the shared issue vocabulary; runtime adapters own database access.
import { CLAIM_STATEMENTS } from '../claims/claims-sql.ts';
import { CHANGE_KIND_REBUILD_STATEMENTS, CHANGE_RELATION_STATEMENTS, CHANGE_STATEMENTS, COMMENT_EDIT_CHANGE_STATEMENTS, ITEM_KIND_REBUILD_STATEMENTS, STAR_KIND_REBUILD_STATEMENTS } from '../store/changes-sql.ts';
import { ITEM_CHANGE_STATEMENTS, ITEM_STATEMENTS } from '../items/items-sql.ts';
import { LAND_ORDER_STATEMENTS } from '../land-order/land-order-sql.ts';
import { POST_STATEMENTS, STAR_CHANGE_STATEMENTS } from '../posts/posts-sql.ts';
import { RESOURCE_STATEMENTS } from '../resources/resources-sql.ts';
export { SCHEMA_V5_SQL } from './schema-v5.ts';
export { SCHEMA_V6_SQL } from './schema-v6.ts';
export { SCHEMA_V7_SQL } from './schema-v7.ts';
export { SCHEMA_V8_SQL } from './schema-v8.ts';
export { SCHEMA_V9_SQL } from './schema-v9.ts';
export { SCHEMA_V10_SQL } from './schema-v10.ts';
export { SCHEMA_V11_SQL } from './schema-v11.ts';
import { SCHEMA_V9_STATEMENTS } from './schema-v9.ts';
import { SCHEMA_V10_STATEMENTS } from './schema-v10.ts';
import { SCHEMA_V11_STATEMENTS } from './schema-v11.ts';
import { statuses, issueTypes, fields } from '../../transition/index.ts';
export const SCHEMA_VERSION = 12;

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
// A fresh store adds these columns with ALTER as an upgrade does, so both paths store byte-identical issue DDL.
// Rolling back to a Worker that predates closure makes reopen fail on issues that a newer Worker closed.
export const CLOSURE_STATEMENTS = [
  'ALTER TABLE issues ADD COLUMN closed_at TEXT',
  `ALTER TABLE issues ADD COLUMN closed_by TEXT CONSTRAINT issue_closure CHECK((closed_at IS NULL AND closed_by IS NULL)
    OR (status = 'closed' AND typeof(closed_at) = 'text' AND length(closed_at) > 0 AND typeof(closed_by) = 'text' AND length(closed_by) > 0))`,
];
// Schema 9 adds the change relation, the land order, and external resources after the closure columns, in the same order on a fresh store and an upgrade.
export const SCHEMA_V9_ADDITIONS = [...CHANGE_RELATION_STATEMENTS, ...LAND_ORDER_STATEMENTS, ...RESOURCE_STATEMENTS];
// An edit keeps no history: version counts edits, and updated_at and updated_by name the last one. A comment never edited holds version 1 and no editor.
export const COMMENT_EDIT_STATEMENTS = [
  `ALTER TABLE comments ADD COLUMN version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991)`,
  'ALTER TABLE comments ADD COLUMN updated_at TEXT',
  `ALTER TABLE comments ADD COLUMN updated_by TEXT CONSTRAINT comment_edit CHECK((version = 1 AND updated_at IS NULL AND updated_by IS NULL)
    OR (version > 1 AND typeof(updated_at) = 'text' AND length(updated_at) > 0 AND typeof(updated_by) = 'text' AND length(updated_by) > 0))`,
];
// The triggers of a schema that write the feed, recreated with their exact text after a rebuild.
// A rebuild drops and recreates triggers, so a schema creates some twice; the last creation is the one the schema keeps.
const triggerName = (sql: string) => /^CREATE TRIGGER (\w+)/.exec(sql)?.[1] ?? '';
const changeFeedTriggers = (statements: readonly string[]) => statements.filter((sql, index) => sql.startsWith('CREATE TRIGGER ') && /\bchange_events\b/.test(sql)
  && !statements.slice(index + 1).some(later => later.startsWith('CREATE TRIGGER ') && triggerName(later) === triggerName(sql)));
const schemaV9FeedTriggers = changeFeedTriggers(SCHEMA_V9_STATEMENTS);
const schemaV10FeedTriggers = changeFeedTriggers(SCHEMA_V10_STATEMENTS);
const schemaV11FeedTriggers = changeFeedTriggers(SCHEMA_V11_STATEMENTS);
// Schema 10 adds comment edits after the schema 9 objects, in the same order on a fresh store and an upgrade.
export const SCHEMA_V10_ADDITIONS = [
  ...COMMENT_EDIT_STATEMENTS,
  ...schemaV9FeedTriggers.map(sql => `DROP TRIGGER ${triggerName(sql)}`),
  ...CHANGE_KIND_REBUILD_STATEMENTS,
  ...schemaV9FeedTriggers,
  ...COMMENT_EDIT_CHANGE_STATEMENTS,
];
// Schema 11 adds posts and stars after the schema 10 objects, in the same order on a fresh store and an upgrade.
export const SCHEMA_V11_ADDITIONS = [
  ...POST_STATEMENTS,
  ...schemaV10FeedTriggers.map(sql => `DROP TRIGGER ${triggerName(sql)}`),
  ...STAR_KIND_REBUILD_STATEMENTS,
  ...schemaV10FeedTriggers,
  ...STAR_CHANGE_STATEMENTS,
];
// Schema 12 adds asks and checks after the schema 11 objects, in the same order on a fresh store and an upgrade.
export const SCHEMA_V12_ADDITIONS = [
  ...ITEM_STATEMENTS,
  ...schemaV11FeedTriggers.map(sql => `DROP TRIGGER ${triggerName(sql)}`),
  ...ITEM_KIND_REBUILD_STATEMENTS,
  ...schemaV11FeedTriggers,
  ...ITEM_CHANGE_STATEMENTS,
];
export function schemaUpgradeStatements(previous: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11): readonly string[] {
  return [
    `INSERT INTO schema_version(version) SELECT 0 WHERE (SELECT count(*) FROM schema_version) <> 1 OR NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${previous})`,
    ...(previous === 2 ? MEMORY_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean) : []),
    ...(previous < 4 ? MEMORY_REVISION_STATEMENTS : []),
    ...(previous < 5 ? DEPENDENCY_STATEMENTS : []),
    ...(previous < 6 ? CLAIM_STATEMENTS : []),
    ...(previous < 7 ? CHANGE_STATEMENTS : []),
    ...(previous < 8 ? CLOSURE_STATEMENTS : []),
    ...(previous < 9 ? SCHEMA_V9_ADDITIONS : []),
    ...(previous < 10 ? SCHEMA_V10_ADDITIONS : []),
    ...(previous < 11 ? SCHEMA_V11_ADDITIONS : []),
    ...SCHEMA_V12_ADDITIONS,
    `UPDATE schema_version SET version = ${SCHEMA_VERSION} WHERE version = ${previous}`,
  ];
}
export const SCHEMA_STATEMENTS = [
  ...SCHEMA_V2_SQL.replace('VALUES (2)', `VALUES (${SCHEMA_VERSION})`).split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_SCHEMA_SQL.split(';').map(sql => sql.trim()).filter(Boolean),
  ...MEMORY_REVISION_STATEMENTS,
  ...DEPENDENCY_STATEMENTS,
  ...CLAIM_STATEMENTS,
  ...CHANGE_STATEMENTS,
  ...CLOSURE_STATEMENTS,
  ...SCHEMA_V9_ADDITIONS,
  ...SCHEMA_V10_ADDITIONS,
  ...SCHEMA_V11_ADDITIONS,
  ...SCHEMA_V12_ADDITIONS,
];
export const SCHEMA_SQL = SCHEMA_STATEMENTS.join(';\n') + ';\n';
