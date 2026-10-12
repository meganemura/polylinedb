// Pins which body line a /ui row and the issue page use as the title.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyAfterTitle, title } from '../src/service/ui.ts';

test('a first line that is only an owner marker gives way to the next non-empty line', () => {
  const cases: [string, string, string][] = [
    ['要対応（owner-action）\nChoose which hosts connect\nDetails', 'Choose which hosts connect', '要対応（owner-action）\nDetails'],
    ['判断待ち(owner-decision)\nPick a name', 'Pick a name', '判断待ち(owner-decision)'],
    ['# 判断待ち（owner-decision）\n## Decide the cache policy\nBody', 'Decide the cache policy', '# 判断待ち（owner-decision）\nBody'],
    ['要対応（owner-action）。\nRotate the key', 'Rotate the key', '要対応（owner-action）。'],
    ['\n要対応（owner-action）\n\n\n  Run the migration  \nThen verify', 'Run the migration', '要対応（owner-action）\nThen verify'],
  ];
  for (const [body, expectedTitle, expectedBody] of cases) {
    assert.equal(title(body), expectedTitle, body);
    assert.equal(bodyAfterTitle(body), expectedBody, body);
  }
});

test('a marker-only body keeps the marker, and an ordinary first line is unchanged', () => {
  assert.equal(title('要対応（owner-action）\n\n'), '要対応（owner-action）');
  assert.equal(bodyAfterTitle('要対応（owner-action）\n\n'), '\n');
  assert.equal(title('# Ordinary title\nBody'), 'Ordinary title');
  assert.equal(bodyAfterTitle('# Ordinary title\nBody'), 'Body');
  assert.equal(title('オーナー作業: 鍵を更新する\n要対応（owner-action）'), 'オーナー作業: 鍵を更新する');
  assert.equal(title('Owner action: rotate the key'), 'Owner action: rotate the key');
  assert.equal(title('要対応（owner-action） please\nNext'), '要対応（owner-action） please');
});
