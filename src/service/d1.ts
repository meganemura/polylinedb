// Connects generated reads and atomic write batches to D1; domain modules own operation rules.
import type { SqlExecutor } from "../records/persistence/persistence.ts";
import { d1 } from 'solarsql/d1';
import type { D1Like, D1StatementLike } from 'solarsql/d1';

export type D1DatabaseLike = D1Like;
export function d1Executor(database: D1DatabaseLike): SqlExecutor {
  const trip = sharedTrip(database);
  return {
    reads: d1(trip),
    async batch(statements) {
      const results = await trip.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...params)));
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
type Waiting = { statements: D1StatementLike[]; resolve: (results: StatementResult[]) => void; reject: (error: unknown) => void };

// Each D1 call is a round trip, and on the deployed Worker a page's time grew with its number of calls even though
// its reads started together. Statements and batches started before the next macrotask therefore share one call.
// D1 runs a batch as one transaction, so a failed call committed nothing and each part can run again on its own.
function sharedTrip(database: D1Like): D1Like {
  let waiting: Waiting[] = [];
  const inner = new WeakMap<D1StatementLike, D1StatementLike>();
  const alone = (entry: Waiting) => {
    const [only] = entry.statements;
    const answer = entry.statements.length === 1 && only !== undefined ? only.all().then(result => [result]) : database.batch(entry.statements);
    answer.then(entry.resolve, entry.reject);
  };
  const flush = async () => {
    const group = waiting;
    waiting = [];
    if (group.length === 1) return alone(group[0]!);
    try {
      const results = await database.batch(group.flatMap(entry => entry.statements));
      let at = 0;
      for (const entry of group) { entry.resolve(results.slice(at, at + entry.statements.length)); at += entry.statements.length; }
    } catch {
      // A failed batch names no statement, so each part runs alone and gets its own answer.
      group.forEach(alone);
    }
  };
  const enqueue = (statements: D1StatementLike[]) => new Promise<StatementResult[]>((resolve, reject) => {
    if (waiting.length === 0) setTimeout(flush, 0);
    waiting.push({ statements, resolve, reject });
  });
  const wrap = (statement: D1StatementLike): D1StatementLike => {
    const wrapped: D1StatementLike = {
      bind: (...values) => wrap(statement.bind(...values)),
      all: async () => (await enqueue([statement]))[0]!,
    };
    inner.set(wrapped, statement);
    return wrapped;
  };
  return { prepare: sql => wrap(database.prepare(sql)), batch: statements => enqueue(statements.map(statement => inner.get(statement) ?? statement)) };
}
