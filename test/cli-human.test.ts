// Verifies issue presentation without storage, credentials, or command adapters.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Comment, Issue, MemoryFreshness } from '../src/records/index.ts';
import { renderHumanIssueRead } from '../src/cli-human.ts';

const issue: Issue = {
  id: 'pd-17',
  tool: 'compiler',
  project: 'parser',
  body: 'Failure when parsing empty input',
  status: 'open',
  type: 'bug',
  priority: 2,
  labels: ['human', 'urgent'],
  versions: { tool: 1, project: 2, body: 3, status: 4, type: 5, priority: 6, labels: 7 },
  created_at: '2026-10-06T01:02:03.000Z',
  created_by: 'Megan',
  updated_at: '2026-10-06T02:03:04.000Z',
  updated_by: 'codex',
};
const plainTerminal = { stdoutIsTTY: false, env: {} } as const;

function renderPage(
  command: 'list' | 'search',
  issues: Issue[],
  next_cursor: string | null,
  freshness?: MemoryFreshness,
  terminal: typeof plainTerminal = plainTerminal,
): string {
  return renderHumanIssueRead({
    command,
    result: { issues, next_cursor, ...(freshness === undefined ? {} : { memory_freshness: freshness }) },
  }, terminal);
}

function renderShow(
  record: Issue,
  comments: Comment[],
  freshness?: MemoryFreshness,
  terminal: typeof plainTerminal = plainTerminal,
): string {
  return renderHumanIssueRead({
    command: 'show',
    result: { issue: record, comments, ...(freshness === undefined ? {} : { memory_freshness: freshness }) },
  }, terminal);
}

test('empty pages and cursor pages use complete literal output', () => {
  assert.equal(renderPage('list', [], null), 'Issues\nNo issues found.');
  assert.equal(renderPage('search', [], null), 'Search matches\nNo search matches found.');
  assert.equal(
    renderPage('search', [{ ...issue, body: '' }], 'pd-18 "next page"'),
    'Search matches\npd-17  open  P2  bug\n  Project: parser · Tool: compiler\n  Body: (empty)\n\nMore results. Use this value with --after.\n  pd-18 "next page"',
  );
});

test('show renders every issue field and full Japanese comment bodies without a final newline', () => {
  const record: Issue = { ...issue, body: '入力が空です\n次の行です' };
  const comments: Comment[] = [
    {
      id: 'c-1', issue_id: 'pd-17', body: '入力条件を確認しました。\n次の手順へ進みます。',
      created_at: '2026-10-06T03:04:05.000Z', created_by: '玲奈',
    },
    {
      id: 'c-2', issue_id: 'pd-17', body: '再現しました。',
      created_at: '2026-10-06T04:05:06.000Z', created_by: 'Sam',
    },
  ];
  const before = structuredClone({ record, comments });
  assert.equal(
    renderShow(record, comments),
    'Issue details\nID pd-17\nStatus open\nPriority P2\nType bug\nTool compiler\nProject parser\nLabels human, urgent\nVersions tool=1 project=2 body=3 status=4 type=5 priority=6 labels=7\nCreated 2026-10-06T01:02:03.000Z by Megan\nUpdated 2026-10-06T02:03:04.000Z by codex\nBody\n  入力が空です\n  次の行です\nComments (2)\n  c-1 · pd-17 · 2026-10-06T03:04:05.000Z · 玲奈\n    入力条件を確認しました。\n    次の手順へ進みます。\n  c-2 · pd-17 · 2026-10-06T04:05:06.000Z · Sam\n    再現しました。',
  );
  assert.deepEqual({ record, comments }, before);
});

test('control characters and Unicode separators stay visible outside body line feeds', () => {
  const record: Issue = {
    ...issue,
    id: 'pd-\u0000\u0001\u001b\u0085\u007f\u2028\u2029',
    tool: 'tool\u0007',
    project: 'scope\u001b\u0000',
    labels: ['label\u009b'],
    created_by: 'writer\u0001',
    body: 'C0:\u0000 ESC:\u001b[31m C1:\u0085 DEL:\u007f LS:\u2028 PS:\u2029\nnext\u000d',
  };
  const comments: Comment[] = [{
    id: 'c-\u009b', issue_id: 'pd-17', body: 'reply\u001b[2J\u0085\u007f\u0001\u2028\u2029\nnext\u000b',
    created_at: '2026-10-06T03:04:05.000Z', created_by: 'reader\u009f',
  }];
  assert.equal(
    renderShow(record, comments),
    String.raw`Issue details
ID pd-\u0000\u0001\u001B\u0085\u007F\u2028\u2029
Status open
Priority P2
Type bug
Tool tool\u0007
Project scope\u001B\u0000
Labels label\u009B
Versions tool=1 project=2 body=3 status=4 type=5 priority=6 labels=7
Created 2026-10-06T01:02:03.000Z by writer\u0001
Updated 2026-10-06T02:03:04.000Z by codex
Body
  C0:\u0000 ESC:\u001B[31m C1:\u0085 DEL:\u007F LS:\u2028 PS:\u2029
  next\u000D
Comments (1)
  c-\u009B · pd-17 · 2026-10-06T03:04:05.000Z · reader\u009F
    reply\u001B[2J\u0085\u007F\u0001\u2028\u2029
    next\u000B`,
  );
});

test('list bounds previews to forty code points and show retains the complete body', () => {
  const body = '123456789012345678901234567890123456789😀rest';
  const record: Issue = { ...issue, body };
  assert.equal(
    renderPage('list', [record], null),
    'Issues\npd-17  open  P2  bug\n  Project: parser · Tool: compiler\n  Body: 123456789012345678901234567890123456789😀…\n\nEnd of results.',
  );
  assert.equal(
    renderShow(record, []),
    'Issue details\nID pd-17\nStatus open\nPriority P2\nType bug\nTool compiler\nProject parser\nLabels human, urgent\nVersions tool=1 project=2 body=3 status=4 type=5 priority=6 labels=7\nCreated 2026-10-06T01:02:03.000Z by Megan\nUpdated 2026-10-06T02:03:04.000Z by codex\nBody\n  123456789012345678901234567890123456789😀rest\nComments (0)',
  );
});

test('color applies only to fixed headings when stdout is a color-capable terminal', () => {
  const input = { command: 'list' as const, result: { issues: [] as Issue[], next_cursor: null } };
  const render = (terminal: { stdoutIsTTY: boolean; env: Readonly<Record<string, string | undefined>> }) =>
    renderHumanIssueRead(input, terminal);
  const plain = 'Issues\nNo issues found.';
  const colored = '\u001B[1;36mIssues\u001B[0m\nNo issues found.';
  assert.equal(render({ stdoutIsTTY: true, env: {} }), colored);
  assert.equal(render({ stdoutIsTTY: true, env: { TERM: 'xterm-256color' } }), colored);
  assert.equal(render({ stdoutIsTTY: true, env: { NO_COLOR: '' } }), plain);
  assert.equal(render({ stdoutIsTTY: true, env: { NO_COLOR: undefined } }), plain);
  assert.equal(render({ stdoutIsTTY: true, env: { TERM: 'dumb' } }), plain);
  assert.equal(render({ stdoutIsTTY: false, env: {} }), plain);
});

test('issue reads preserve current, stale, and unavailable memory freshness advisories', () => {
  const current: MemoryFreshness = { status: 'current', project: 'parser' };
  const stale: MemoryFreshness = { status: 'stale', project: 'parser', reason: 'memory_changed' };
  const unavailable: MemoryFreshness = { status: 'unavailable', project: 'parser' };

  assert.equal(
    renderPage('list', [issue], null, current),
    'Issues\nMemory freshness: current · project parser\npd-17  open  P2  bug\n  Project: parser · Tool: compiler\n  Body: Failure when parsing empty input\n\nEnd of results.',
  );
  assert.equal(
    renderShow(issue, [], stale),
    'Issue details\nMemory freshness: stale · project parser · memory changed\nRetrieve project memory before acting.\nID pd-17\nStatus open\nPriority P2\nType bug\nTool compiler\nProject parser\nLabels human, urgent\nVersions tool=1 project=2 body=3 status=4 type=5 priority=6 labels=7\nCreated 2026-10-06T01:02:03.000Z by Megan\nUpdated 2026-10-06T02:03:04.000Z by codex\nBody\n  Failure when parsing empty input\nComments (0)',
  );
  assert.equal(
    renderPage('search', [issue], null, unavailable),
    'Search matches\nMemory freshness: unavailable · project parser\nRetrieve project memory before acting.\npd-17  open  P2  bug\n  Project: parser · Tool: compiler\n  Body: Failure when parsing empty input\n\nEnd of results.',
  );
});
