// Gives tests a D1 binding that reaches workerd over keep-alive connections.
// Miniflare's binding proxy sets `reset` on every runtime request, so each D1 call opens a new socket.
// A test with thousands of calls then fills the macOS ephemeral port range with TIME_WAIT sockets.
// The relay worker runs each call on the real binding; it does not emulate D1.

type Statement = { sql: string; params: unknown[] };
type Reply = { results: Record<string, unknown>[]; success: boolean; meta: unknown };
type Failure = { message: string; cause?: string; errcode?: number };

export const d1RelayModule = { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: `
export default {
  async fetch(request, env) {
    const { binding, statements, batch } = await request.json();
    const database = env[binding];
    const prepared = statements.map(({ sql, params }) => database.prepare(sql).bind(...params));
    try {
      return Response.json(batch ? await database.batch(prepared) : [await prepared[0].all()]);
    } catch (error) {
      const failure = { message: String(error?.message ?? error) };
      if (typeof error?.cause?.message === 'string') failure.cause = error.cause.message;
      if (typeof error?.errcode === 'number') failure.errcode = error.errcode;
      return Response.json(failure, { status: 500 });
    }
  },
};
` } } };

export type D1Relay = {
  prepare(sql: string): RelayStatement;
  batch(statements: RelayStatement[]): Promise<Reply[]>;
};
type RelayStatement = {
  bind(...params: unknown[]): RelayStatement;
  all(): Promise<Reply>;
  run(): Promise<Reply>;
  readonly statement: Statement;
};

export function d1Relay(entry: URL, binding: string): D1Relay {
  const send = async (statements: Statement[], batch: boolean): Promise<Reply[]> => {
    const response = await fetch(entry, { method: 'POST', body: JSON.stringify({ binding, statements, batch }) });
    const body = await response.json();
    if (response.ok) return body as Reply[];
    const failure = body as Failure;
    // solarsql classifies constraint and assert failures by these fields, so the relay keeps them.
    const error = new Error(failure.message, failure.cause === undefined ? undefined : { cause: new Error(failure.cause) });
    throw failure.errcode === undefined ? error : Object.assign(error, { errcode: failure.errcode });
  };
  const statement = (sql: string, params: unknown[]): RelayStatement => {
    const all = async () => (await send([{ sql, params }], false))[0] as Reply;
    return { statement: { sql, params }, bind: (...values) => statement(sql, values), all, run: all };
  };
  return {
    prepare: sql => statement(sql, []),
    batch: statements => send(statements.map(item => item.statement), true),
  };
}
