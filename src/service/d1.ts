// Connects generated reads and atomic write batches to D1; domain modules own operation rules.
import type { SqlExecutor } from "../records/persistence/persistence.ts";
import { d1 } from 'solarsql/d1';
import type { D1Like, D1StatementLike } from 'solarsql/d1';

export type D1DatabaseLike = D1Like;
export function d1Executor(database: D1DatabaseLike): SqlExecutor {
  return {
    reads: d1(sharedTrip(database)),
    async batch(statements) {
      const results = await database.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...params)));
      return results.map((result) => {
        if ('success' in result && result.success === false) throw new Error('D1 batch failed');
        if (!Array.isArray(result.results) || !result.results.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))) {
          throw new Error('D1 returned invalid statement rows');
        }
        return { rows: result.results };
      });
    },
  };
}

type StatementResult = Awaited<ReturnType<D1StatementLike['all']>>;
type Waiting = { statement: D1StatementLike; resolve: (result: StatementResult) => void; reject: (error: unknown) => void };

// Each D1 call is a round trip, and on the deployed Worker a page's time grew with its number of calls even though
// its reads started together. Reads started before the next macrotask therefore share one batch, one call.
function sharedTrip(database: D1Like): D1Like {
  let waiting: Waiting[] = [];
  const inner = new WeakMap<D1StatementLike, D1StatementLike>();
  const flush = async () => {
    const group = waiting;
    waiting = [];
    if (group.length === 1) {
      const only = group[0]!;
      only.statement.all().then(only.resolve, only.reject);
      return;
    }
    try {
      const results = await database.batch(group.map(entry => entry.statement));
      group.forEach((entry, index) => entry.resolve(results[index]!));
    } catch {
      // A failed batch names no statement, so each read runs alone and gets its own answer.
      for (const entry of group) entry.statement.all().then(entry.resolve, entry.reject);
    }
  };
  const wrap = (statement: D1StatementLike): D1StatementLike => {
    const wrapped: D1StatementLike = {
      bind: (...values) => wrap(statement.bind(...values)),
      all: () => new Promise<StatementResult>((resolve, reject) => {
        if (waiting.length === 0) setTimeout(flush, 0);
        waiting.push({ statement, resolve, reject });
      }),
    };
    inner.set(wrapped, statement);
    return wrapped;
  };
  return { prepare: sql => wrap(database.prepare(sql)), batch: statements => database.batch(statements.map(statement => inner.get(statement) ?? statement)) };
}
