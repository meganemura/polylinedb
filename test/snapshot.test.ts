// Exercises local snapshot restoration and replay through the public store interface.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/sqlite.ts';
import { canonicalSnapshot, parseSnapshot } from '../src/snapshot.ts';
import type { Snapshot } from '../src/snapshot.ts';

const parent = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const child = `${parent}.bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb`;
function fixture(): Snapshot {
  const issue = { id: parent, tool: 'tool', project: 'project', body: 'original body', status: 'closed', type: 'epic', priority: 2, labels: ['z', 'a'], versions: { tool: 1, project: 2, body: 3, status: 4, type: 5, priority: 6, labels: 7 }, created_at: '2020-01-02T03:04:05Z', created_by: 'original:author', updated_at: '2021-02-03T04:05:06.123456+09:00', updated_by: 'original:editor' };
  return parseSnapshot({ format: 'polylinedb.snapshot', version: 1, issues: [{ ...issue, id: child, type: 'task' }, issue], comments: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', issue_id: child, body: 'original comment', created_at: '2021-02-03T04:05:06Z', created_by: 'original:commenter' }] });
}
function local() {
  const root = mkdtempSync(join(tmpdir(), 'pd-snapshot-'));
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const location = { directory: join(root, 'store'), cwd };
  initializeStore(location);
  const store = openStore(location);
  return { store, cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test('restore preserves all audit values and versions, replay is a no-op, later edits reject replay', async () => {
  const { store, cleanup } = local();
  try {
    const snapshot = fixture();
    assert.equal(store.importSnapshot(snapshot).result, 'imported');
    assert.equal(canonicalSnapshot(store.exportSnapshot()), canonicalSnapshot(snapshot));
    assert.equal(store.importSnapshot(snapshot).result, 'already_present');
    const rows = await store.db.batch([{ sql: 'SELECT parent_id FROM issues WHERE id = ?', params: [child] }]);
    assert.equal(rows[0]?.rows[0]?.parent_id, parent);
    await store.db.batch([{ sql: "UPDATE issues SET body = 'edited' WHERE id = ?", params: [child] }]);
    assert.throws(() => store.importSnapshot(snapshot), { code: 'destination_not_empty' });
    assert.equal(store.exportSnapshot().issues.find(issue => issue.id === child)?.body, 'edited');
  } finally { cleanup(); }
});
test('failed insertion rolls back every issue and comment', async () => {
  const { store, cleanup } = local();
  try {
    await store.db.batch([{ sql: "CREATE TRIGGER refuse_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'test failure'); END", params: [] }]);
    assert.throws(() => store.importSnapshot(fixture()), /test failure/);
    assert.equal(store.exportSnapshot().issues.length, 0);
    assert.equal(store.exportSnapshot().comments.length, 0);
    await store.db.batch([{ sql: 'DROP TRIGGER refuse_comment', params: [] }]);
    assert.equal(store.importSnapshot(fixture()).result, 'imported');
  } finally { cleanup(); }
});
test('readback mismatch rolls back the restoration', async () => {
  const { store, cleanup } = local();
  try {
    await store.db.batch([{ sql: "CREATE TRIGGER alter_body AFTER INSERT ON issues BEGIN UPDATE issues SET body = 'changed' WHERE id = NEW.id; END", params: [] }]);
    assert.throws(() => store.importSnapshot(fixture()), { code: 'invalid_store' });
    assert.equal(store.exportSnapshot().issues.length, 0);
  } finally { cleanup(); }
});
test('validation rejects malformed shape, versions, dates, parents and comments', () => {
  const base = fixture();
  const root = base.issues.find(issue => issue.id === parent)!;
  const bad: unknown[] = [
    { ...base, extra: true }, { ...base, version: 2 },
    { ...base, issues: [root, root] },
    { ...base, issues: [{ ...root, versions: { ...root.versions, body: 0 } }] },
    { ...base, issues: [{ ...root, created_at: '2020-02-30T01:00:00Z' }] },
    { ...base, issues: [{ ...root, created_at: '2020-01-01T24:00:00Z' }] },
    { ...base, issues: base.issues.filter(issue => issue.id === child) },
    { ...base, issues: base.issues.map(issue => ({ ...issue, type: 'task' })) },
    { ...base, comments: [...base.comments, ...base.comments] },
    { ...base, comments: [{ ...base.comments[0], issue_id: 'dddddddd-dddd-dddd-dddd-dddddddddddd' }] },
  ];
  for (const input of bad) assert.throws(() => parseSnapshot(input), { code: 'invalid_snapshot' });
});
test('canonical form ignores array order and label set order but retains metadata', () => {
  const snapshot = fixture();
  assert.equal(canonicalSnapshot(snapshot), canonicalSnapshot({ ...snapshot, issues: [...snapshot.issues].reverse().map(issue => ({ ...issue, labels: ['z', 'a', 'z'] })) }));
  assert.notEqual(canonicalSnapshot(snapshot), canonicalSnapshot({ ...snapshot, issues: snapshot.issues.map(issue => ({ ...issue, updated_by: 'another' })) }));
});
test('empty snapshots are repeatable and metadata-only differences reject restore', () => {
  const { store, cleanup } = local();
  try {
    const empty = parseSnapshot({ format: 'polylinedb.snapshot', version: 1, issues: [], comments: [] });
    assert.equal(store.importSnapshot(empty).result, 'already_present');
    const snapshot = fixture(); store.importSnapshot(snapshot);
    assert.throws(() => store.importSnapshot({ ...snapshot, issues: snapshot.issues.map(issue => ({ ...issue, created_by: 'changed' })) }), { code: 'destination_not_empty' });
    assert.equal(canonicalSnapshot(store.exportSnapshot()), canonicalSnapshot(snapshot));
  } finally { cleanup(); }
});
