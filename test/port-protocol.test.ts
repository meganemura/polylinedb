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
  {
    defect: 'an abort row releases the reservation in any state',
    rules: { afterAbort: () => ({ state: 'released' }) },
    failure: /Safety B violated[^\n]*claim request c\d/,
    through: /reservation c\d (bound to i\d+|opened by another nonce) -> released/,
  },
  {
    defect: 'a blocker reopens while a dependent holds the answer that it is closed',
    rules: { holdsAnswer: () => false },
    // The answer reliance lasts from the dependent's admission until its row, which comes after its close commits,
    // so Safety A fires when the blocker reopens, at least one step before the close witness can.
    failure: /Safety A violated[^\n]*\(answer to i\d+ at seq \d+\)/,
    through: /reopen i\d+ seq \d+ admitted|edge i\d+ -> i\d+ added/,
  },
  {
    defect: 'a rotated port still admits what a stale Worker instance routes to it',
    rules: { admits: () => true },
    // The stale port answers from its own copy, so each invariant can fire, and only the mechanism is pinned.
    failure: /(Safety [AB]|Close witness) violated/,
    through: /by a rotated port/,
  },
  {
    defect: 'an empty object builds its authority from a receipt that names another incarnation',
    rules: { origin: () => ({ from: 'receipt' }) },
    failure: /Safety A violated/,
    through: /created from a receipt naming another incarnation/,
  },
];

test('property: a split store keeps every port answer as strict as its issue authority and one receipt per request ID', () => {
  const tally = explore(protocolRules, { ...options, database: '.hegel/port-protocol/property' });
  assert.equal(tally.get('resolve-unknown') ?? 0, 0, 'an age-out met a sequence its authority never admitted');
});

for (const { defect, rules, failure, through } of protocolDefects) {
  test(`port protocol model fails when ${defect}`, () => {
    const database = `.hegel/port-protocol/${Object.keys(rules).join('-')}`;
    assert.throws(() => explore({ ...protocolRules, ...rules }, { ...options, database }), (error: unknown) => {
      assert.ok(error instanceof Error, 'the model did not report a violation');
      assert.match(error.message, failure);
      assert.match(error.message, through);
      return true;
    });
  });
}
