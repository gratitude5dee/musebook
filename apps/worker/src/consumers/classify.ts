// apps/worker/src/consumers/classify.ts — §8.9, verbatim shape over the
// shared db.ts helpers (pgFresh/claimJob/finishJob issue the same statements
// the plan inlines) plus the CLASSIFY_DAILY_TOKEN_BUDGET defer that feeds
// the A14 classify.degraded alert.
import {
  classifyOne,
  dispositionFor,
  heuristicClassification,
  makeClient,
  QUESTION_SET_VERSION,
  TAXONOMY_VERSION,
  truncateBody,
  type PostState,
} from "@musebook/classify";
import { claimJob, finishJob, pgFresh, type DbClient } from "../db.js";

// §8.10's import ban reaches type positions: the SDK is referenced only
// through makeClient's return type, never as a specifier.
type JevClient = ReturnType<typeof makeClient>;

type ClassifyMsg = { job_id?: number | bigint };
type ClassifyPayload = { post_id?: string; content_hash: string; force?: boolean };

/**
 * In-invocation concurrency. THE BINDING CONSTRAINT IS NOT CPU AND IS NOT THE
 * SUBREQUEST CEILING: a Worker may hold only 6 SIMULTANEOUS OPEN OUTGOING
 * CONNECTIONS, on Free and Paid alike, and it is not configurable. One of those
 * six is the Hyperdrive socket this invocation holds for its whole life, so
 * four concurrent Typesafe requests leaves a slot of headroom.
 *
 * UNVERIFIED: whether the Hyperdrive binding's socket counts against the same
 * six. Cloudflare documents the limit as "simultaneous outgoing connections per
 * request" without enumerating bindings. Four assumes it does, which is the
 * conservative reading; if it does not, five is available and the ceiling moves
 * by 25%, which is not worth a change. Safe fallback if "Too many open
 * connections" ever lands in ops_events: drop to 3.
 */
const CONCURRENCY = 4;
const CIRCUIT_ERRORS = 20; // classify errors in 5 minutes that open the circuit
const BUDGET_DEFER_SECONDS = 300;

export async function classifyQueue(batch: MessageBatch, env: Env): Promise<void> {
  // ONE pg Client for the whole invocation, on the CACHE-DISABLED binding
  // (§8.8). node-postgres serializes queries on a Client, so four concurrent
  // posts share one socket and one connection slot rather than four.
  const db = await pgFresh(env);
  try {
    // Daily input-token budget. The provider's pricing is UNVERIFIED (§8.9),
    // so the budget is in tokens, not dollars, measured off the input_tokens
    // column itself. Over-budget defers the whole batch — never silently —
    // with an ops_events row and the degraded counter the A14 alert reads.
    const budget = Number(env.CLASSIFY_DAILY_TOKEN_BUDGET ?? NaN);
    if (Number.isFinite(budget) && budget > 0) {
      // app.* fns enter the role inside the call — a sibling
      // (select ...) is permission-checked at plan time, BEFORE set local role
      // can execute, so the enter must live inside the function itself.
      const {
        rows: [used],
      } = await db.query<{ tokens: string | number }>(
        `select app.classify_input_tokens_24h() as tokens`,
      );
      const tokens = Number(used?.tokens ?? 0);
      if (tokens >= budget) {
        await db.query(
          `select public.bump_ops_counter('musebook.classify.outcome', ($1::text)::jsonb, 1)`,
          [JSON.stringify({ result: "degraded" })],
        );
        await db.query(
          `select app.write_ops_event('classify', 'token_budget', 'warn', 'deferred', null, null, ($1::text)::jsonb, null)`,
          [JSON.stringify({ budget, tokens, batch: batch.messages.length })],
        );
        for (const m of batch.messages) m.retry({ delaySeconds: BUDGET_DEFER_SECONDS });
        return;
      }
    }

    // §3.7: TypeSafeClient throws in its CONSTRUCTOR when the key is absent —
    // a module-scope client would fail the deploy, and an uncaught throw here
    // would fail the batch with no telemetry. A missing key is auth_failed:
    // ops_events row, then defer the batch like a provider outage.
    let jev: JevClient;
    try {
      jev = makeClient(env);
    } catch (err) {
      const d = dispositionFor(err);
      await db.query(
        `select app.write_ops_event('classify', $1, 'warn', 'deferred', null, null, ($2::text)::jsonb, null)`,
        [d.event, JSON.stringify({ stage: "client_init", error: String(err) })],
      );
      for (const m of batch.messages) m.retry({ delaySeconds: BUDGET_DEFER_SECONDS });
      return;
    }

    // Stateless circuit breaker. A Worker isolate has no dependable memory
    // between invocations and there may be up to 250 of them, so the recent
    // error rate is read from ops_events rather than held in module state.
    // level in ('warn','error'), not 'error' alone: a retryable provider
    // failure is logged at 'warn' by app.finish_job (only a dead job is
    // 'error'), and it is exactly the retryable failures the breaker exists
    // to damp. 'rate_limited' is excluded because a 429 is the provider
    // telling us to slow down, which the per-message retryAfterMs already
    // does — counting it would open the circuit on correct behaviour.
    const {
      rows: [breaker],
    } = await db.query<{ errors: number }>(`select app.classify_errors_5m() as errors`);
    const open = (breaker?.errors ?? 0) >= CIRCUIT_ERRORS;

    // When the circuit is open, let exactly one message through as a probe and
    // give the rest a long delay. retry() does NOT count as a failed
    // invocation for autoscaling purposes, so this does not fight the scaler.
    const work = open ? batch.messages.slice(0, 1) : batch.messages;
    if (open) for (const m of batch.messages.slice(1)) m.retry({ delaySeconds: 300 });

    await pool(work, open ? 1 : CONCURRENCY, (msg) =>
      handleOne(db, jev, env, msg as Message<ClassifyMsg>),
    );
  } finally {
    await db.end();
  }
}

async function handleOne(
  db: DbClient,
  jev: JevClient,
  env: Env,
  msg: Message<ClassifyMsg>,
): Promise<void> {
  const body = msg.body;
  const jobId = typeof body.job_id === "bigint" ? Number(body.job_id) : body.job_id;
  if (jobId == null) {
    msg.ack();
    return;
  }

  // GATE 1 (job level). claim_job flips 'queued' -> 'running' atomically and
  // returns zero rows if another delivery already claimed or finished it.
  const job = await claimJob(db, jobId);
  if (job === null) {
    msg.ack();
    return; // duplicate delivery: no-op
  }

  const payload = job.payload as ClassifyPayload;
  const hash = payload.content_hash;
  const started = Date.now();
  let state: PostState | null = null; // held out here so the catch can degrade with it

  try {
    // GATE 2 (work level, KEYED ON content_hash). NULL means "already
    // classified at this question set, taxonomy and model" or "not a
    // classifiable post". A redelivery after a successful run therefore costs
    // one round trip and zero API calls.
    const {
      rows: [s],
    } = await db.query<{ state: PostState | null }>(
      `select app.classification_state($1,$2,$3,$4,$5) as state`,
      [
        hash,
        QUESTION_SET_VERSION,
        TAXONOMY_VERSION,
        env.TYPESAFE_DEFAULT_MODEL ?? "jev-latest",
        payload.force ?? false,
      ],
    );
    const raw = s?.state ?? null;
    state =
      raw === null
        ? null
        : { ...raw, body: truncateBody(raw.body), link_hosts: raw.link_hosts ?? [] };

    if (state == null) {
      await finishJob(db, jobId, "succeeded", { component: "classify" });
      msg.ack();
      return;
    }

    // battery -> walk -> narrow row + raw blob. Pure; no platform imports.
    const { narrow, raw: rawBundle } = await classifyOne(jev, env, hash, state, started);

    // GATE 3 (storage level). One round trip, one implicit transaction, both
    // rows. An identical re-classification matches no WHERE clause and is a
    // no-op, so redelivery stays free even if gates 1 and 2 were both lost.
    // ($1::text)::jsonb: the only bind shape that works under node-postgres
    // and postgres.js alike (§9.23's driver-portable lesson).
    await db.query(`select app.write_classification(($1::text)::jsonb, ($2::text)::jsonb)`, [
      JSON.stringify(narrow),
      JSON.stringify(rawBundle),
    ]);
    await finishJob(db, jobId, "succeeded", { component: "classify" });
    msg.ack();
  } catch (err) {
    const d = dispositionFor(err); // packages/classify/src/errors.ts
    const detail = { content_hash: hash, attempts: msg.attempts };
    const error = err instanceof Error ? err.message : String(err);

    if (d.terminal) {
      // 400 / 422: the request Musebook built is wrong. Retrying it five times
      // proves the same thing five times. Write the heuristic row, kill the job.
      await db.query(`select app.write_classification(($1::text)::jsonb, null)`, [
        JSON.stringify(heuristicClassification(hash, state)),
      ]);
      // one round trip: close + log
      await finishJob(db, jobId, "dead", { component: "classify", event: d.event, error, detail });
      msg.ack();
      return;
    }

    await finishJob(db, jobId, "queued", {
      component: "classify",
      event: d.event,
      error,
      detail,
    });

    // Queues has NO built-in exponential backoff. Compute it from msg.attempts
    // (which starts at 1) and cap at the 86 400-second delaySeconds ceiling. A
    // RateLimitError uses the server's own retryAfterMs when it supplied one.
    msg.retry({
      delaySeconds:
        d.retryAfterSeconds ?? Math.min(30 * 2 ** Math.min(msg.attempts - 1, 6), 86_400),
    });
  }
}

/** Bounded-concurrency map. Four lines, no dependency, no p-limit. */
async function pool<T>(items: readonly T[], width: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}
