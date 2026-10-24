// Owns the post DDL: the voice and reply columns on comments, the stars table, and the triggers that record stars in the feed.
import { changeEvent } from './changes-sql.ts';

/** The handle rule in SQL; parseHandle states the same rule for callers. GLOB limits the text to ASCII, so length counts bytes. */
export const handleSql = (column: string) => `${column} IS NULL OR (length(${column}) BETWEEN 1 AND 64 AND ${column} GLOB '[a-z0-9]*' AND ${column} NOT GLOB '*[^a-z0-9._-]*')`;

// handle and via are attribution the writer declares; authorization reads only created_by and actor.
// The trigger keeps a reply on the issue of its target on every path, including a restore or a merge that writes without an operation.
// Comments are never deleted and reply_to never changes, so a reply chain cannot form a cycle.
export const POST_STATEMENTS = [
  `ALTER TABLE comments ADD COLUMN handle TEXT CONSTRAINT comment_handle CHECK(${handleSql('handle')})`,
  'ALTER TABLE comments ADD COLUMN via TEXT CONSTRAINT comment_via CHECK(via IS NULL OR length(CAST(via AS BLOB)) BETWEEN 1 AND 128)',
  'ALTER TABLE comments ADD COLUMN reply_to TEXT REFERENCES comments(id)',
  `CREATE TRIGGER comments_reply_on_issue BEFORE INSERT ON comments
    WHEN NEW.reply_to IS NOT NULL AND NOT EXISTS(SELECT 1 FROM comments AS target WHERE target.id = NEW.reply_to AND target.issue_id = NEW.issue_id)
    BEGIN SELECT RAISE(ABORT,'reply_target_not_found'); END`,
  'CREATE INDEX comments_posts ON comments(created_at, id) WHERE handle IS NOT NULL',
  // One star per starrer and post. The starrer is the handle when the caller gave one, else the actor.
  `CREATE TABLE stars (
    comment_id TEXT NOT NULL REFERENCES comments(id),
    starrer TEXT NOT NULL CHECK(length(starrer) > 0),
    handle TEXT CONSTRAINT star_handle CHECK(${handleSql('handle')}),
    actor TEXT NOT NULL CHECK(length(actor) > 0),
    created_at TEXT NOT NULL CHECK(length(created_at) > 0),
    PRIMARY KEY(comment_id, starrer),
    CONSTRAINT star_starrer CHECK(starrer = COALESCE(handle, actor))
  )`,
];

// Only a row that appears or disappears records an event, so a repeated star or a missing unstar leaves the feed as it was.
export const STAR_CHANGE_STATEMENTS = [
  `CREATE TRIGGER stars_change_insert AFTER INSERT ON stars
    BEGIN ${changeEvent('(SELECT issue_id FROM comments WHERE id = NEW.comment_id)', "'starred'")}; END`,
  `CREATE TRIGGER stars_change_delete AFTER DELETE ON stars
    BEGIN ${changeEvent('(SELECT issue_id FROM comments WHERE id = OLD.comment_id)', "'unstarred'")}; END`,
];
