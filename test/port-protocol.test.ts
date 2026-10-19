// Runs the port protocol of a split store through random interleavings, with the proposed rules and with each defect.
// The property and the injections share one explorer and one option set, so the passing run is the control for every injection.
import assert from 'node:assert/strict';
import test from 'node:test';
import { explore } from './fixtures/port-protocol-check.ts';
import { protocolRules } from './fixtures/port-protocol.ts';
import type { Rules } from './fixtures/port-protocol.ts';

const options = { cases: Number(process.env.PD_HEGEL_CASES ?? 100), seed: 20261019, steps: 60 };

type ProtocolDefect = { defect: string; rules: Partial<Rules>; failure: RegExp; through: RegExp };

const protocolDefects: readonly ProtocolDefect[] = [
  {
    defect: 'a restrictive change reaches its authority before the port',
    rules: { order: () => 'authority-first' },
    failure: /Safety A violated/,
    through: /(reopen|make task) i\d+ seq \d+ admitted \(authority first\)/,
  },
];

test('property: a split store keeps every port answer as strict as its issue authority', () => {
  const tally = explore(protocolRules, options);
  assert.equal(tally.get('resolve-unknown') ?? 0, 0, 'an age-out met a sequence its authority never admitted');
});

for (const { defect, rules, failure, through } of protocolDefects) {
  test(`port protocol model fails when ${defect}`, () => {
    assert.throws(() => explore({ ...protocolRules, ...rules }, options), (error: unknown) => {
      assert.ok(error instanceof Error, 'the model did not report a violation');
      assert.match(error.message, failure);
      assert.match(error.message, through);
      return true;
    });
  });
}
