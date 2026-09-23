// apps/edge/src/auth/resolve-actor.ts — §5.6.1. The ONE Actor producer for the
// HTTP plane (`musebook-mcp` owns resolveActorFromMcp; nothing else constructs an
// Actor). First-match-wins ladder; see the table in §5.6.1.
import pg from "pg";
import { paymentPayloadSchema, type Actor, type PaymentPayload } from "@musebook/schema";
import { classifySignature, type AgentVerdict } from "./web-bot-auth.js";
import { verifiedCrawler } from "./rdns.js";
import { rawClientIp } from "../telemetry/privacy.js";

export interface IdentityEnv {
  HYPERDRIVE_FRESH: Hyperdrive;
  HYPERDRIVE_CACHED: Hyperdrive;
  WBA_DIR: KVNamespace; // Web Bot Auth directory + allowlist cache
  // The agent sighting rides the EXISTING outbox path (5.6.2). Section 4.13.2 is
  // the queue registry and it has exactly seven entries: there is no eighth queue,
  // no `musebook-agent-events`, and no `AGENT_EVENTS` binding anywhere.
  Q_CLASSIFY: Queue<{ job_id: number }>;
}

/**
 * Thrown when a request PRESENTED a Web Bot Auth signature that did not verify.
 * Such a request has no Actor: it is not an unverified crawler, it is a rejected
 * request. The Worker's top-level handler maps it to a response and nothing else
 * catches it. See the fail-direction table in 5.6.2.
 */
export class WebBotAuthRejected extends Error {
  constructor(
    readonly status: 401 | 503,
    readonly reason: string,
    /** §6.11: `Retry-After: 30` on the 503 direction only. */
    readonly retryAfter?: number,
  ) {
    super(reason);
    this.name = "WebBotAuthRejected";
  }
}

/** A credential was volunteered (Bearer mb_dlg_…) and did not resolve. Like a
 *  broken signature, that is more suspicious than presenting none — 401, never
 *  a silent fall-through to human. (An unresolvable `mb_session` cookie is the
 *  opposite case: browser-set credentials expire constantly, so it falls
 *  through to the anonymous reader.) */
export class CredentialRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CredentialRejected";
  }
}

const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

function paymentFrom(request: Request): {
  payment: PaymentPayload | null;
  paymentTransport: "http" | "mcp" | null;
} {
  const raw = request.headers.get("payment-signature");
  if (raw === null) return { payment: null, paymentTransport: null };
  try {
    const parsed = paymentPayloadSchema.safeParse(JSON.parse(atob(raw)));
    return parsed.success
      ? { payment: parsed.data, paymentTransport: "http" }
      : { payment: null, paymentTransport: null };
  } catch {
    return { payment: null, paymentTransport: null };
  }
}

const DELEGATION_RE = /^mb_dlg_[A-Za-z0-9_-]{16,}$/;

async function withClient<T>(
  connectionString: string,
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

type AgentSighting = { signatureAgent: string; keyid: string; seenAt: string };

/** Test seam: swap the pg round trip for a stubbed query function. */
/** `wrangler types` marks every binding optional; wrangler.jsonc declares
 *  these four unconditionally. Narrow once at the boundary. */
export const asIdentityEnv = (env: Env): IdentityEnv => env as IdentityEnv;

export type ResolveActorDeps = {
  query?: (
    connectionString: string,
    sql: string,
    params: unknown[],
  ) => Promise<Record<string, unknown>[]>;
};

/**
 * The ONE Actor producer for the HTTP plane.
 *
 * requestId is minted here with crypto.randomUUID() and is the value the Worker
 * forwards to Vercel as x-mb-request-id (§2.4) and writes to audit_log.request_id.
 */
export function makeResolveActor(
  env: IdentityEnv,
  ctx: ExecutionContext,
  deps: ResolveActorDeps = {},
) {
  const runQuery =
    deps.query ??
    ((connStr: string, sql: string, params: unknown[]) =>
      withClient(connStr, (c) =>
        c.query(sql, params).then((r: { rows: Record<string, unknown>[] }) => r.rows),
      ));

  return async function resolveActor(request: Request): Promise<Actor> {
    const requestId = crypto.randomUUID();
    const verifiedAt = new Date().toISOString();
    const { payment, paymentTransport } = paymentFrom(request);

    // ── Row 0: a presented Signature verifies or rejects, never falls through. ──
    const wba: AgentVerdict = await classifySignature(request, env);
    if (wba.kind === "reject")
      throw new WebBotAuthRejected(wba.status, wba.reason, wba.status === 503 ? 30 : undefined);

    // ── Row 1: Authorization: Bearer mb_dlg_… → owner_agent (FRESH; §5.7.6: the
    //    state read is never cached — a 75 s revocation window is not OK). ──
    const auth = request.headers.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    if (bearer !== null && DELEGATION_RE.test(bearer)) {
      const tokenHash = await sha256Hex(bearer);
      const d = (
        await runQuery(
          env.HYPERDRIVE_FRESH.connectionString,
          `select id, owner_user_id, agent_identity_id, connector_slug, scopes,
                  requires_approval, state, expires_at, quarantined_until,
                  declared_intent
             from app.resolve_delegation($1)`,
          [tokenHash],
        )
      )[0] as
        | {
            id: string;
            owner_user_id: string;
            agent_identity_id: string;
            connector_slug: string;
            scopes: string[];
            requires_approval: boolean;
            state: string;
            expires_at: string | null;
            quarantined_until: string | null;
            declared_intent: string | null;
          }
        | undefined;
      if (
        !d ||
        d.state !== "active" ||
        (d.expires_at !== null && new Date(d.expires_at) <= new Date())
      ) {
        throw new CredentialRejected("delegation_token_inactive");
      }
      return {
        class: "owner_agent",
        plane: "agent",
        userId: d.owner_user_id,
        delegationId: d.id,
        agentIdentityId: d.agent_identity_id,
        connectorSlug: d.connector_slug,
        scopes: d.scopes,
        requiresApproval: d.requires_approval,
        walletAddress: null,
        evidence: [{ kind: "delegation_token", detail: d.connector_slug, verifiedAt }],
        requestId,
        payerAddress: null,
        payment,
        paymentTransport,
        declaredIntent:
          d.declared_intent === "crawl" || d.declared_intent === "train"
            ? d.declared_intent
            : "read",
        directoryKeyid: null,
      };
    }

    // ── Row 2: Cookie: mb_session → human_creator (FRESH, same revocation rule). ──
    const cookieHeader = request.headers.get("cookie") ?? "";
    const mbSession = cookieHeader
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith("mb_session="))
      ?.slice("mb_session=".length);
    if (mbSession) {
      const tokenHash = await sha256Hex(mbSession);
      const session = (
        await runQuery(
          env.HYPERDRIVE_FRESH.connectionString,
          `select id, user_id, wallet from app.read_session_by_token($1)`,
          [tokenHash],
        )
      )[0] as { id: string; user_id: string; wallet: string | null } | undefined;
      if (session) {
        return {
          class: "human_creator",
          plane: "human",
          userId: session.user_id,
          sessionId: session.id,
          walletAddress: session.wallet,
          scopes: [],
          evidence: [{ kind: "siwe_session", detail: session.id, verifiedAt }],
          requestId,
          payerAddress: session.wallet,
          payment,
          paymentTransport,
          declaredIntent: "read",
          directoryKeyid: null,
        };
      }
      // A dead cookie is ordinary browser expiry — fall through, do not reject.
    }

    // ── Row 3: the signature from row 0 verified → crawler_agent (web_bot_auth).
    //    agent_identities read is pure catalog data → HYPERDRIVE_CACHED. ──
    if (wba.kind === "agent") {
      const signatureAgent = wba.agentUri;
      const identity = (
        await runQuery(
          env.HYPERDRIVE_CACHED.connectionString,
          `select id, wallet_address from app.read_agent_identity($1, 'signature_agent')`,
          [signatureAgent],
        )
      )[0] as { id: string; wallet_address: string | null } | undefined;
      // The sighting is owed on the existing outbox path — after the response,
      // never before it. On a cache miss this request proceeds with id null.
      ctx.waitUntil(
        (async () => {
          const sighting: AgentSighting = {
            signatureAgent,
            keyid: wba.keyid,
            seenAt: new Date().toISOString(),
          };
          try {
            const rows = await runQuery(
              env.HYPERDRIVE_FRESH.connectionString,
              `select app.enqueue_sighting($1, $2::jsonb) as job_id`,
              [`sighting:${wba.keyid}:${sighting.seenAt.slice(0, 13)}`, sighting],
            );
            const jobId = rows[0]?.job_id as number | null | undefined;
            if (jobId !== null && jobId !== undefined) await env.Q_CLASSIFY.send({ job_id: jobId });
          } catch (e) {
            console.error("sighting_enqueue_deferred", String(e));
          }
        })(),
      );
      return {
        class: "crawler_agent",
        plane: "agent",
        userId: null,
        agentIdentityId: identity?.id ?? null,
        signatureAgent,
        verification: "web_bot_auth",
        walletAddress: identity?.wallet_address ?? null,
        scopes: [],
        evidence: [{ kind: "web_bot_auth", detail: signatureAgent, verifiedAt }],
        requestId,
        payerAddress: identity?.wallet_address ?? null,
        payment,
        paymentTransport,
        declaredIntent: "crawl",
        directoryKeyid: wba.keyid,
      };
    }

    // ── Row 4: forward-confirmed reverse DNS → crawler_agent (verified_crawler). ──
    const clientIp = rawClientIp(request.headers);
    const userAgent = request.headers.get("user-agent") ?? "";
    if (clientIp && userAgent) {
      const slug = await verifiedCrawler(env, clientIp, userAgent);
      if (slug !== null) {
        const identity = (
          await runQuery(
            env.HYPERDRIVE_CACHED.connectionString,
            `select id from app.read_agent_identity($1, 'slug')`,
            [slug],
          )
        )[0]?.id as string | undefined;
        return {
          class: "crawler_agent",
          plane: "agent",
          userId: null,
          agentIdentityId: identity ?? null,
          signatureAgent: null,
          verification: "verified_crawler",
          walletAddress: null,
          scopes: [],
          evidence: [{ kind: "verified_crawler_rdns", detail: slug, verifiedAt }],
          requestId,
          payerAddress: null,
          payment,
          paymentTransport,
          declaredIntent: "crawl",
          directoryKeyid: null,
        };
      }
    }

    // ── Row 5: Cloudflare's vendor signals — evidence only, never access. ──
    const cf = (request as { cf?: Record<string, unknown> }).cf;
    const cfVerifiedBot = cf?.verifiedBot === true;
    const cfCategory = typeof cf?.verifiedBotCategory === "string" ? cf.verifiedBotCategory : null;
    const cfScore = typeof cf?.score === "number" ? cf.score : null;
    if (cfVerifiedBot || cfScore !== null) {
      const evidence: Actor["evidence"] = [
        { kind: "ua_declared", detail: userAgent.slice(0, 200), verifiedAt },
      ];
      if (cfVerifiedBot)
        evidence.unshift({
          kind: "cf_verified_bot",
          detail: cfCategory ?? "true",
          verifiedAt,
        });
      if (cfScore !== null)
        evidence.push({ kind: "cf_bot_score", detail: String(cfScore), verifiedAt });
      return {
        class: "crawler_agent",
        plane: "agent",
        userId: null,
        agentIdentityId: null,
        signatureAgent: null,
        verification: "none",
        walletAddress: null,
        scopes: [],
        evidence,
        requestId,
        payerAddress: null,
        payment,
        paymentTransport,
        declaredIntent: "unknown",
        directoryKeyid: null,
      };
    }

    // ── Row 6: the documented fail-open-to-human default. ──
    return {
      class: "human_reader",
      plane: "human",
      userId: null,
      sessionId: null,
      walletAddress: null,
      scopes: [],
      evidence: [{ kind: "none", verifiedAt }],
      requestId,
      payerAddress: null,
      payment,
      paymentTransport,
      declaredIntent: "read",
      directoryKeyid: null,
    };
  };
}

/**
 * §5.6.2's fail-direction table at the HTTP boundary: a presented-but-bad
 * credential becomes a RESPONSE, not a thrown exception escaping fetch().
 * WebBotAuthRejected keeps its own status (401, or 503 + Retry-After: 30 on an
 * unreachable directory); CredentialRejected is always a 401. Anything else
 * still throws — spine invariant 9 covers the access check, not this ladder.
 */
export async function actorOrResponse(
  env: IdentityEnv,
  ctx: ExecutionContext,
  request: Request,
  deps: ResolveActorDeps = {},
): Promise<Actor | Response> {
  try {
    return await makeResolveActor(env, ctx, deps)(request);
  } catch (e) {
    if (e instanceof WebBotAuthRejected) {
      return new Response(`${e.reason}\n`, {
        status: e.status,
        headers:
          e.retryAfter === undefined
            ? { "content-type": "text/plain; charset=utf-8" }
            : { "content-type": "text/plain; charset=utf-8", "retry-after": String(e.retryAfter) },
      });
    }
    if (e instanceof CredentialRejected) {
      return new Response(`${e.reason}\n`, {
        status: 401,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw e;
  }
}
