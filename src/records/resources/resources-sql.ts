// Owns the external-resource DDL; operations live in resources.ts.
import { changeEvent } from '../store/changes-sql.ts';

const counter = (column: string, minimum: number) => `INTEGER NOT NULL CHECK(typeof(${column}) = 'integer' AND ${column} BETWEEN ${minimum} AND 9007199254740991)`;
const bytes = (column: string, maximum: number) => `length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${maximum}`;
const resourcesFacet = `'["resources"]'`;

// An entry is never deleted and each mark is set once, so the table is the history of what an issue created outside the store.
// A revision row exists only after the first edit; a missing row is revision 1.
export const RESOURCE_STATEMENTS = [
  `CREATE TABLE issue_resources (
    issue_id TEXT NOT NULL REFERENCES issues(id),
    seq ${counter('seq', 1)},
    kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 64 AND kind GLOB '[a-z0-9]*' AND kind NOT GLOB '*[^a-z0-9:._-]*'),
    name TEXT NOT NULL CHECK(${bytes('name', 256)}),
    external_id TEXT CHECK(external_id IS NULL OR ${bytes('external_id', 256)}),
    created_at TEXT,
    deleted_at TEXT,
    verified_deleted_at TEXT,
    verified_by TEXT,
    evidence TEXT CHECK(evidence IS NULL OR ${bytes('evidence', 1024)}),
    added_at TEXT NOT NULL,
    added_by TEXT NOT NULL CHECK(length(added_by) > 0),
    PRIMARY KEY(issue_id,seq),
    CONSTRAINT resource_marks CHECK((deleted_at IS NULL OR created_at IS NOT NULL)
      AND (verified_deleted_at IS NULL OR deleted_at IS NOT NULL OR created_at IS NULL)
      AND (verified_deleted_at IS NULL) = (verified_by IS NULL) AND (verified_deleted_at IS NULL) = (evidence IS NULL))
  )`,
  'CREATE INDEX issue_resources_live ON issue_resources(issue_id,seq) WHERE verified_deleted_at IS NULL',
  `CREATE TABLE resource_revisions (
    issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
    revision ${counter('revision', 2)}
  )`,
  `CREATE TABLE resource_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    issue_id TEXT NOT NULL REFERENCES issues(id),
    seq ${counter('seq', 1)},
    result_revision ${counter('result_revision', 2)},
    outcome TEXT NOT NULL CHECK(outcome IN ('added','updated')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER issue_resources_forward_only BEFORE UPDATE ON issue_resources
    WHEN NEW.issue_id IS NOT OLD.issue_id OR NEW.seq IS NOT OLD.seq OR NEW.kind IS NOT OLD.kind OR NEW.name IS NOT OLD.name
      OR NEW.added_at IS NOT OLD.added_at OR NEW.added_by IS NOT OLD.added_by
      OR (OLD.external_id IS NOT NULL AND NEW.external_id IS NOT OLD.external_id)
      OR (OLD.created_at IS NOT NULL AND NEW.created_at IS NOT OLD.created_at)
      OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NOT OLD.deleted_at)
      OR (OLD.verified_deleted_at IS NOT NULL AND (NEW.verified_deleted_at IS NOT OLD.verified_deleted_at OR NEW.verified_by IS NOT OLD.verified_by OR NEW.evidence IS NOT OLD.evidence))
    BEGIN SELECT RAISE(ABORT,'resource_entry_forward_only'); END`,
  'CREATE TRIGGER issue_resources_kept BEFORE DELETE ON issue_resources BEGIN SELECT RAISE(ABORT,\'resource_entry_forward_only\'); END',
  'CREATE TRIGGER resource_requests_immutable_update BEFORE UPDATE ON resource_requests BEGIN SELECT RAISE(ABORT,\'resource_receipt_immutable\'); END',
  'CREATE TRIGGER resource_requests_immutable_delete BEFORE DELETE ON resource_requests BEGIN SELECT RAISE(ABORT,\'resource_receipt_immutable\'); END',
  `CREATE TRIGGER issue_resources_change_insert AFTER INSERT ON issue_resources
    BEGIN ${changeEvent('NEW.issue_id', "'updated'", resourcesFacet)}; END`,
  `CREATE TRIGGER issue_resources_change_update AFTER UPDATE ON issue_resources
    BEGIN ${changeEvent('NEW.issue_id', "'updated'", resourcesFacet)}; END`,
];

export const shownLiveResources = 5;
/** Names up to `shownLiveResources` live entries as kind:name, for the close refusal. */
export function liveResourceSummary(names: readonly string[], total: number): string {
  const hidden = total - names.length;
  return names.join(', ') + (hidden > 0 ? ` and ${hidden} more` : '');
}
