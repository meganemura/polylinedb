// Names the storage port every record command writes through; adapters supply the database.
import type { Database } from 'solarsql';

export type SqlStatement = { sql: string; params: readonly (string | number | null)[] };
export type SqlExecutor = {
  reads: Pick<Database, 'all'>;
  batch(statements: readonly SqlStatement[]): Promise<readonly { rows: readonly Record<string, unknown>[] }[]>;
};
