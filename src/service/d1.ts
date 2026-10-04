// Connects generated reads and atomic write batches to D1; domain modules own operation rules.
import type { SqlExecutor } from "../records/persistence.ts";
import { d1 } from 'solarsql/d1';
import type { D1Like } from 'solarsql/d1';

export type D1DatabaseLike = D1Like;
export function d1Executor(database: D1DatabaseLike): SqlExecutor {
  return {
    reads: d1(database),
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
