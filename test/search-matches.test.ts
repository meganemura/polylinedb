// Exercises where a search hit matched, and its bounded excerpt, against a real SQLite store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOperation, parseOperation } from '../src/records/issues.ts';
import type { SqlExecutor } from '../src/records/issues.ts';
import { PolylinedbError } from '../src/records/errors.ts';
import { initializeStore, openStore } from '../src/local-store/index.ts';

function fixture(t: test.TestContext): SqlExecutor {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-search-'));
  const directory = join(root, 'store');
  const cwd = join(root, 'work');
  initializeStore({ directory, cwd });
  const store = openStore({ directory, cwd });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store.db;
}
const execute = (db: SqlExecutor, operation: unknown) => executeOperation(db, parseOperation(operation), 'tester');
// Comments created in the same millisecond order by ID, so callers read the stored order from show.
async function issueWith(db: SqlExecutor, body: string, comments: readonly string[] = []): Promise<{ id: string; comments: { id: string; body: string }[] }> {
  const created = await execute(db, { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body });
  assert.ok('issue' in created);
  for (const comment of comments) await execute(db, { op: 'comment', id: created.issue.id, body: comment });
  const shown = await execute(db, { op: 'show', id: created.issue.id });
  assert.ok('comments' in shown);
  return { id: created.issue.id, comments: shown.comments.map(({ id, body }) => ({ id, body })) };
}
async function matches(db: SqlExecutor, query: string) {
  const result = await execute(db, { op: 'search', query, with_matches: true });
  assert.ok('matches' in result);
  return result.matches;
}

test('search with matches names the body and each matching comment in issue and comment order', async (t) => {
  const db = fixture(t);
  const bodyOnly = await issueWith(db, 'needle in body');
  const commentOnly = await issueWith(db, 'plain', ['a needle here']);
  const both = await issueWith(db, 'body needle', ['first needle', 'no match', 'second needle\nline']);
  await issueWith(db, 'unrelated', ['nothing']);
  assert.deepEqual(await matches(db, 'needle'), [
    { issue_id: bodyOnly.id, location: 'body', excerpt: 'needle in body' },
    { issue_id: commentOnly.id, location: 'comment', comment_id: commentOnly.comments[0]?.id, excerpt: 'a needle here' },
    { issue_id: both.id, location: 'body', excerpt: 'body needle' },
    ...both.comments.filter(comment => comment.body !== 'no match').map(comment => ({ issue_id: both.id, location: 'comment', comment_id: comment.id,
      excerpt: comment.body === 'first needle' ? 'first needle' : 'second needle line' })),
  ]);
});

test('search without matches keeps the issue page shape and rejects a false opt-in', async (t) => {
  const db = fixture(t);
  await issueWith(db, 'plain', ['a needle here']);
  const result = await execute(db, { op: 'search', query: 'needle' });
  assert.deepEqual(Object.keys(result), ['issues', 'next_cursor']);
  assert.throws(() => parseOperation({ op: 'search', query: 'needle', with_matches: false }),
    (error: unknown) => error instanceof PolylinedbError && error.code === 'invalid_input' && error.message === 'with_matches must be true when present');
});

test('search excerpts stay within 160 UTF-8 bytes around the first match in a body or a comment', async (t) => {
  const db = fixture(t);
  const cases: [string, string, string][] = [
    ['middle', 'x'.repeat(300) + 'needle' + 'y'.repeat(300), '…' + 'x'.repeat(74) + 'needle' + 'y'.repeat(74) + '…'],
    ['start', 'needle' + 'y'.repeat(300), 'needle' + 'y'.repeat(148) + '…'],
    ['end', 'x'.repeat(300) + 'needle', '…' + 'x'.repeat(148) + 'needle'],
    ['multibyte', 'あ'.repeat(100) + 'needle' + '😀'.repeat(100), '…' + 'あ'.repeat(25) + 'needle' + '😀'.repeat(18) + '…'],
    ['first of two', 'one needle, two needle', 'one needle, two needle'],
    ['control characters', 'line\nneedle\tend\u0085', 'line needle end '],
  ];
  for (const [index, [name, text, expected]] of cases.entries()) {
    const marker = `MARK${index}Q`;
    const inBody = await issueWith(db, text.replaceAll('needle', marker));
    const inComment = await issueWith(db, 'comment holder', [text.replaceAll('needle', marker)]);
    const want = expected.replaceAll('needle', marker);
    const found = await matches(db, marker);
    assert.deepEqual(found, [
      { issue_id: inBody.id, location: 'body', excerpt: want },
      { issue_id: inComment.id, location: 'comment', comment_id: inComment.comments[0]?.id, excerpt: want },
    ], name);
    for (const match of found) {
      assert.ok(Buffer.byteLength(match.excerpt) <= 160, `${name} excerpt is ${Buffer.byteLength(match.excerpt)} bytes`);
      assert.doesNotMatch(match.excerpt, /\p{Cs}/u, `${name} excerpt keeps whole code points`);
      assert.doesNotMatch(match.excerpt, /\p{Cc}/u, `${name} excerpt has no control characters`);
    }
  }
});

test('search excerpts cut a match longer than the bound at a code point and mark both cuts', async (t) => {
  const db = fixture(t);
  const query = 'é'.repeat(100);
  const issue = await issueWith(db, 'start ' + query + ' end', ['before ' + query]);
  const excerpt = '…' + 'é'.repeat(77) + '…';
  assert.deepEqual(await matches(db, query), [
    { issue_id: issue.id, location: 'body', excerpt },
    { issue_id: issue.id, location: 'comment', comment_id: issue.comments[0]?.id, excerpt },
  ]);
});
