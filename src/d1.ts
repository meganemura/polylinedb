// Adapts D1 batches to the shared executor; it does not own SQL or transaction policy.
import type { SqlExecutor } from './issues.ts';

export type D1PreparedLike = {
  bind(...values: (string | number | null)[]): D1PreparedLike;
};
export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedLike;
  batch(statements: D1PreparedLike[]): Promise<readonly { results: Record<string, unknown>[]; success?: boolean; error?: string }[]>;
};
export function d1Executor(database: D1DatabaseLike): SqlExecutor {
  return {
    async batch(statements) {
      const results = await database.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...params)));
      return results.map((result) => {
        if (result.success === false) throw new Error(result.error ?? 'D1 batch failed');
        return { rows: result.results };
      });
    },
  };
}
