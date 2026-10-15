import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { failsChangeFeedContract, feedDefects } from './fixtures/change-feed-defects.ts';

for (const { defect, failure } of feedDefects) {
  test(`change feed contract fails on ${defect}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pd-feed-defect-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const place = { directory: join(root, 'store'), cwd: join(root, 'work') };
    initializeStore(place);
    const opened = openStore(place);
    try { await failsChangeFeedContract(opened.db, defect, failure); }
    finally { opened.close(); }
  });
}
