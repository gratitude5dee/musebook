// apps/worker/src/cron/embed.ts — §9.23's hourly embedding jobs hanging off
// the `0 * * * *` tick: corpus backfill (verbatim CTE, 2 000 posts/hour paces
// the initial corpus inside §4.13's throughput ceiling) and the
// user_embeddings recompute (claimed batches of 500, before the slate
// rebuild in the same handler so a fresh embedding feeds the slate built
// seconds later).
import { jobsTx, pgFresh } from "../db.js";

/** §9.23 verbatim — the constant is deliberate, not an env var (§3.7's
 *  manifest is closed). */
const BACKFILL_SQL = `
with todo as (
  select p.id, p.content_hash
    from public.posts p
    left join public.post_embeddings e on e.content_hash = p.content_hash
   where p.status = 'published' and p.deleted_at is null and e.content_hash is null
   order by p.published_at asc
   limit 2000
)
insert into public.job_outbox (kind, dedupe_key, payload)
select 'embed', 'embed:' || todo.content_hash,
       jsonb_build_object('post_id', todo.id, 'content_hash', todo.content_hash)
  from todo
on conflict (kind, dedupe_key) do nothing
returning id
`;

/** Backfill publishes + best-effort Q_EMBED sends; the `* * * * *` sweeper
 *  recovers any send that drops, so a send failure is never fatal here. */
export async function backfillPostEmbeddings(env: Env): Promise<number> {
  const db = await pgFresh(env);
  try {
    const { rows } = await jobsTx(db, () => db.query<{ id: number }>(BACKFILL_SQL));
    const ids = rows.map((r) => Number(r.id));
    for (let i = 0; i < ids.length; i += 100) {
      await env.Q_EMBED.sendBatch(
        ids.slice(i, i + 100).map((id) => ({ body: { job_id: id } })),
      ).catch(() => undefined);
    }
    if (ids.length > 0) {
      await db.query("select app.mark_outbox_enqueued($1::bigint[])", [ids]);
    }
    return ids.length;
  } finally {
    await db.end();
  }
}

// §9.23's positive-action set — the actions jsonb element's `action` key
// (the rollup writer names it `action`, not `kind`; DEVIATIONS entry).
const POSITIVE_ACTIONS = [
  "like", "comment", "repost", "bookmark", "share", "remix",
  "fork_app", "install_app", "tip", "x402_pay", "play_through",
] as const;

/** Viewers with fewer than 20 actions are never written — §9.14's cohort
 *  centroid stands in for them. */
const MIN_ACTION_COUNT = 20;
const CLAIM_BATCH = 500;
const RECENT_HOURS_FALLBACK = 168; // §9.23: a viewer quiet for 7 days goes weekly

/** Claim ≤500 stale viewers under skip-locked, so two overlapping ticks can
 *  never recompute the same viewer. Runs inside the caller's jobs tx so the
 *  locks release at commit. */
const CLAIM_STALE_SQL = `
  select r.viewer_user_id::text as user_id
    from public.viewer_recent_actions r
    left join public.user_embeddings u on u.user_id = r.viewer_user_id
   where r.action_count >= ${MIN_ACTION_COUNT}
     and r.computed_at > coalesce(u.updated_at, 'epoch'::timestamptz)
     and coalesce(u.updated_at, 'epoch'::timestamptz) <
         now() - make_interval(hours =>
           case when r.computed_at > now() - interval '7 days'
                then $1::integer else ${RECENT_HOURS_FALLBACK} end)
   order by r.computed_at desc
   limit ${CLAIM_BATCH}
   for update of r skip locked
`;

/** One viewer's time-decayed weighted mean: last 20 positive-action posts
 *  joined to post_embeddings, weights exp(-ln2 · age_days / 14) (the 14-day
 *  half-life), coordinate-wise mean, then L2-normalised at the upsert. The
 *  element key is `action` per rollup_viewer_recent_actions, not `kind`. */
const VIEWER_EMBED_SQL = `
with acts as (
  select (a.elem->>'post_id')::uuid as post_id,
         extract(epoch from (now() - (a.elem->>'at')::timestamptz)) / 86400.0 as age_days
    from public.viewer_recent_actions r
    cross join lateral jsonb_array_elements(r.actions) as a(elem)
   where r.viewer_user_id = $1::uuid
     and a.elem->>'action' = any($2::text[])
     and (a.elem->>'post_id') is not null
   order by 2 asc
   limit 20
),
weighted as (
  select e.embedding, exp(-ln(2) * a.age_days / 14.0) as w, a.post_id
    from acts a
    join public.post_embeddings e on e.post_id = a.post_id
),
agg as (
  select u.dim,
         sum(u.x::float8 * w.w) / sum(w.w) as mean
    from weighted w
    cross join lateral jsonb_array_elements_text(w.embedding::text::jsonb) with ordinality
       as u(x, dim)
   group by u.dim
)
select (select '[' || string_agg(mean::text, ',' order by dim) || ']' from agg) as emb,
       (select count(*) from weighted) as n
`;

export async function recomputeUserEmbeddings(env: Env): Promise<number> {
  const intervalH = Number(env.MUSE_VIEWER_EMBED_INTERVAL_H ?? 24);
  const db = await pgFresh(env);
  try {
    const viewers = await jobsTx(db, async () => {
      const { rows } = await db.query<{ user_id: string }>(CLAIM_STALE_SQL, [intervalH]);
      const computed: { userId: string; emb: string; n: number }[] = [];
      for (const { user_id } of rows) {
        const { rows: agg } = await db.query<{ emb: string | null; n: number }>(
          VIEWER_EMBED_SQL,
          [user_id, POSITIVE_ACTIONS],
        );
        const r = agg[0];
        if (r === undefined || r.emb === null || Number(r.n) === 0) continue;
        computed.push({ userId: user_id, emb: r.emb, n: Number(r.n) });
      }
      for (const c of computed) {
        await db.query(
          `insert into public.user_embeddings (user_id, model, embedding, n_events, updated_at)
           values ($1::uuid, $2, extensions.l2_normalize($3::extensions.vector), $4, now())
           on conflict (user_id) do update set
             model = excluded.model, embedding = excluded.embedding,
             n_events = excluded.n_events, updated_at = excluded.updated_at`,
          [c.userId, env.EMBEDDING_MODEL, c.emb, c.n],
        );
      }
      return computed;
    });
    return viewers.length;
  } finally {
    await db.end();
  }
}
