# Debugging a test failure with depug

[depug](https://github.com/meganemura/depug) reruns one test with instrumentation and reports the values that the code actually received and returned.
This page records one complete diagnosis on polylinedb: the reproduction, the debugger observations, the root cause, and the verification command.
The fault was injected on purpose into a disposable copy of the source tree. No commit contains it.
The test that exposed it is part of the suite.

Environment: Node 26.7.0 and polylinedb 0.3.1.
The first pass used a local build of the depug repository at version 0.1.3.
The `preflight`, `frames`, `probe`, and `exec` steps then ran again with depug 0.1.3 from npm and gave the same values.

## Supported runtime and interface

depug supports vitest and `node --test`. polylinedb uses `node --test`, so no configuration change is necessary.
For `node --test`, depug sets `NODE_OPTIONS` to load a module hook into each test process.
The hook rewrites TypeScript under `src/`, which is the depug default and matches this repository.
Test files are never instrumented.

Every verb takes the test command after `--`:

```sh
npx @meganemura/depug@0.1.3 preflight -- node --test --test-name-pattern='^NAME$' test/FILE.test.ts
```

Choose a test that calls the store in its own process.
`NODE_OPTIONS` also reaches child processes. A test that starts the `pd` CLI as a child and parses its stdout as JSON can fail under depug, because the child process prints the node:test summary into that stdout.
The tests in `test/dependency-persistence.test.ts`, `test/issues.test.ts`, and `test/snapshot.test.ts` call the store directly.

## The fault

The local store builds its export with `parseSnapshot`, which sorts each collection into a canonical order.
Issue IDs sort by number, so `pd-9` comes before `pd-10`. `issueSortKey` pads each number to make text order equal number order.
The injected fault removed `issueSortKey` from the second key of the dependency sort in `src/records/snapshot.ts`:

```diff
-    }).sort((a, b) => compareText(issueSortKey(a.dependent_id), issueSortKey(b.dependent_id)) || compareText(issueSortKey(a.blocker_id), issueSortKey(b.blocker_id)));
+    }).sort((a, b) => compareText(issueSortKey(a.dependent_id), issueSortKey(b.dependent_id)) || compareText(a.blocker_id, b.blocker_id));
```

With this fault, 312 of the 313 unit tests passed in the copy. The one failure was `test/skill-contract.test.ts`, because the copy did not include `skills/`.
The graph roundtrip test gives `pd-1` the blockers `pd-2` and `pd-10`, but it compares two exports with each other, and both exports had the same wrong order.

## Reproduction

The test `export lists the blockers of one dependent in issue number order` creates ten issues, adds `pd-10` and then `pd-9` as blockers of `pd-1`, and compares the exported dependencies with a literal list.
On the faulted copy it fails:

```text
✖ export lists the blockers of one dependent in issue number order (15.886542ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected

    [
      {
  +     blocker_id: 'pd-10',
  -     blocker_id: 'pd-9',
        dependent_id: 'pd-1'
      },
      {
  +     blocker_id: 'pd-9',
  -     blocker_id: 'pd-10',
        dependent_id: 'pd-1'
      }
    ]
```

With the depug node:test reporter from the local build, the failure also wrote an evidence file.
The reporter classified the failure as `the value's source already returned; rerun to reach it`.
The assertion sees the export after `parseSnapshot` has returned, so the stack at the failure cannot show the cause.

## Debugger observations

Each command below ran with `-- node --test --test-name-pattern='^export lists the blockers' test/dependency-persistence.test.ts` after it.

1. `preflight` gave different results in different runs.
   One run reported `deterministic (app calls: 3236)`. Another run reported `first divergence at call 2812`.
   The two indexes separate inside the comparator at `src/records/snapshot.ts:89`, which sorts creation requests by request ID.
   The test creates random request IDs, so that sort calls its comparator a different number of times in each run.
   A call index counts the calls of one function. The calls used below kept the same index, `#1`, in every run.
2. `frames --at src/local-store/index.ts:196` named the export function that ran: `src/local-store/index.ts:readSnapshot@196:9#1`.
   The frames index showed one call of the dependency sort comparator, `src/records/snapshot.ts:<anonymous>@172:13#1`, inside `parseSnapshotV4@153:10#1`.
3. `probe "src/records/snapshot.ts:<anonymous>@169:36"` showed the rows that the store read, before the sort: `pd-10`, then `pd-9`.
4. `probe "src/records/snapshot.ts:<anonymous>@172:13"` showed the comparator decision:

   ```text
   src/records/snapshot.ts:<anonymous>@172:13  calls: 1, threw: 0
     a: {dependent_id: "pd-1", blocker_id: "pd-9"}
     b: {dependent_id: "pd-1", blocker_id: "pd-10"}
     returns: 1
   ```

   A positive result puts `pd-9` after `pd-10`. The comparator kept the wrong order of the input.
5. In the frames index, that comparator call made two `compareText` calls but only two `issueSortKey` calls. Padded keys for both the dependents and the blockers need four.
   So one of the two comparisons received unpadded IDs.
6. `exec "src/records/snapshot.ts:parseSnapshotV4@153:10#1" --line 173` evaluated an expression after the sort, in the scope of that call:

   ```sh
   --statement "[dependencies.map(e => e.blocker_id), compareText('pd-9', 'pd-10'), compareText(issueSortKey('pd-9'), issueSortKey('pd-10'))]"
   ```

   ```text
   depug value: [["pd-10","pd-9"],1,-1]
   ```

## Root cause

The dependency comparator compares blocker IDs as plain text.
Text order puts `pd-10` before `pd-9`, because the character `1` comes before `9`.
The sort keys from `issueSortKey` give the opposite result, which is the number order.
The fix restores `issueSortKey` on both sides of the second comparison.

## Verification

After the removal of the fault, the copy had the same `src/` as the branch.
The same test passed through the same public operation, the store export that `pd export` uses:

```sh
npx @meganemura/depug@0.1.3 rerun -- node --test --test-name-pattern='^export lists the blockers' test/dependency-persistence.test.ts
```

```text
✔ export lists the blockers of one dependent in issue number order (16.890916ms)
ℹ pass 1
ℹ fail 0
```

## Notes for the next diagnosis

- Give the test command to depug as separate arguments. In zsh, an unquoted `$CMD` is one argument, and depug then reports zero calls instead of a launch failure.
- `flt` cannot follow a function whose body is a single expression, such as a sort comparator. `exec` in the enclosing function, at the next statement, reads the same values.
- `probe` keeps ten samples for each parameter. For a later call, use `frames` to find its index, then `exec` or `flt` on that call.
- A `deterministic` result from one `preflight` run does not prove that the next run agrees. Here the total call count changed between 3232 and 3238, and `compareText` changed between 43 and 45 calls. Do not address `compareText` by call index in this test.
