// Owns the issue_items DDL and the triggers that record asks, answers, and check moves in the change feed.
import { changeEvent } from '../store/changes-sql.ts';
import { activeBlockerExists } from '../store/active-blocker.ts';
import { openItemExists } from '../store/issue-items.ts';
import { itemKinds } from '../../transition/index.ts';

const sqlEnum = (values: readonly string[]) => values.map(value => `'${value}'`).join(',');

// An item is never deleted and leaves open once. answer holds the chosen option, or the free answer to an ask with no options;
// note holds the comment on an answer, the evidence of a met check, or the reason for a waiver or a withdrawal.
// request_id makes an add idempotent; the row itself is the receipt, so no payload is stored.
export const ITEM_STATEMENTS = [
  `CREATE TABLE issue_items (
    issue_id TEXT NOT NULL REFERENCES issues(id),
    n INTEGER NOT NULL CHECK(typeof(n) = 'integer' AND n BETWEEN 1 AND 9007199254740991),
    kind TEXT NOT NULL CHECK(kind IN (${sqlEnum(itemKinds)})),
    text TEXT NOT NULL CHECK(length(text) > 0),
    options_json TEXT CHECK(options_json IS NULL OR (kind = 'ask' AND json_valid(options_json) AND json_type(options_json) = 'array')),
    recommended TEXT CHECK(recommended IS NULL OR options_json IS NOT NULL),
    state TEXT NOT NULL CHECK((kind = 'ask' AND state IN ('open','answered','withdrawn')) OR (kind = 'check' AND state IN ('open','met','waived'))),
    answer TEXT CHECK((state = 'answered') = (answer IS NOT NULL AND length(answer) > 0)),
    note TEXT CHECK(CASE state WHEN 'open' THEN note IS NULL WHEN 'answered' THEN note IS NULL OR length(note) > 0 ELSE length(note) > 0 END),
    request_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    created_by TEXT NOT NULL CHECK(length(created_by) > 0),
    resolved_at TEXT,
    resolved_by TEXT,
    PRIMARY KEY(issue_id, n),
    CONSTRAINT item_resolution CHECK((state = 'open' AND resolved_at IS NULL AND resolved_by IS NULL)
      OR (state <> 'open' AND length(resolved_at) > 0 AND length(resolved_by) > 0))
  )`,
];

// An ask records asked and its answer records answered, so a waiter filtered to answered never wakes on its own question.
// Every other item write records updated with the field name items.
// The last open ask leaving puts an open, unblocked issue back on the ready worklist, which records became_ready after the answer.
export const ITEM_CHANGE_STATEMENTS = [
  `CREATE TRIGGER issue_items_change_insert AFTER INSERT ON issue_items
    BEGIN ${changeEvent('NEW.issue_id', "CASE NEW.kind WHEN 'ask' THEN 'asked' ELSE 'updated' END", `CASE NEW.kind WHEN 'ask' THEN '[]' ELSE '["items"]' END`)}; END`,
  `CREATE TRIGGER issue_items_change_update AFTER UPDATE OF state ON issue_items
    WHEN OLD.state = 'open' AND NEW.state <> 'open'
    BEGIN
      ${changeEvent('NEW.issue_id', "CASE NEW.state WHEN 'answered' THEN 'answered' ELSE 'updated' END", `CASE NEW.state WHEN 'answered' THEN '[]' ELSE '["items"]' END`)};
      ${changeEvent('issues.id', "'became_ready'")}
        CROSS JOIN issues WHERE issues.id = NEW.issue_id AND NEW.kind = 'ask' AND issues.status = 'open'
        AND NOT ${activeBlockerExists('issues.id')} AND NOT ${openItemExists('issues.id', 'ready')};
    END`,
];
