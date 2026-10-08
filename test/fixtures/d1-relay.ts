// Gives tests a D1 binding that reaches workerd over keep-alive connections.
// Miniflare's binding proxy sets `reset` on every runtime request, so each D1 call opens a new socket.
// A test with thousands of calls then fills the macOS ephemeral port range with TIME_WAIT sockets.
// The relay worker runs each call on the real binding; it does not emulate D1.
import { Agent, request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';

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

// workerd closes an idle connection after about 4 s. A test that blocks the event loop longer
// leaves the close unread, so the relay drops a socket at send time once it idles past STALE_AFTER_MS.
// A keep-alive timeout cannot do this: its timer fires only after the next send already took the socket.
// The relay never retries, because a request that reached workerd may have committed.
const STALE_AFTER_MS = 2000;

class RelayAgent extends Agent {
  readonly #idleSince = new WeakMap<Socket, number>();
  constructor() { super({ keepAlive: true }); }
  // Node destroys the socket when this returns falsy, although @types/node declares void.
  override keepSocketAlive(socket: Socket) {
    this.#idleSince.set(socket, performance.now());
    return super.keepSocketAlive(socket);
  }
  // Agent#addRequest skips destroyed free sockets, so destroying here keeps the next send off them.
  dropStaleSockets(): void {
    for (const sockets of Object.values(this.freeSockets)) {
      for (const socket of sockets ?? []) {
        if (performance.now() - (this.#idleSince.get(socket) ?? 0) > STALE_AFTER_MS) socket.destroy();
      }
    }
  }
}

export function d1Relay(entry: URL, binding: string): D1Relay {
  const agent = new RelayAgent();
  const post = (body: string) => new Promise<{ ok: boolean; text: string }>((resolve, reject) => {
    agent.dropStaleSockets();
    httpRequest(entry, { method: 'POST', agent }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('error', reject);
      response.on('end', () => resolve({ ok: response.statusCode === 200, text }));
    }).on('error', reject).end(body);
  });
  const send = async (statements: Statement[], batch: boolean): Promise<Reply[]> => {
    const response = await post(JSON.stringify({ binding, statements, batch }));
    const body: unknown = JSON.parse(response.text);
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
