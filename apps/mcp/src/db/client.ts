// apps/mcp/src/db/client.ts — postgres.js, one client per request per binding.
// NEVER a module-scope singleton: Hyperdrive clients may not cross requests
// ("Cannot perform I/O on behalf of a different request"), so fetch() creates
// these and release() tears them down inside ctx.waitUntil — §7.4.
import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function fresh(env: Env): Sql {
  return postgres(env.HYPERDRIVE_FRESH.connectionString, { max: 5 });
}

export function cached(env: Env): Sql {
  return postgres(env.HYPERDRIVE_CACHED.connectionString, { max: 5 });
}

export function release(ctx: ExecutionContext, ...clients: Sql[]): void {
  // timeout:0 destroys the socket inside THIS invocation — a deferred close
  // straddles the io boundary and the waitUntil'd end() never resolves,
  // which keeps the isolate's io-context alive through pool teardown.
  // The postgres.js cf polyfill is patched (patches/postgres@3.4.9.patch) to
  // cancel its pending reader before socket.close(), so end() can no longer
  // abort a mid-read and emit an orphan 'error' rejection.
  for (const c of clients) ctx.waitUntil(c.end({ timeout: 0 }).catch(() => undefined));
}

/**
 * Kernel ports are written against the pg-style `{ query, end }` facade this
 * whole codebase shares; postgres.js's `sql.unsafe(text, params)` answers the
 * identical contract, so the adapter is three lines and the ports do not care
 * which driver sits beneath them.
 */
export interface DbClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export function asDb(sql: Sql): DbClient {
  return {
    query: async <T = Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
      // postgres.js resolves to the row array itself; pg resolves to {rows}.
      // The shared DbClient contract is pg-shaped, so wrap here.
      const rows = (await sql.unsafe(text, [...(params ?? [])] as never[])) as unknown as T[];
      return { rows };
    },
    end: () =>
      sql
        .end({ timeout: 0 })
        .then(() => undefined)
        .catch(() => undefined),
  };
}

/** `wrangler types` marks every binding optional (a deploy MAY omit one). At
 *  runtime a configured binding that reads undefined means the deploy is
 *  misconfigured — fail loud at the use site, never silently. */
export function bound<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`binding ${name} is not configured`);
  return v;
}
