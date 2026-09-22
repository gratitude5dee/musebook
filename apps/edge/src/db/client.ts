// apps/edge/src/db/client.ts — the two Hyperdrive bindings and nothing else.
// `pg` is constructed per invocation from the HYPERDRIVE_* bindings' connectionString and
// closed in ctx.waitUntil(client.end()), per §4.0. Statements are single-shot:
// never an explicit transaction — Hyperdrive holds a pooled connection for
// its whole life.
import pg from "pg";

export interface DbClient {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
  end(): Promise<void>;
}

/** `wrangler types` marks every binding optional (a deploy MAY omit one). At
 *  runtime a configured binding that reads undefined means the deploy is
 *  misconfigured — fail loud at the use site, never silently. */
export function bound<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw new Error(`binding ${name} is not configured`);
  return v;
}

function lazy(env: Env, binding: "HYPERDRIVE_CACHED" | "HYPERDRIVE_FRESH"): DbClient {
  const client = new pg.Client({ connectionString: bound(env[binding], binding).connectionString });
  let connecting: Promise<unknown> | null = null;
  return {
    async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<pg.QueryResult<T>> {
      connecting ??= client.connect();
      await connecting;
      return client.query<T>(text, params as unknown[]);
    },
    end: () => client.end(),
  };
}

/** HYPERDRIVE_FRESH — entitlements, role-scoped reads, every access decision. */
export const fresh = (env: Env): DbClient => lazy(env, "HYPERDRIVE_FRESH");
export const freshClient = fresh;
export const pgFresh = fresh;

/** HYPERDRIVE_CACHED — role-independent catalog and content reads only. */
export const cached = (env: Env): DbClient => lazy(env, "HYPERDRIVE_CACHED");

export function release(ctx: ExecutionContext, ...clients: DbClient[]): void {
  for (const client of clients) ctx.waitUntil(client.end());
}
