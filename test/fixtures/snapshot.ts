// Compares contract text with a committed snapshot; UPDATE_SNAPSHOTS=1 rewrites the file instead of comparing.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

export function assertSnapshot(name: string, actual: string): void {
  const file = new URL(`../snapshots/${name}`, import.meta.url);
  if (process.env.UPDATE_SNAPSHOTS === '1') { writeFileSync(file, actual); return; }
  assert.equal(actual, readFileSync(file, 'utf8'), `${name} differs; review the change, then rerun with UPDATE_SNAPSHOTS=1`);
}
