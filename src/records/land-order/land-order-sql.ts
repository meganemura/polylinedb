// Owns the land-order DDL and the cycle check that both edge kinds share; operations live in land-order.ts.
import { changeEvent } from '../store/changes-sql.ts';

const counter = (column: string, minimum: number) => `INTEGER NOT NULL CHECK(typeof(${column}) = 'integer' AND ${column} BETWEEN ${minimum} AND 9007199254740991)`;

// A prerequisite and a land-order edge both say that one issue comes after another, so a cycle through either kind, or through both, has no order.
function reaches(start: string, target: string): string {
  return `EXISTS (
      WITH RECURSIVE reachable(id) AS (
        SELECT ${start} UNION
        SELECT dependencies.blocker_id FROM dependencies JOIN reachable ON dependencies.dependent_id = reachable.id UNION
        SELECT land_order.earlier_id FROM land_order JOIN reachable ON land_order.later_id = reachable.id
      ) SELECT 1 FROM reachable WHERE id = ${target}
    )`;
}

// A revision row exists only after the first edit; a missing row is revision 1, so creating an issue writes nothing here.
export const LAND_ORDER_STATEMENTS = [
  `CREATE TABLE land_order (
    later_id TEXT NOT NULL REFERENCES issues(id),
    earlier_id TEXT NOT NULL REFERENCES issues(id),
    PRIMARY KEY(later_id,earlier_id)
  )`,
  'CREATE INDEX land_order_earlier ON land_order(earlier_id,later_id)',
  `CREATE TABLE land_order_revisions (
    later_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
    revision ${counter('revision', 2)}
  )`,
  `CREATE TABLE land_order_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    later_id TEXT NOT NULL REFERENCES issues(id),
    earlier_id TEXT NOT NULL REFERENCES issues(id),
    result_revision ${counter('result_revision', 2)},
    outcome TEXT NOT NULL CHECK(outcome IN ('added','already_present','removed','already_absent')),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER land_order_fixed_identity BEFORE UPDATE OF later_id,earlier_id ON land_order
    WHEN NEW.later_id <> OLD.later_id OR NEW.earlier_id <> OLD.earlier_id
    BEGIN SELECT RAISE(ABORT,'land_order_identity_immutable'); END`,
  `CREATE TRIGGER land_order_acyclic BEFORE INSERT ON land_order
    WHEN NEW.later_id = NEW.earlier_id OR ${reaches('NEW.earlier_id', 'NEW.later_id')}
    BEGIN SELECT RAISE(ABORT,'dependency_cycle'); END`,
  'DROP TRIGGER dependencies_acyclic',
  `CREATE TRIGGER dependencies_acyclic BEFORE INSERT ON dependencies
    WHEN NEW.dependent_id = NEW.blocker_id OR ${reaches('NEW.blocker_id', 'NEW.dependent_id')}
    BEGIN SELECT RAISE(ABORT,'dependency_cycle'); END`,
  'CREATE TRIGGER land_order_requests_immutable_update BEFORE UPDATE ON land_order_requests BEGIN SELECT RAISE(ABORT,\'land_order_receipt_immutable\'); END',
  'CREATE TRIGGER land_order_requests_immutable_delete BEFORE DELETE ON land_order_requests BEGIN SELECT RAISE(ABORT,\'land_order_receipt_immutable\'); END',
  `CREATE TRIGGER land_order_change_insert AFTER INSERT ON land_order
    BEGIN ${changeEvent('NEW.later_id', "'dependency_added'", "'[]'", 'lands_after')}; END`,
  `CREATE TRIGGER land_order_change_delete AFTER DELETE ON land_order
    BEGIN ${changeEvent('OLD.later_id', "'dependency_removed'", "'[]'", 'lands_after')}; END`,
];
