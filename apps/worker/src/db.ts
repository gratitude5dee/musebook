// apps/worker/src/db.ts — pg connection factories + the claim/finish verbs.
// Worker statements run under musebook_jobs via app.enter() inside the
// helpers — no session state crosses calls.
import pg from "pg";

export interface DbClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/** HYPERDRIVE_FRESH — every write-side read (the sweep's queued set, claim
 *  transitions) must see committed state; the cached binding would re-read a
 *  stale set and re-enqueue it forever (§4.13). */
export async function pgFresh(env: Env): Promise<DbClient> {
  // Bindings are optional in the generated Env on some apps that share this
  // module (apps/edge's `?` declarations) — a missing one means the deploy is
  // misconfigured, so fail loud at the use site.
  const { HYPERDRIVE_FRESH: hd } = env as { HYPERDRIVE_FRESH?: Hyperdrive };
  if (hd === undefined) throw new Error("HYPERDRIVE_FRESH binding missing");
  const client = new pg.Client({ connectionString: hd.connectionString });
  await client.connect();
  return client;
}

/** HYPERDRIVE_CACHED — read-mostly catalog paths (rare here). */
export async function pgCached(env: Env): Promise<DbClient> {
  const { HYPERDRIVE_CACHED: hd } = env as { HYPERDRIVE_CACHED?: Hyperdrive };
  if (hd === undefined) throw new Error("HYPERDRIVE_CACHED binding missing");
  const client = new pg.Client({ connectionString: hd.connectionString });
  await client.connect();
  return client;
}

/** The mixer's dedicated connections. The pipeline issues many statements per
 *  build — hydrators and sources run in parallel on the same socket — so
 *  jobsTx's begin/enter/commit interleave would be racy. A session-level
 *  `set role` on a per-build connection has the same effective privilege with
 *  zero interleave risk; `set local role` inside the app.* helpers still
 *  overrides it per statement, keyed off session-user membership. The
 *  connection is ended with the build, so the role never leaks to a pool. */
async function pgJobsScoped(client: Promise<DbClient>): Promise<DbClient> {
  const c = await client;
  await c.query("set role musebook_jobs");
  return c;
}

export function pgFreshJobs(env: Env): Promise<DbClient> {
  return pgJobsScoped(pgFresh(env));
}

export function pgCachedJobs(env: Env): Promise<DbClient> {
  return pgJobsScoped(pgCached(env));
}

export interface ClaimedJob {
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_CEILING_SECONDS = 86_400; // the platform retry ceiling

/** Queues has no built-in backoff: retry() delay is ours. Exponential on the
 *  delivery's attempt count, capped at the platform's 24 h retry bound. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(BACKOFF_CEILING_SECONDS, BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1));
}

/** The plane roles are NOINHERIT: musebook_worker holds memberships but no
 *  privileges until a statement runs under `set local role`. app.enter() does
 *  that — but only for the CURRENT transaction, and a bare statement's implicit
 *  transaction ends with the statement. Wrap raw-table SQL in an explicit tx so
 *  the entered role persists across the statements that need it.
 *  Never nest: a `begin` inside an open tx is a no-op that would let the inner
 *  `commit` close the caller's transaction. */
export async function jobsTx<T>(db: DbClient, fn: () => Promise<T>): Promise<T> {
  await db.query("begin");
  try {
    await db.query("select app.enter('musebook_jobs')");
    const out = await fn();
    await db.query("commit");
    return out;
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    throw e;
  }
}

/** The dedupe fence: state queued->running in one statement; null when the
 *  row is already claimed — the second delivery of a redelivered message is a
 *  no-op, which is what makes consumers idempotent (gate check 18). */
export async function claimJob(db: DbClient, jobId: number): Promise<ClaimedJob | null> {
  const { rows } = await db.query<ClaimedJob>("select * from app.claim_outbox_job($1)", [jobId]);
  return rows[0] ?? null;
}

export async function finishJob(
  db: DbClient,
  jobId: number,
  state: "succeeded" | "failed" | "dead",
  opts: {
    component?: string;
    event?: string;
    error?: string;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await db.query("select app.finish_job($1, $2::job_state, $3, $4, $5, $6::jsonb)", [
    jobId,
    state,
    opts.component ?? "job",
    opts.event ?? null,
    opts.error ?? null,
    opts.detail ?? {},
  ]);
}
