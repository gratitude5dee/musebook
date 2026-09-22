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
  const client = new pg.Client({ connectionString: env.HYPERDRIVE_FRESH!.connectionString });
  await client.connect();
  return client;
}

/** HYPERDRIVE_CACHED — read-mostly catalog paths (rare here). */
export async function pgCached(env: Env): Promise<DbClient> {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE_CACHED!.connectionString });
  await client.connect();
  return client;
}

export interface ClaimedJob {
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
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
