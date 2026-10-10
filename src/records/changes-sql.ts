// Owns the change feed DDL; triggers record an event only while a mutation batch holds the writer row.
import { fields } from '../transition/index.ts';

export const changeKinds = ['created', 'updated', 'status_changed', 'commented', 'claim_acquired', 'claim_released', 'dependency_added', 'dependency_removed', 'became_ready'] as const;
export type ChangeKind = typeof changeKinds[number];
export const CHANGE_RETENTION = 10000;

const event = (issue: string, kind: string, fieldsJson = "'[]'") =>
  `INSERT INTO change_events(issue_id,kind,fields_json,occurred_at,actor) SELECT ${issue},${kind},${fieldsJson},unixepoch(),change_writer.actor FROM change_writer`;
const writtenFields = `'[' || substr(${fields.map(field => `CASE WHEN NEW.${field}_v <> OLD.${field}_v THEN ',"${field}"' ELSE '' END`).join(' || ')},2) || ']'`;
const anyFieldWritten = fields.map(field => `NEW.${field}_v <> OLD.${field}_v`).join(' OR ');
const noActiveBlocker = (dependent: string) => `NOT EXISTS(SELECT 1 FROM dependencies AS other JOIN issues AS blocker ON blocker.id = other.blocker_id
      WHERE other.dependent_id = ${dependent} AND blocker.status <> 'closed')`;

// Restores, merges, and upgrades write without the change_writer row, so they record no events.
export const CHANGE_STATEMENTS = [
  `CREATE TABLE change_events (
    seq INTEGER PRIMARY KEY NOT NULL CHECK(seq BETWEEN 1 AND 9007199254740991),
    issue_id TEXT NOT NULL REFERENCES issues(id),
    kind TEXT NOT NULL CHECK(kind IN (${changeKinds.map(kind => `'${kind}'`).join(',')})),
    fields_json TEXT NOT NULL CHECK(json_valid(fields_json) AND json_type(fields_json) = 'array'),
    occurred_at INTEGER NOT NULL CHECK(typeof(occurred_at) = 'integer' AND occurred_at >= 0),
    actor TEXT NOT NULL CHECK(length(actor) > 0)
  )`,
  `CREATE TABLE change_writer (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
    actor TEXT NOT NULL CHECK(length(actor) > 0)
  )`,
  `CREATE TRIGGER change_events_retention AFTER INSERT ON change_events
    BEGIN DELETE FROM change_events WHERE seq <= NEW.seq - ${CHANGE_RETENTION}; END`,
  `CREATE TRIGGER change_events_incarnation AFTER UPDATE OF incarnation ON memory_store_identity
    WHEN NEW.incarnation <> OLD.incarnation
    BEGIN DELETE FROM change_events; END`,
  `CREATE TRIGGER issues_change_insert AFTER INSERT ON issues
    BEGIN ${event('NEW.id', "'created'")}; END`,
  `CREATE TRIGGER issues_change_update AFTER UPDATE ON issues
    BEGIN
      ${event('NEW.id', "CASE WHEN NEW.status_v <> OLD.status_v THEN 'status_changed' ELSE 'updated' END", writtenFields)}
        WHERE ${anyFieldWritten};
      ${event('dependent.id', "'became_ready'")}
        CROSS JOIN dependencies JOIN issues AS dependent ON dependent.id = dependencies.dependent_id
        WHERE OLD.status <> 'closed' AND NEW.status = 'closed' AND dependencies.blocker_id = NEW.id AND dependent.status = 'open'
        AND ${noActiveBlocker('dependent.id')}
        ORDER BY dependent.sort_key;
    END`,
  `CREATE TRIGGER comments_change_insert AFTER INSERT ON comments
    BEGIN ${event('NEW.issue_id', "'commented'")}; END`,
  `CREATE TRIGGER claim_requests_change_insert AFTER INSERT ON claim_requests
    WHEN NEW.outcome IN ('acquired','released')
    BEGIN ${event('NEW.issue_id', "'claim_' || NEW.outcome")}; END`,
  `CREATE TRIGGER dependencies_change_insert AFTER INSERT ON dependencies
    BEGIN ${event('NEW.dependent_id', "'dependency_added'")}; END`,
  `CREATE TRIGGER dependencies_change_delete AFTER DELETE ON dependencies
    BEGIN
      ${event('OLD.dependent_id', "'dependency_removed'")};
      ${event('dependent.id', "'became_ready'")}
        CROSS JOIN issues AS dependent CROSS JOIN issues AS removed
        WHERE dependent.id = OLD.dependent_id AND removed.id = OLD.blocker_id AND removed.status <> 'closed' AND dependent.status = 'open'
        AND ${noActiveBlocker('dependent.id')};
    END`,
];
