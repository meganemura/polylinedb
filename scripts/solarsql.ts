// Derives analysis DDL from the initialized schema; it never opens a user's store.
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from '../src/schema.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) throw new Error('Usage: node scripts/solarsql.ts [--check]');
const directory = mkdtempSync(join(tmpdir(), 'polylinedb-sql-'));
const database = new DatabaseSync(':memory:');
try {
  database.exec(SCHEMA_SQL);
  const ddl = database.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
  const schema = join(directory, 'schema.sql');
  writeFileSync(schema, ddl.map(row => row.sql).join(';\n') + ';\n');
  const result = spawnSync(process.execPath, [join(root, 'node_modules/solarsql/dist/build/cli.js'), 'analyze', schema,
    join(root, 'src/issue-queries.json'), '--out', join(root, 'src/solarsql.generated.ts'), ...args], { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr + result.stdout);
    process.exitCode = result.status ?? 1;
  } else {
    process.stdout.write(`solarsql queries ${args.length ? 'current' : 'generated'}\n`);
  }
} finally {
  database.close();
  rmSync(directory, { recursive: true, force: true });
}
