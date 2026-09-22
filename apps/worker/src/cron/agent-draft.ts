// apps/worker/src/cron/agent-draft.ts — §10.15's scheduled drafter.
//
// Budget math (§10.15.2): 24 schedules per tick at 4-way concurrency is six
// waves; six waves × the 20 s draft deadline is 120 s of wall clock worst case
// against the 900 s cron cap — the sub-hourly 30 s CPU limit is never
// approached because the work is network-bound.
import {
  resolveAdapter,
  makeGuardedFetch,
  hostsOf,
  sanitizeAgentText,
  openCredential,
  manifestCanDraft,
  scopesForCapabilities,
  type ConnectorManifest,
  type DraftOutcome,
  type DraftResult,
  type AdapterInit,
  type JsonWebKey,
} from "@musebook/connectors";
import { canonicalMarkdown, contentHash } from "@musebook/content";
import { accessToPublishMode } from "@musebook/kernel";
import { pgFresh } from "../db.js";
import { reserveSpend, settleSpend, releaseSpend } from "../lib/spend.js";
import { needsApproval } from "../lib/approval.js";
import { defaultAccessFor } from "../lib/monetization.js";
import { audit } from "../lib/audit.js";

const MAX_PER_TICK = 24;
const CONCURRENCY = 4;
const DRAFT_DEADLINE_MS = 20_000;
const MAX_DRAFT_CHARS = 20_000;

export interface ScheduleRow {
  id: string;
  delegation_id: string;
  cadence: "hourly" | "daily" | "weekly" | "manual";
  prompt_template: string | null;
  target_platforms: string[];
  max_posts_per_day: number;
  approval_mode: "always" | "first_n" | "never";
  approval_n: number | null;
  last_run_at: Date | string;
  enabled: boolean;
}

export interface DelegationForDrafting {
  delegation_id: string;
  state: string;
  scopes: string[];
  connector_id: string;
  connector_slug: string;
  transport: string;
  auth_kind: string;
  manifest: ConnectorManifest;
  agent_identity_id: string;
  agent_identity_slug: string;
  owner_user_id: string;
  owner_handle: string;
  per_action_cap_atomic: string;
  requires_approval: boolean;
  clean_approvals: number;
  reputation: number | string;
  has_ever_spent: boolean;
  publishing_defaults: {
    license_spdx?: string;
    train_ai?: boolean;
    ai_use?: string;
    price_cents?: number;
    access?: "open" | "toll" | "gated";
  } | null;
}

export type DrainOutcome =
  | { scheduleId: string; outcome: "published" | "pending_approval"; postId: string; reservationId: string }
  | { scheduleId: string; outcome: "submitted"; taskId: string; reservationId: string }
  | { scheduleId: string; outcome: "skipped"; reason: string };

export async function drainDueSchedules(env: Env, ctx: ExecutionContext): Promise<void> {
  const due = await claimDueSchedules(env, MAX_PER_TICK);
  if (due.length === 0) return;
  await pEach(due, CONCURRENCY, (s) =>
    drainSchedule(env, s).catch(async (e) => {
      // A drain throw never takes its wave down — audit the code and move on.
      await audit(env, {
        action: "agent.draft_failed",
        delegation_id: s.delegation_id,
        target_kind: "agent_post_schedule",
        target_id: s.id,
        after_state: { code: codeOf(e) },
      });
    }),
  );
  ctx.passThroughOnException();
}

/** Both arms land in ONE plpgsql call (§10.15.2) — each statement is
 *  'for update skip locked', the scheduled arm rides due_idx, the manual arm
 *  is the owner's forced fire-once. HYPERDRIVE_FRESH, never the cached binding. */
async function claimDueSchedules(env: Env, limit: number): Promise<ScheduleRow[]> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<ScheduleRow>(
      "select * from app.claim_due_schedules($1::int)",
      [limit],
    );
    return rows;
  } finally {
    await db.end();
  }
}

async function pEach<T>(items: T[], n: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += n) {
    await Promise.all(items.slice(i, i + n).map(fn));
  }
}

export async function drainSchedule(env: Env, s: ScheduleRow): Promise<DrainOutcome> {
  const skip = async (reason: string): Promise<DrainOutcome> => {
    await audit(env, {
      action: "agent.draft_skipped",
      delegation_id: s.delegation_id,
      target_kind: "agent_post_schedule",
      target_id: s.id,
      after_state: { reason },
    });
    return { scheduleId: s.id, outcome: "skipped", reason };
  };

  // delegations ⨝ connectors ⨝ agent_identities ⨝ profiles(handle) ⨝
  // creator_publishing_defaults — one statement on HYPERDRIVE_FRESH.
  const d = await loadDelegationForDrafting(env, s.delegation_id);
  if (!d || d.state !== "active") return skip("delegation_inactive");
  if (!d.scopes.includes("post:write")) return skip("missing_scope");
  if (!manifestCanDraft(d.manifest) || !d.manifest.capabilities.includes("post.draft"))
    return skip("connector_cannot_draft");
  if (!scopesForCapabilities(d.manifest.capabilities).every((sc) => d.scopes.includes(sc)))
    return skip("missing_scope");

  const cap = Math.min(s.max_posts_per_day, d.manifest.limits.postsPerDay);
  if ((await postsTodayBy(env, d.agent_identity_id)) >= cap) return skip("max_posts_per_day");

  // (1) Hold the per-action cap BEFORE the far side is called. The key is
  //     (schedule, firing): a retried tick replays the same hold, and the
  //     taskId is the string a bridge result is matched on.
  const firing = new Date(s.last_run_at).getTime();
  const taskId = `draft:${s.id}:${firing}`;
  const held = await reserveSpend(env, {
    delegationId: d.delegation_id,
    estimateAtomic: BigInt(d.per_action_cap_atomic),
    purpose: "connector.call",
    idempotencyKey: taskId,
    externalKind: d.transport === "bridge_token" ? "bridge_draft" : "agent_draft",
    externalRef: taskId,
  });
  if (!held.ok) return skip(held.reason);
  await audit(env, {
    action: "agent.draft_requested",
    delegation_id: d.delegation_id,
    target_kind: "reservation",
    target_id: held.reservationId,
    after_state: { schedule_id: s.id, task_id: taskId, transport: d.transport },
  });

  // (2) Ask the owner's agent — same adapter + guardedFetch + ConnectorContext
  //     shape as a handshake.
  const connector = resolveAdapter(await adapterInitFor(env, d));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DRAFT_DEADLINE_MS);
  let outcome: DraftOutcome;
  try {
    if (!connector.draftPost) throw new Error(`connector_missing_draftPost:${d.connector_slug}`);
    outcome = await connector.draftPost(
      {
        delegationId: d.delegation_id,
        ownerUserId: d.owner_user_id,
        agentIdentityId: d.agent_identity_id,
        scopes: d.scopes,
        remainingAtomic: held.remainingAtomic,
        fetch: makeGuardedFetch({
          allowHosts: hostsOf(d.manifest),
          totalTimeoutMs: Number(env.CONNECTOR_EGRESS_TIMEOUT_MS ?? 60_000),
          maxBytes: Number(env.CONNECTOR_EGRESS_MAX_BYTES ?? 8_388_608),
          signingKey: outboundSigningKey(env),
        }),
        audit: (action, meta) =>
          audit(env, { action, delegation_id: d.delegation_id, after_state: meta ?? {} }),
        requestId: taskId,
        signal: ac.signal,
      },
      {
        intent: renderTemplate(s.prompt_template ?? "", {
          today: todayUtc(),
          handle: d.owner_handle,
        }),
        targetPlatforms: s.target_platforms,
        maxLengthChars: Math.min(MAX_DRAFT_CHARS, await minMaxCharsFor(env, s.target_platforms)),
        referenceUrls: [],
        taskId,
      },
    );
  } catch (e) {
    await releaseSpend(env, held.reservationId, "draft_failed");
    await audit(env, {
      action: "agent.draft_failed",
      delegation_id: d.delegation_id,
      target_kind: "reservation",
      target_id: held.reservationId,
      after_state: { code: codeOf(e) }, // a code, never agent text
    });
    return skip("draft_failed");
  } finally {
    clearTimeout(timer);
  }

  // (2b) THE SPLIT. A bridge task is now owed by a machine that may be asleep;
  //      the hold stays, the tick ends here, and POST /api/bridge/result calls
  //      the SAME completeDraft below when the bytes arrive (10.6.6). The
  //      30-minute reaper releases the hold if they never do.
  if (outcome.kind === "submitted") {
    return {
      scheduleId: s.id,
      outcome: "submitted",
      taskId: outcome.handle,
      reservationId: held.reservationId,
    };
  }

  return completeDraft(env, {
    schedule: s,
    delegation: d,
    reservationId: held.reservationId,
    draft: outcome.draft,
  });
}

/** completeDraft is the ONE function both paths share — the synchronous tick
 *  calls it inline; apps/edge's bridge result route calls it with the same
 *  arguments loaded from the reservation (10.6.6). */
export async function completeDraft(env: Env, a: {
  schedule: ScheduleRow;
  delegation: DelegationForDrafting;
  reservationId: string;
  draft: DraftResult;
}): Promise<DrainOutcome> {
  const { schedule: s, delegation: d, reservationId, draft } = a;

  // (3) The draft is UNTRUSTED text (10.9.1). Sanitize BEFORE the hash so the
  //     hash covers what is stored, served and paid for — spine invariant 1.
  const text = sanitizeAgentText(draft.text, MAX_DRAFT_CHARS);
  if (text.trim().length === 0) {
    await releaseSpend(env, reservationId, "empty_draft");
    return { scheduleId: s.id, outcome: "skipped", reason: "empty_draft" };
  }
  const markdown = canonicalMarkdown(text);
  const hash = contentHash(markdown);

  // (4) Does this one need the owner? 10.7.4 is the floor; the schedule can
  //     only add. `access` stays in §7.4.1's vocabulary; the kernel's
  //     accessToPublishMode is the only thing that maps it, and this file
  //     never spells the column name (§3.4's rule reaches SQL strings too).
  const access = defaultAccessFor({
    reputation: Number(d.reputation),
    defaults: d.publishing_defaults,
  });
  const pending =
    needsApproval({
      requiresApproval: d.requires_approval,
      cleanApprovals: d.clean_approvals,
      reputation: Number(d.reputation),
      scope: "post:publish",
      publishes: true,
      isFree: access === "open",
      estimateAtomic: BigInt(d.per_action_cap_atomic),
      hasEverSpent: d.has_ever_spent,
    }) || scheduleWantsApproval(s, d.clean_approvals);

  // (5) Write. ONE statement — post_bodies -> posts -> approval_queue (pending)
  //     -> job_outbox('distribute') (published w/ platforms). Never an explicit
  //     BEGIN/COMMIT: Hyperdrive pins a pooled connection across round trips.
  const { postId, jobId } = await insertDraftPost(env, {
    ownerUserId: d.owner_user_id,
    agentIdentityId: d.agent_identity_id,
    delegationId: d.delegation_id,
    markdown,
    hash,
    hashtags: draft.hashtags.map((h) => sanitizeAgentText(h, 64)),
    pending,
    access,
    scheduleId: s.id,
    reservationId,
    platforms: s.target_platforms,
    title: null,
    summary: null,
  });

  // (6) Settle at the agent's reported cost, never above the hold (10.14.9).
  const cap = BigInt(d.per_action_cap_atomic);
  const actual = draft.costAtomic < cap ? draft.costAtomic : cap;
  await settleSpend(env, reservationId, actual);
  await audit(env, {
    action: "agent.draft_written",
    delegation_id: d.delegation_id,
    target_kind: "post",
    target_id: postId,
    after_state: {
      schedule_id: s.id,
      reservation_id: reservationId,
      content_hash: hash,
      pending,
      actual_atomic: actual.toString(),
    },
  });

  // (7) Best-effort enqueue AFTER the commit, never before. If this throws the
  //     outbox row is durable and the * * * * * sweeper sends it within ~60 s.
  if (jobId) {
    try {
      await env.Q_DISTRIBUTE!.send({ job_id: jobId });
    } catch (e) {
      console.error("enqueue_deferred", String(e));
    }
  }

  return {
    scheduleId: s.id,
    outcome: pending ? "pending_approval" : "published",
    postId,
    reservationId,
  };
}

export function scheduleWantsApproval(
  s: { approval_mode: "always" | "first_n" | "never"; approval_n: number | null },
  cleanApprovals: number,
): boolean {
  switch (s.approval_mode) {
    case "always":
      return true;
    case "never":
      return false;
    case "first_n":
      return cleanApprovals < (s.approval_n ?? 3);
  }
}

/** Exactly two substitutions. Anything else in the template is literal text. */
export function renderTemplate(t: string, v: { today: string; handle: string }): string {
  return t.replaceAll("{{today}}", v.today).replaceAll("{{handle}}", v.handle).slice(0, 4_000);
}

async function loadDelegationForDrafting(
  env: Env,
  delegationId: string,
): Promise<DelegationForDrafting | null> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      delegation_id: string;
      state: string;
      scopes: string[];
      connector_id: string;
      connector_slug: string;
      transport: string;
      auth_kind: string;
      manifest: unknown;
      agent_identity_id: string;
      agent_identity_slug: string;
      owner_user_id: string;
      owner_handle: string;
      per_action_cap_atomic: string;
      requires_approval: boolean;
      clean_approvals: number;
      reputation: string;
      has_ever_spent: boolean;
      defaults: DelegationForDrafting["publishing_defaults"];
    }>("select * from app.delegation_for_drafting($1::uuid)", [delegationId]);
    const r = rows[0];
    if (!r) return null;
    return { ...r, manifest: r.manifest as ConnectorManifest, publishing_defaults: r.defaults };
  } finally {
    await db.end();
  }
}

async function postsTodayBy(env: Env, agentIdentityId: string): Promise<number> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{ posts_today_by_agent: number }>(
      "select app.posts_today_by_agent($1::uuid)",
      [agentIdentityId],
    );
    return rows[0]?.posts_today_by_agent ?? 0;
  } finally {
    await db.end();
  }
}

export async function minMaxCharsFor(env: Env, platforms: string[]): Promise<number> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{ min_max_chars_for: number }>(
      "select app.min_max_chars_for($1::text[])",
      [platforms],
    );
    return rows[0]?.min_max_chars_for ?? MAX_DRAFT_CHARS;
  } finally {
    await db.end();
  }
}

/** Credential for one delegation — decrypted app-side, single-use, never
 *  stored decoded (10.8.1). auth.kind 'none' and bridge tokens return null. */
async function adapterInitFor(env: Env, d: DelegationForDrafting): Promise<AdapterInit> {
  const transport = d.manifest.transports.find((t) => t.kind === d.transport)
    ?? d.manifest.transports[0];
  if (!transport) throw new Error(`connector_no_transport:${d.connector_slug}`);
  let credential: string | null = null;
  if (d.auth_kind === "bearer" || d.auth_kind === "oauth2") {
    const kind = d.auth_kind === "oauth2" ? "oauth_access" : "bearer";
    const db = await pgFresh(env);
    try {
      const { rows } = await db.query<{ ciphertext: Buffer; key_id: string }>(
        "select * from app.connector_credential_for($1::uuid, $2::text)",
        [d.delegation_id, kind],
      );
      if (rows[0]) {
        credential = await openCredential(
          kekBytes(env),
          d.delegation_id,
          new Uint8Array(rows[0].ciphertext),
        );
      }
    } finally {
      await db.end();
    }
  }
  return {
    manifest: d.manifest,
    connectorRowId: d.connector_id,
    transport,
    credential,
  };
}

/** §10.8.4's outbound key — Ed25519 private JWK from the CONNECTOR_SIGNING_
 *  secrets; undefined when unconfigured so guardedFetch sends unsigned. */
function outboundSigningKey(env: Env): JsonWebKey | undefined {
  const raw = env.CONNECTOR_SIGNING_PRIVATE_KEY;
  if (!raw) return undefined;
  return JSON.parse(raw) as JsonWebKey;
}

/** CONNECTOR_CRED_KEK is the base64 of the 32-byte key-encrypting key. */
function kekBytes(env: Env): Uint8Array {
  const raw = env.CONNECTOR_CRED_KEK;
  if (!raw) throw new Error("connector_cred_kek_unset");
  return Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
}

async function insertDraftPost(
  env: Env,
  a: {
    ownerUserId: string;
    agentIdentityId: string;
    delegationId: string;
    markdown: string;
    hash: string;
    hashtags: string[];
    pending: boolean;
    access: "open" | "toll" | "gated";
    scheduleId: string;
    reservationId: string;
    platforms: string[];
    title: string | null;
    summary: string | null;
  },
): Promise<{ postId: string; approvalId: string | null; jobId: number | null }> {
  const db = await pgFresh(env);
  try {
    const { rows } = await db.query<{
      post_id: string;
      approval_id: string | null;
      job_id: number | null;
    }>(
      `select app.enter('musebook_jobs'),
              r.post_id, r.approval_id, r.job_id
         from public.insert_draft_post(
           $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::text[],
           $7::text, $8::boolean,
           $9::uuid, $10::uuid, $11::text[], $12::text, $13::text) r`,
      [
        a.ownerUserId,
        a.agentIdentityId,
        a.delegationId,
        a.hash,
        a.markdown,
        a.hashtags,
        accessToPublishMode(a.access),
        a.pending,
        a.scheduleId,
        a.reservationId,
        a.platforms,
        a.title,
        a.summary,
      ],
    );
    const r = rows[0];
    if (!r) throw new Error("insert_draft_post_no_row");
    return { postId: r.post_id, approvalId: r.approval_id, jobId: r.job_id };
  } finally {
    await db.end();
  }
}

function codeOf(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 80) : "unknown";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
