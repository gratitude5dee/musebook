// apps/worker/src/consumers/distribute.ts — the musebook-distribute consumer.
// One queue carries four stages (§12.3.3). The outbox payload IS the message;
// {post_id,post_version_id,platforms,source} (publish_post's write) is the
// plan stage. variant/send/reconcile stages are internal job_outbox rows the
// consumer writes itself, each with its own dedupe key, so at-least-once
// delivery stays idempotent end to end.
import {
  PostizHttpError,
  planSendBuckets,
  postizClient,
  produceVariant,
  sendWithPartialRetry,
  toConstraint,
  type CandidateMedia,
  type DistributorEnv,
  type DistributionMessage,
  type PlanChannel,
  type PostizPostEntry,
} from "@musebook/distributor";
import { jobsTx, type DbClient } from "../db.js";

interface ChannelRow {
  id: string;
  owner_user_id: string;
  platform: string;
  postiz_channel_id: string;
  handle: string | null;
  disabled_at: string | null;
}
interface PlatformRowLite {
  slug: string;
  stagger_seconds: number | null;
  concurrency_ceiling: number | null;
}

/** Message field names: publish_post writes snake_case; §12.3.3's union is
 *  camelCase. Accept both — the outbox is the contract, not the casing. */
function field(p: Record<string, unknown>, snake: string, camel: string): unknown {
  return p[snake] ?? p[camel];
}

function strField(p: Record<string, unknown>, snake: string, camel: string): string | null {
  const v = field(p, snake, camel);
  return typeof v === "string" ? v : null;
}

/** ops_events is a jobs-plane table — a bare insert, not write_ops_event
 *  (whose EXECUTE grant is musebook_worker-only). Call inside a jobsTx, or use
 *  opsEventStandalone outside one. */
function opsEvent(
  db: DbClient,
  level: "warn" | "error" | "info",
  event: string,
  detail: Record<string, unknown>,
): Promise<unknown> {
  return db.query(
    `insert into public.ops_events (component, event_name, level, outcome, metadata)
     values ('distributor', $1, $2, $3, $4::jsonb)`,
    [event, level, event, JSON.stringify(detail)],
  );
}

async function opsEventStandalone(
  db: DbClient,
  level: "warn" | "error" | "info",
  event: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await jobsTx(db, () => opsEvent(db, level, event, detail));
}

/** Raw outbox insert — caller must already be inside a jobs transaction. */
async function insertStageJobBare(
  db: DbClient,
  dedupeKey: string,
  payload: DistributionMessage,
): Promise<number | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.job_outbox (kind, dedupe_key, payload)
     values ('distribute', $1, $2::jsonb)
     on conflict (kind, dedupe_key) do nothing
     returning id`,
    [dedupeKey, JSON.stringify(payload)],
  );
  return rows[0] === undefined ? null : Number(rows[0].id);
}

/** Insert a follow-on distribute job_outbox row and return its id (null when
 *  the dedupe key already exists — the first writer owns the stage). Callers
 *  already inside a jobs transaction use insertStageJobBare instead. */
async function insertStageJob(
  db: DbClient,
  dedupeKey: string,
  payload: DistributionMessage,
): Promise<number | null> {
  return jobsTx(db, () => insertStageJobBare(db, dedupeKey, payload));
}

// ---------------------------------------------------------------------------
// stage 1 — plan: resolve channels, write distribution_jobs rows, fan out.

interface PlanPayload {
  post_id: string;
  post_version_id: string;
  platforms: string[];
  source: string;
}

async function runPlanStage(db: DbClient, p: PlanPayload): Promise<void> {
  const missing = await jobsTx(db, async () => {
    const { rows: post } = await db.query<{ author_user_id: string }>(
      `select p.author_user_id::text as author_user_id from public.posts p
      where p.id = $1::uuid and p.deleted_at is null`,
      [p.post_id],
    );
    if (post.length === 0) throw new Error(`distribute plan: no post ${p.post_id}`);
    const author = post[0]!.author_user_id;

    const { rows: channels } = await db.query<ChannelRow>(
      `select c.id::text, c.owner_user_id::text, c.platform, c.postiz_channel_id,
            c.handle, c.disabled_at::text
       from public.channels c
      where c.owner_user_id = $1::uuid and c.disabled_at is null
        and (cardinality($2::text[]) = 0 or c.platform = any($2::text[]))`,
      [author, p.platforms],
    );

    // Gate check 9: a requested-but-unconnected channel is a loud error, not a
    // silently smaller fan-out. The ops row is written AFTER the tx closes — a
    // throw here would roll the insert back.
    if (p.platforms.length > 0) {
      const got = new Set(channels.map((c) => c.platform));
      const miss = p.platforms.filter((pl) => !got.has(pl));
      if (miss.length > 0) {
        return miss;
      }
    }
    if (channels.length === 0) {
      await opsEvent(db, "warn", "fanout.empty", { post_id: p.post_id });
      return null;
    }

    const { rows: platformRows } = await db.query<PlatformRowLite>(
      `select slug, stagger_seconds, concurrency_ceiling
       from public.platforms where slug = any($1::text[])`,
      [channels.map((c) => c.platform)],
    );
    const staggerOf = new Map(platformRows.map((r) => [r.slug, r.stagger_seconds ?? 0]));

    const planChannels: PlanChannel[] = channels.map((c) => ({
      id: c.id,
      platform: c.platform,
      postizChannelId: c.postiz_channel_id,
      staggerSeconds: staggerOf.get(c.platform) ?? 0,
      concurrencyCeiling: null,
    }));
    const { buckets } = planSendBuckets(planChannels, new Date());
    const bucketOf = new Map<string, number>();
    for (const [instant, ids] of buckets) for (const id of ids) bucketOf.set(id, instant);

    // One distribution_jobs row per channel — dist:${pvid}:${cid} makes a
    // re-planned publish a no-op, not a duplicate tweet (§4.12 note).
    for (const c of channels) {
      const scheduledFor = new Date(bucketOf.get(c.id)!).toISOString();
      await db.query(
        `insert into public.distribution_jobs
         (post_id, post_version_id, channel_id, idempotency_key, scheduled_for, request_payload)
       values ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::jsonb)
       on conflict (idempotency_key) do nothing`,
        [
          p.post_id,
          p.post_version_id,
          c.id,
          `dist:${p.post_version_id}:${c.id}`,
          scheduledFor,
          JSON.stringify({ source: p.source, platforms: p.platforms }),
        ],
      );
    }

    // One variant job_outbox row per channel. Send rows are claimed by the LAST
    // sibling to resolve in each bucket (see runVariantStage) so a send never
    // fires before its variants exist.
    for (const c of channels) {
      const msg = {
        stage: "variant",
        postId: p.post_id,
        postVersionId: p.post_version_id,
        channelId: c.id,
        platformSlug: c.platform,
        jobId: `dist:${p.post_version_id}:${c.id}`,
        scheduledFor: new Date(bucketOf.get(c.id)!).toISOString(),
      } satisfies Record<string, unknown>;
      await insertStageJobBare(
        db,
        `distribute-variant:${msg.jobId}`,
        msg as unknown as DistributionMessage,
      );
    }
    return null;
  });
  if (missing !== null && missing !== undefined) {
    await opsEventStandalone(db, "error", "channel.unconnected", {
      post_id: p.post_id,
      missing,
      requested: p.platforms,
    });
    throw new Error(
      `distribute plan: channels not connected for platform(s): ${missing.join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// stage 2 — variant: produce+validate+store one platform's port.

interface VariantPayload {
  postId: string;
  postVersionId: string;
  channelId: string;
  /** Resolved from the channel's platform when absent — the edge regenerate
   *  route (§12.3.7) cannot read distribution_jobs under the noinherit role
   *  model, so it sends only ids and lets the consumer fill the rest. */
  platformSlug?: string | undefined;
  jobId: string;
  /** Resolved from the distribution_jobs row when absent (same reason). */
  scheduledFor?: string | undefined;
  attempt?: number | undefined;
}

/** Stage-internal retry budget. claim_outbox_job only fires on `queued` rows,
 *  so a thrown stage never re-runs — retryable work re-enqueues a fresh row
 *  with `attempt` bumped, capped here; the last attempt fails loud. */
const STAGE_MAX_ATTEMPTS = 4;

async function runVariantStage(db: DbClient, env: Env, m: VariantPayload): Promise<void> {
  const { channel, jobRow } = await jobsTx(db, async () => {
    const { rows } = await db.query<ChannelRow & { platform: string }>(
      `select c.id::text, c.owner_user_id::text, c.platform, c.postiz_channel_id,
              c.handle, c.disabled_at::text
         from public.channels c where c.id = $1::uuid`,
      [m.channelId],
    );
    const { rows: jrows } = await db.query<{ scheduled_for: string | null }>(
      `select scheduled_for::text from public.distribution_jobs
        where idempotency_key = $1`,
      [m.jobId],
    );
    return { channel: rows[0], jobRow: jrows[0] };
  });
  // Fill the fields the plan stage carries and the edge regenerate route
  // cannot know: platform comes off the channel, the publish instant off the
  // job row (postId/postVersionId/channelId/jobId are always in the payload).
  const resolved = {
    ...m,
    platformSlug: m.platformSlug ?? channel?.platform,
    scheduledFor: m.scheduledFor ?? jobRow?.scheduled_for ?? new Date().toISOString(),
  };
  if (
    channel === undefined ||
    channel.disabled_at !== null ||
    resolved.platformSlug === undefined
  ) {
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs set state='failed', last_error='channel missing or disabled'
          where idempotency_key = $1`,
        [m.jobId],
      );
    });
    await maybeEnqueueSend(db, resolved.postVersionId, resolved.scheduledFor, resolved.postId);
    return;
  }

  const attempt = resolved.attempt ?? 0;
  try {
    await produceAndStoreVariant(db, env, resolved);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (attempt < STAGE_MAX_ATTEMPTS) {
      await jobsTx(db, async () => {
        await db.query(
          `update public.distribution_jobs set last_error = $2 where idempotency_key = $1`,
          [m.jobId, `variant retry ${attempt + 1}: ${detail}`],
        );
      });
      const next = { ...resolved, stage: "variant", attempt: attempt + 1 };
      await insertStageJob(
        db,
        `distribute-variant:${m.jobId}:a${attempt + 1}`,
        next as unknown as DistributionMessage,
      );
      return; // job stays queued — siblings wait for this channel to resolve
    }
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs set state='failed', last_error=$2
          where idempotency_key = $1`,
        [m.jobId, `variant exhausted: ${detail}`],
      );
      await opsEvent(db, "error", "variant.exhausted", {
        post_version_id: m.postVersionId,
        channel_id: m.channelId,
        error: detail,
      });
    });
  }
  await maybeEnqueueSend(db, resolved.postVersionId, resolved.scheduledFor, resolved.postId);
}

/** Produce → validate → mirror → store one channel's variant, then mark its
 *  distribution_job. Validation failures land as permanent job failures;
 *  infra errors (Postiz upload, gateway) throw to the caller's retry path. */
async function produceAndStoreVariant(db: DbClient, env: Env, m: VariantPayload): Promise<void> {
  const { platform, overrides } = await jobsTx(db, async () => {
    const { rows: prows } = await db.query<Record<string, unknown>>(
      `select * from public.platforms where slug = $1`,
      [m.platformSlug],
    );
    const { rows: ovr } = await db.query<{ max_chars: number | null; rules_text: string | null }>(
      `select max_chars, rules_text from public.channel_constraint_overrides
        where channel_id = $1::uuid`,
      [m.channelId],
    );
    return { platform: prows[0], overrides: ovr[0] ?? null };
  });
  if (platform === undefined) throw new Error(`unknown platform ${m.platformSlug ?? "?"}`);

  const constraint = toConstraint(platform as never, {
    override: overrides,
    cdnHost: (env as { CDN_HOST?: string }).CDN_HOST ?? "cdn.musebook.dev",
  });

  const { rows: src } = await db.query<{
    canonical_markdown: string;
    canonical_url: string | null;
    author_user_id: string;
  }>(
    `select canonical_markdown, canonical_url, author_user_id::text
       from app.load_resource_by_post_id($1::uuid)`,
    [m.postId],
  );
  const source = src[0];
  if (source === undefined) throw new Error(`no live post ${m.postId}`);
  const canonicalUrl = source.canonical_url ?? `https://musebook.dev/p/${m.postId}`;

  const { rows: media } = await db.query<{
    url: string;
    content_type: string;
    alt_text: string | null;
    width: number | null;
    height: number | null;
    duration_ms: number | null;
  }>("select * from app.distribution_media($1::uuid)", [m.postId]);

  const candidateMedia: CandidateMedia[] = media.map((a) => ({
    url: a.url,
    contentType: a.content_type,
    alt: a.alt_text,
    widthPx: a.width,
    heightPx: a.height,
    durationSeconds: a.duration_ms === null ? null : a.duration_ms / 1000,
    thumbnailUrl: null,
  }));

  const markdown = source.canonical_markdown;
  const plain = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const result = await produceVariant(
    {
      canonicalMarkdown: markdown,
      plainBody: plain,
      canonicalUrl,
      intent: "full", // §13.3: full ports, always
      constraint,
      platformRules: overrides?.rules_text ?? null,
      media: candidateMedia,
    },
    env as unknown as DistributorEnv,
  );

  // Mirror each picked asset into Postiz media storage — uploadFromUrl, never
  // multipart (§12.2.5), only cdn.musebook.dev URLs reach here (validated).
  const client = postizClient(env as unknown as DistributorEnv);
  const mirrored: {
    id: string;
    path: string;
    alt?: string | undefined;
    thumbnail?: string | undefined;
  }[] = [];
  if (result.report.ok) {
    for (const mm of result.candidate.media) {
      const r = await client.uploadFromUrl(mm.url);
      mirrored.push({
        id: r.id,
        path: r.path,
        alt: mm.alt ?? undefined,
        thumbnail: mm.thumbnailUrl ?? undefined,
      });
    }
  }

  const variantId = await jobsTx(db, async () => {
    const { rows: vrows } = await db.query<{ id: string }>(
      `insert into public.platform_variants
         (post_id, post_version_id, platform, body, media, thread_parts,
          generated_by, validator_report, is_valid)
       values ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)
       on conflict (post_version_id, platform) do update set
         body = excluded.body, media = excluded.media, thread_parts = excluded.thread_parts,
         generated_by = excluded.generated_by, validator_report = excluded.validator_report,
         is_valid = excluded.is_valid
       returning id`,
      [
        m.postId,
        m.postVersionId,
        m.platformSlug,
        result.candidate.body,
        JSON.stringify(result.report.ok ? mirrored : result.candidate.media),
        JSON.stringify(result.candidate.threadParts),
        result.generatedBy,
        JSON.stringify(result.report),
        result.report.ok,
      ],
    );

    // §12.3.9's machine: a valid variant leaves the job `queued` with
    // `variant_id` set — queued+variant_id IS the variant-ready marker the
    // send stage claims on. An invalid variant is a permanent `failed`.
    await db.query(
      `update public.distribution_jobs
          set state = $2::job_state, variant_id = $3::uuid, last_error = $4
        where idempotency_key = $1`,
      [
        m.jobId,
        result.report.ok ? "queued" : "failed",
        vrows[0]?.id ?? null,
        result.report.ok ? null : result.report.failures.join("; "),
      ],
    );
    return vrows[0]?.id ?? null;
  });
  void variantId;
}

/** Last-sibling check: when every job in this scheduled_for bucket has
 *  resolved (succeeded or failed), enqueue the bucket's one send stage. The
 *  dedupe key means concurrent last-siblings only ever create one row. */
async function maybeEnqueueSend(
  db: DbClient,
  postVersionId: string,
  scheduledFor: string,
  postId: string,
): Promise<void> {
  const { rows: pending } = await jobsTx(db, async () =>
    db.query<{ n: string }>(
      `select count(*)::text as n from public.distribution_jobs
        where post_version_id = $1::uuid and scheduled_for = $2::timestamptz
          and state = 'queued' and variant_id is null`,
      [postVersionId, scheduledFor],
    ),
  );
  if (Number(pending[0]?.n ?? "0") === 0) {
    const msg = {
      stage: "send",
      postId,
      postVersionId,
      scheduledFor,
    } satisfies Record<string, unknown>;
    await insertStageJob(
      db,
      `distribute-send:${postVersionId}:${scheduledFor}`,
      msg as unknown as DistributionMessage,
    );
  }
}

// ---------------------------------------------------------------------------
// stage 3 — send: one PostizCreatePostBody per publish instant (§12.2.4).

interface SendPayload {
  postId: string;
  postVersionId: string;
  scheduledFor: string;
  attempt?: number | undefined;
}

interface SendJobRow {
  id: string;
  channel_id: string;
  variant_id: string | null;
  postiz_channel_id: string;
  platform: string;
  body: string;
  thread_parts: string[] | null;
  media: { id: string; path: string; alt?: string; thumbnail?: string }[];
}

async function runSendStage(db: DbClient, env: Env, m: SendPayload): Promise<void> {
  // Conditional queued→running BEFORE the outbound call (§12.3.8): a second
  // delivery finds zero claimed rows and hands the bucket to the reconciler
  // instead of publishing again — a timeout is not a failure to send.
  const claimed = await jobsTx(
    db,
    async () =>
      (
        await db.query<SendJobRow>(
          `update public.distribution_jobs dj
          set state = 'running', attempts = dj.attempts + 1
         from public.channels c, public.platform_variants v
        where dj.channel_id = c.id
          and dj.variant_id = v.id
          and dj.post_version_id = $1::uuid
          and dj.scheduled_for = $2::timestamptz
          and dj.state = 'queued'      -- variant-ready: stage 2 kept queued+variant_id
          and dj.postiz_post_id is null
        returning dj.id::text, dj.channel_id::text, dj.variant_id::text,
                  c.postiz_channel_id, c.platform, v.body, v.thread_parts, v.media`,
          [m.postVersionId, m.scheduledFor],
        )
      ).rows,
  );
  if (claimed.length === 0) {
    // A redelivery after a mid-send kill: the bucket is 'running' already —
    // nudge the reconciler and exit (§12.3.9).
    const running = await jobsTx(
      db,
      async () =>
        (
          await db.query<{ n: string }>(
            `select count(*)::text as n from public.distribution_jobs
          where post_version_id = $1::uuid and scheduled_for = $2::timestamptz
            and state = 'running'`,
            [m.postVersionId, m.scheduledFor],
          )
        ).rows,
    );
    if (Number(running[0]?.n ?? "0") > 0) await reconcileBucket(db, m);
    return;
  }

  const entries: PostizPostEntry[] = claimed.map((j) => ({
    integration: { id: j.postiz_channel_id },
    value: [j.body, ...(j.thread_parts ?? [])].map((content) => ({
      content,
      image: j.media ?? [],
    })),
    settings: {},
  }));

  const providerOf = (e: PostizPostEntry): string =>
    claimed.find((j) => j.postiz_channel_id === e.integration.id)?.platform ?? "unknown";
  const markFailed = async (provider: string, body: unknown): Promise<void> => {
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs dj
            set state = 'failed', last_error = 'postiz 400', response_payload = $3::jsonb
           from public.channels c
          where dj.channel_id = c.id and dj.post_version_id = $1::uuid
            and dj.scheduled_for = $2::timestamptz and c.platform = $4`,
        [m.postVersionId, m.scheduledFor, JSON.stringify(body), provider],
      );
    });
  };

  const client = postizClient(env as unknown as DistributorEnv);
  let result;
  try {
    result = await sendWithPartialRetry(
      client,
      {
        type: "schedule",
        date: m.scheduledFor,
        shortLink: false,
        tags: [{ value: "musebook", label: "musebook" }],
        posts: entries,
      },
      { markJobFailed: markFailed, providerOf },
    );
  } catch (e) {
    // Postiz-level failure: rows go back to `queued` (the claimable state)
    // and the send re-enqueues under a new outbox row — claim_job only fires
    // `queued`, so throwing here would never re-run the stage. §12.3.8's
    // backoff lives in the attempt counter; a 429 would rather wait 600 s,
    // which the outbox cannot express — logged as a deviation.
    const detail = e instanceof PostizHttpError ? e.body : String(e);
    const attempt = m.attempt ?? 0;
    if (attempt < STAGE_MAX_ATTEMPTS) {
      await jobsTx(db, async () => {
        await db.query(
          `update public.distribution_jobs
              set state = 'queued', last_error = 'postiz send failed',
                  response_payload = $3::jsonb
            where post_version_id = $1::uuid and scheduled_for = $2::timestamptz
              and state = 'running' and postiz_post_id is null`,
          [m.postVersionId, m.scheduledFor, JSON.stringify(detail)],
        );
      });
      const next = { ...m, stage: "send", attempt: attempt + 1 };
      await insertStageJob(
        db,
        `distribute-send:${m.postVersionId}:${m.scheduledFor}:a${attempt + 1}`,
        next as unknown as DistributionMessage,
      );
      return;
    }
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs
            set state = 'failed', last_error = 'postiz send exhausted',
                response_payload = $3::jsonb
          where post_version_id = $1::uuid and scheduled_for = $2::timestamptz
            and state = 'running' and postiz_post_id is null`,
        [m.postVersionId, m.scheduledFor, JSON.stringify(detail)],
      );
    });
    await opsEventStandalone(db, "error", "send.exhausted", {
      post_version_id: m.postVersionId,
      scheduled_for: m.scheduledFor,
      error: detail,
    });
    return;
  }

  // Postiz accepted: record postiz_post_id and LEAVE the row 'running' — the
  // reconciler (*/5 cron or a webhook hint) promotes it to succeeded/failed
  // once the platform reports a terminal state (§12.3.9).
  const byChannel = new Map(claimed.map((j) => [j.postiz_channel_id, j]));
  await jobsTx(db, async () => {
    for (const r of result) {
      const job = byChannel.get(r.integration);
      if (job === undefined) continue;
      await db.query(
        `update public.distribution_jobs
            set postiz_post_id = $2, response_payload = $3::jsonb
          where id = $1::uuid`,
        [job.id, r.postId, JSON.stringify(r)],
      );
    }
  });
  await reconcileBucket(db, m);
  // Entries Postiz silently dropped (validation excluded them server-side) —
  // they were claimed but absent from the result set.
  const returned = new Set(result.map((r) => r.integration));
  const dropped = claimed.filter((j) => !returned.has(j.postiz_channel_id));
  await jobsTx(db, async () => {
    for (const j of dropped) {
      await db.query(
        `update public.distribution_jobs
            set state = 'failed', last_error = 'excluded from postiz batch'
          where id = $1::uuid`,
        [j.id],
      );
    }
  });
  for (const j of dropped) {
    await opsEventStandalone(db, "warn", "channel.excluded_from_batch", {
      post_version_id: m.postVersionId,
      channel_id: j.channel_id,
      platform: j.platform,
    });
  }
}

/** Enqueue one reconcile outbox row per distinct postiz_post_id in a bucket —
 *  the dedupe key makes concurrent send/redelivery paths emit it once. */
async function reconcileBucket(db: DbClient, m: SendPayload): Promise<void> {
  const { rows } = await jobsTx(db, async () =>
    db.query<{ postiz_post_id: string }>(
      `select distinct postiz_post_id from public.distribution_jobs
        where post_version_id = $1::uuid and scheduled_for = $2::timestamptz
          and postiz_post_id is not null and state = 'running'`,
      [m.postVersionId, m.scheduledFor],
    ),
  );
  for (const r of rows) {
    const msg = { stage: "reconcile", postizPostId: r.postiz_post_id };
    await insertStageJob(
      db,
      `distribute-reconcile:${r.postiz_post_id}`,
      msg as unknown as DistributionMessage,
    );
  }
}

// ---------------------------------------------------------------------------
// stage 4 — reconcile: a webhook hint re-reads Postiz, never trusts the body.

interface ReconcilePayload {
  postizPostId: string;
}

/** §12.3.9's terminal transitions for one job, driven by listPosts. Returns
 *  true when the job reached a terminal state. Shared by the stage-4 message
 *  handler and the five-minute reconcile cron. */
export async function reconcileJob(
  db: DbClient,
  env: Env,
  job: {
    id: string;
    postiz_post_id: string | null;
    postiz_channel_id: string | null;
    scheduled_for: string;
  },
): Promise<boolean> {
  const client = postizClient(env as unknown as DistributorEnv);
  const at = new Date(job.scheduled_for).getTime();
  const posts = await client.listPosts(
    new Date(at - 5 * 60_000).toISOString(),
    new Date(at + 30 * 60_000).toISOString(),
  );
  // Match by the id recorded at send time, else by (integration, publishDate).
  const match =
    posts.find((p) => p.id === job.postiz_post_id) ??
    posts.find(
      (p) =>
        job.postiz_channel_id !== null &&
        p.integration.id === job.postiz_channel_id &&
        Math.abs(new Date(p.publishDate).getTime() - at) < 60_000,
    );
  if (match === undefined) return false;
  if (match.state === "PUBLISHED") {
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs
            set state = 'succeeded', platform_post_url = $2,
                response_payload = response_payload || $3::jsonb
          where id = $1::uuid`,
        [job.id, match.releaseURL ?? null, JSON.stringify({ reconcile: match })],
      );
    });
    return true;
  }
  if (match.state === "ERROR") {
    await jobsTx(db, async () => {
      await db.query(
        `update public.distribution_jobs
            set state = 'failed', last_error = $2,
                response_payload = response_payload || $3::jsonb
          where id = $1::uuid`,
        [job.id, match.error ?? "postiz ERROR", JSON.stringify({ reconcile: match })],
      );
    });
    return true;
  }
  return false; // QUEUE — still in flight on the Postiz side
}

async function runReconcileStage(db: DbClient, env: Env, m: ReconcilePayload): Promise<void> {
  const { rows } = await jobsTx(db, async () =>
    db.query<{
      id: string;
      postiz_post_id: string;
      postiz_channel_id: string;
      scheduled_for: string;
    }>(
      `select dj.id::text, dj.postiz_post_id, c.postiz_channel_id, dj.scheduled_for::text
         from public.distribution_jobs dj
         join public.channels c on c.id = dj.channel_id
        where dj.postiz_post_id = $1 limit 1`,
      [m.postizPostId],
    ),
  );
  const job = rows[0];
  if (job === undefined) {
    await opsEventStandalone(db, "warn", "reconcile.unknown_post", {
      postiz_post_id: m.postizPostId,
    });
    return;
  }
  try {
    await reconcileJob(db, env, job);
  } catch (e) {
    // A Postiz read failure loses nothing — the */5 cron re-probes.
    await opsEventStandalone(db, "warn", "reconcile.probe_failed", {
      postiz_post_id: m.postizPostId,
      error: String(e),
    });
  }
}

// ---------------------------------------------------------------------------

/** The queue() entry for musebook-distribute (registered in consumers/index.ts).
 *  `payload` is the claimed job_outbox row's payload; stage defaults to 'plan'. */
export async function runDistribute(
  db: DbClient,
  env: Env,
  rawPayload: Record<string, unknown> | string,
): Promise<void> {
  const payload: Record<string, unknown> =
    typeof rawPayload === "string"
      ? (JSON.parse(rawPayload) as Record<string, unknown>)
      : rawPayload;
  if ((env as { DISTRIBUTION_ENABLED?: string }).DISTRIBUTION_ENABLED !== "true") {
    // §3.7: the kill switch must throw when unset, not default silently off.
    if ((env as { DISTRIBUTION_ENABLED?: string }).DISTRIBUTION_ENABLED === undefined) {
      throw new Error("DISTRIBUTION_ENABLED is not set");
    }
    return;
  }
  const stage = (payload.stage as string | undefined) ?? "plan";
  switch (stage) {
    case "plan": {
      const platformsRaw = field(payload, "platforms", "platforms");
      await runPlanStage(db, {
        post_id: strField(payload, "post_id", "postId") ?? "",
        post_version_id: strField(payload, "post_version_id", "postVersionId") ?? "",
        platforms: Array.isArray(platformsRaw) ? (platformsRaw as string[]) : [],
        source: strField(payload, "source", "source") ?? "composer",
      });
      return;
    }
    case "variant":
      await runVariantStage(db, env, payload as unknown as VariantPayload);
      return;
    case "send":
      await runSendStage(db, env, payload as unknown as SendPayload);
      return;
    case "reconcile":
      await runReconcileStage(db, env, payload as unknown as ReconcilePayload);
      return;
    default:
      throw new Error(`distribute: unknown stage ${stage}`);
  }
}
