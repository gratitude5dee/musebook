// apps/edge/test/stubs/pg-live.ts — the `pg` specifier rewritten to postgres.js
// for the edge-gate tier ONLY. `pg`'s CJS tree cannot pass through the workers
// pool's module pipeline (its internal `require`s resolve to ESM builds that
// workerd then refuses to evaluate), while postgres.js is pure ESM and speaks
// to Cloudflare's TCP sockets natively. The shape below is the exact subset of
// node-postgres the read path uses: new Client({connectionString}) ->
// connect() -> query(text, params) -> { rows } -> end().
// TYPES: production files still type-check against the real `pg` package — this
// module is aliased at bundle time, never at tsc time.
import postgres from "postgres";

// postgres.js's workerd socket pump rejects after end() resolves ("This socket
// has been closed" — cf/polyfills.js read()), surfacing as a phantom unhandled
// rejection in the pool. Swallowing that one message is the only teardown the
// shim owns; every other rejection must still fail the run.
if (typeof addEventListener === "function") {
  addEventListener("unhandledrejection", (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
    if (msg.includes("socket has been closed")) e.preventDefault();
  });
}

export interface QueryResultRow {
  [key: string]: unknown;
}
export interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
}

export class Client {
  private readonly sql: postgres.Sql;
  private connected = false;

  constructor(opts?: { connectionString?: string }) {
    this.sql = postgres(opts?.connectionString ?? "", {
      // One client per invocation, exactly like the production lazy() client:
      // every statement is single-shot and the pool would only hide bugs.
      max: 1,
      prepare: false,
    });
  }

  async connect(): Promise<void> {
    // postgres.js connects lazily; one no-op round trip keeps pg's contract.
    await this.sql`select 1`;
    this.connected = true;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>> {
    if (!this.connected) await this.connect();
    const rows = await this.sql.unsafe(text, params as never[]);
    return { rows: rows as unknown as T[], rowCount: rows.count };
  }

  async end(): Promise<void> {
    // timeout:0 destroys the socket now, inside THIS invocation context — a
    // deferred close straddles the io boundary and workerd kills every
    // subsequent write on the same hyperdrive proxy socket.
    await this.sql.end({ timeout: 0 }).catch(() => undefined);
  }
}

const pg = { Client };
export default pg;
