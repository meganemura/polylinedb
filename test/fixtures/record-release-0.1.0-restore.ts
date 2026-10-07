// Records the release 0.1.0 restore of one snapshot 3 input, by running that release's operator from the v0.1.0 tag.
// Tests replay the recorded writes, because shallow CI checkouts have no tags. Run: node test/fixtures/record-release-0.1.0-restore.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const output = fileURLToPath(new URL('release-0.1.0-restore.json', import.meta.url));
const release = mkdtempSync(join(tmpdir(), 'pd-release-0.1.0-'));
try {
  execFileSync('sh', ['-c', `git -C "$1" archive v0.1.0 src scripts | tar -x -C "$2"`, 'archive', repository, release]);
  symlinkSync(join(repository, 'node_modules'), join(release, 'node_modules'));
  const load = (path: string) => import(pathToFileURL(join(release, path)).href);
  const { snapshotMigration } = await load('scripts/d1-snapshot-store.ts');
  const { canonicalSnapshot, parseSnapshot } = await load('src/snapshot.ts');
  const { parseOperation } = await load('src/issues.ts');
  const { parseMemoryOperation } = await load('src/memories.ts');
  const { SCHEMA_SQL } = await load('src/schema.ts');

  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const versions = (changed: Partial<Record<string, number>> = {}) => ({ labels: 1, priority: 1, type: 1, status: 1, body: 1, project: 1, tool: 1, ...changed });
  const created = (request: number, prefix: string, extra: Record<string, unknown>) => JSON.stringify(parseOperation({ op: 'create', prefix, request_id: uuid(request), tool: 'legacy-tool', project: 'legacy', ...extra }));
  const memoryCreated = (request: number, project: string, title: string, body: string) => JSON.stringify(parseMemoryOperation({ op: 'memory_create', project, prefix: 'old', request_id: uuid(request), title, body }));
  // Rows and keys are out of canonical order, so the recorded digest proves the sort as well as the field form.
  const input = {
    memory_requests: [
      { memory_id: 'old-m3', payload: memoryCreated(13, 'other', 'third', 'other project memory'), actor: 'memory-author', request_id: uuid(13) },
      { request_id: uuid(11), actor: 'memory-author', payload: memoryCreated(11, 'legacy', 'first', 'first legacy memory'), memory_id: 'old-m1' },
      { request_id: uuid(12), actor: 'memory-editor', payload: memoryCreated(12, 'legacy', 'second', 'second legacy memory'), memory_id: 'old-m2' },
    ],
    version: 3,
    issues: [
      { updated_by: 'editor', id: 'old-2', tool: 'legacy-tool', project: 'legacy', body: 'legacy bug 日本語', status: 'in_progress', type: 'bug', priority: 0, labels: ['b-label', 'a-label'], versions: versions({ status: 2, labels: 3 }), created_at: '2026-01-02T00:00:00.000Z', created_by: 'author', updated_at: '2026-01-03T10:00:00.5+09:00' },
      { id: 'old-1.1', tool: 'legacy-tool', project: 'legacy', body: 'legacy child', status: 'open', type: 'task', priority: 2, labels: [], versions: versions(), created_at: '2026-01-01T01:00:00.000Z', created_by: 'author', updated_at: '2026-01-01T01:00:00.000Z', updated_by: 'author' },
      { id: 'old-1', tool: 'legacy-tool', project: 'legacy', body: 'legacy epic', status: 'open', type: 'epic', priority: 1, labels: ['epic'], versions: versions({ body: 2 }), created_at: '2026-01-01T00:00:00.000Z', created_by: 'author', updated_at: '2026-01-04T00:00:00Z', updated_by: 'editor' },
    ],
    format: 'polylinedb.snapshot',
    comments: [
      { id: uuid(22), issue_id: 'old-1', body: 'second comment', created_at: '2026-01-05T00:00:00.000Z', created_by: 'commenter' },
      { created_by: 'commenter', created_at: '2026-01-04T00:00:00.000Z', body: 'first comment', issue_id: 'old-2', id: uuid(21) },
    ],
    counters: [{ scope: 'old-1', last_number: 1 }, { last_number: 2, scope: 'old' }],
    requests: [
      { request_id: uuid(3), actor: 'author', payload: created(3, 'old', { parent: 'old-1', body: 'legacy child' }), issue_id: 'old-1.1' },
      { request_id: uuid(2), actor: 'author', payload: created(2, 'old', { body: 'legacy bug', type: 'bug' }), issue_id: 'old-2' },
      { request_id: uuid(1), actor: 'author', payload: created(1, 'old', { body: 'legacy epic', type: 'epic' }), issue_id: 'old-1' },
    ],
    memories: [
      { id: 'old-m2', project: 'legacy', title: 'second', body: 'second legacy memory, edited', version: 2, created_at: '2026-01-06T00:00:00.000Z', created_by: 'memory-editor', updated_at: '2026-01-07T00:00:00.000Z', updated_by: 'memory-editor' },
      { id: 'old-m3', project: 'other', title: 'third', body: 'other project memory', version: 1, created_at: '2026-01-06T00:00:00.000Z', created_by: 'memory-author', updated_at: '2026-01-06T00:00:00.000Z', updated_by: 'memory-author' },
      { id: 'old-m1', project: 'legacy', title: 'first', body: 'first legacy memory', version: 1, created_at: '2026-01-05T00:00:00.000Z', created_by: 'memory-author', updated_at: '2026-01-05T00:00:00.000Z', updated_by: 'memory-author' },
    ],
    memory_counters: [{ prefix: 'old', last_number: 3 }],
  };
  const sha256 = (await import('node:crypto')).createHash('sha256').update(canonicalSnapshot(parseSnapshot(input))).digest('hex');

  const database = new DatabaseSync(':memory:');
  database.exec(SCHEMA_SQL);
  const writes: { sql: string; params: unknown[] }[] = [];
  const query = async ({ sql, params }: { sql: string; params: unknown[] }) => {
    if (!/^\s*SELECT/i.test(sql)) writes.push({ sql, params });
    return database.prepare(sql).all(...(params as never[])).map(row => ({ ...row }));
  };
  const result = await snapshotMigration(query, input, sha256).restore();
  if (result.result !== 'restored') throw new Error(`The release 0.1.0 restore returned ${result.result}`);
  writeFileSync(output, `${JSON.stringify({ schema_sql: SCHEMA_SQL, input, sha256, writes }, null, 2)}\n`);
  process.stdout.write(`Recorded ${writes.length} release 0.1.0 restore writes for ${sha256}\n`);
} finally { rmSync(release, { recursive: true, force: true }); }
