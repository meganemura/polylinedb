# Restore a local snapshot into D1

The repository operator command restores snapshot v2 into a new D1 database. It preserves issues, comments, counters, create requests, field versions, and audit fields. Ordinary `pd` commands continue to use SQLite.

## Prepare the transfer

Keep the destination unbound to Workers during the transfer. Other writers must remain stopped until verification and cutover finish. The importer does not lock out arbitrary SQL clients.

Export the source with `pd export --file SNAPSHOT`. Keep the snapshot outside Git in a private directory. Export uses a consistent SQLite transaction. Stop source writers before the final export if this snapshot will become the active cloud store.

Provision the destination with the SQL emitted by `node scripts/schema.ts`. The importer requires the canonical schema, including its stored SQL definitions. Equivalent custom DDL is refused. The operator command does not create databases or change Worker bindings.

Create a target file with mode 0600 outside Git checkouts. Environment-specific identifiers, snapshots, and receipts must stay outside the repository. Create the target file with these fields:

```json
{
  "profile": "migration",
  "accountId": "ACCOUNT_ID",
  "databaseId": "DATABASE_UUID",
  "snapshotSha256": "CANONICAL_SNAPSHOT_SHA256",
  "schemaVersion": 2
}
```

Use the SHA-256 reported by `pd export`. Authenticate the named profile through `cf auth` separately. Credentials do not belong in the target file. Review the account, database, snapshot digest, and destination isolation before approving a restore.

```sh
node scripts/d1-snapshot.ts inspect --snapshot SNAPSHOT --target TARGET
node scripts/d1-snapshot.ts restore --snapshot SNAPSHOT --target TARGET
node scripts/d1-snapshot.ts verify --snapshot SNAPSHOT --target TARGET
```

The field order in the command is fixed. `inspect` reads the destination. `restore` writes the snapshot claim and missing rows. `verify` reads all four collections and compares their canonical representation with the input. Each command prints a receipt with target identity, counts, and digest. The receipt excludes snapshot content.

## Recovery

A destination can be empty, identical, or a matching partial restore. A partial restore requires the durable `polylinedb_snapshot_claim` row with the same digest. Existing rows must exactly match expected rows, including derived parent IDs and sort keys. Different rows, unrelated rows, another digest, and partial data without a claim are refused.

Repeat the same restore command after an interruption. Inserts use bound parameters and never replace existing rows. The importer checks the claim with every insert. A request can commit before its response disappears; the next run reads the actual destination before it continues. The claim remains as provenance after success.

Keep the target file and source snapshot unchanged across retries. A changed source snapshot needs a new destination. After remote verification, keep the source backup and receipt. Obtain approval before binding or deploying the production Worker.

## Transport and limits

The command uses `cf d1 query DATABASE_UUID --profile PROFILE --batch @FILE`. Each request contains one bound statement. Temporary files have mode 0600 inside private temporary directories and are removed after success or failure. The child process receives a fixed `CLOUDFLARE_ACCOUNT_ID`. Ambient API-token variables are removed so the named profile owns authentication. Child stderr is not copied into operator output.

The cf 0.15.0 implementation resolves `CLOUDFLARE_ACCOUNT_ID` before project settings. Its query handler passes the resolved account and database UUID to the API. Its output formatter preserves API envelopes, except that it unwraps result arrays with `result_info`. The importer checks both supported output shapes and every statement success value. This behavior was checked against the installed CLI implementation.

A local probe of cf 0.15.0 reported that its explorer API does not implement the D1 query endpoint. Workerd tests therefore use the real D1 binding directly. They prove database behavior; they do not prove production authentication or the live CLI response. A disposable remote probe remains required before production use.

D1 permits 100 bound parameters and 100,000 SQL bytes per statement. The whole API batch has a 30-second deadline. Bound values keep large UTF-8 bodies outside SQL text. The operator limits encoded rows to 1,900,000 bytes and reads one row per page. This favors bounded requests over transfer speed. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Verification

```sh
node --test test/d1-snapshot.test.ts
node test/d1-snapshot.integration.ts
```

The integration test requires the same external Miniflare installation used by `test/d1.integration.ts`. An optional module path can be passed as its first argument.

The tests cover committed-response-loss recovery, duplicate and concurrent restores, conflicting claims and rows, corrupt sort keys, a 64 KiB Unicode body, field versions, audit fields, comments, counters, and create requests. They compare the D1 snapshot with a fresh SQLite import/export. They also verify request replay and subsequent root and child IDs. Transport tests inspect fixed account/profile arguments, bound values, private file permissions, cleanup, and sanitized failures.

For a release acceptance run, import the D1-read snapshot into a fresh SQLite store through the installed tarball and compare its export. Keep that result separate from source-tree test results. Production credentials, a live remote transfer, and Worker cutover require their own verification and approval.
