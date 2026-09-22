// apps/web/app/api/agent/delegations/route.ts — §5.7.4 verbatim (POST) + the
// owner list (GET). Token material is returned exactly once, at mint; GET
// carries ids and metadata only.
export const runtime = "nodejs";

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { readSession } from "@/lib/auth/read-session";
import { requireSameOrigin } from "@/lib/auth/csrf";
import { serviceDb } from "@/lib/db/service";
import { audit } from "@/lib/audit";
import { ALL_SCOPES } from "@musebook/schema";

const Body = z.object({
  connectorSlug: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,40}$/),
  agentIdentityId: z.uuid(),
  scopes: z.array(z.enum(ALL_SCOPES)).min(1).max(ALL_SCOPES.length),
  spendCapAtomic: z
    .string()
    .regex(/^[0-9]{1,30}$/)
    .default("0"), // USDC atomic units
  spendWindowHours: z.number().int().min(1).max(720).default(24),
  rateLimitPerHour: z.number().int().min(1).max(10_000).default(60),
  requiresApproval: z.boolean().default(true),
  expiresInDays: z.number().int().min(1).max(365).default(30),
});

export async function POST(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  // Only a human cookie session may mint. An agent can never mint another
  // delegation: readSession does not read Authorization at all.
  const s = await readSession(req);
  if (!s) return Response.json({ error: "human_session_required" }, { status: 403 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return Response.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;

  const { data: connector } = await serviceDb
    .from("connectors")
    .select("id, is_enabled")
    .eq("slug", b.connectorSlug)
    .maybeSingle()
    .returns<{ id: string; is_enabled: boolean }>();
  if (!connector?.is_enabled) {
    return Response.json({ error: "unknown_connector" }, { status: 404 });
  }

  const raw = `mb_dlg_${randomBytes(32).toString("base64url")}`;
  const { data, error } = await serviceDb
    .from("delegations")
    .insert({
      owner_user_id: s.userId,
      connector_id: connector.id,
      agent_identity_id: b.agentIdentityId,
      state: "active",
      scopes: b.scopes,
      token_sha256: createHash("sha256").update(raw).digest("hex"),
      spend_cap_atomic: b.spendCapAtomic,
      spend_window: `${b.spendWindowHours} hours`,
      rate_limit_per_hour: b.rateLimitPerHour,
      requires_approval: b.requiresApproval,
      expires_at: new Date(Date.now() + b.expiresInDays * 86_400_000).toISOString(),
    })
    .select("id, expires_at")
    .single()
    .returns<{ id: string; expires_at: string }>();

  // delegations_one_active_per_pair: one active grant per (owner, connector, agent).
  if (error?.code === "23505") {
    return Response.json({ error: "active_delegation_exists" }, { status: 409 });
  }
  if (error || !data) {
    return Response.json({ error: "mint_failed" }, { status: 500 });
  }

  await audit({
    actor: "human_creator",
    actor_user_id: s.userId,
    delegation_id: data.id,
    action: "delegation.mint",
    target_kind: "delegation",
    target_id: data.id,
    after_state: {
      scopes: b.scopes,
      spend_cap_atomic: b.spendCapAtomic,
      spend_window_hours: b.spendWindowHours,
      requires_approval: b.requiresApproval,
      expires_at: data.expires_at,
    },
  });

  // The ONLY time the raw token is ever transmitted.
  return Response.json(
    { id: data.id, token: raw, expiresAt: data.expires_at },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

export async function GET(req: Request) {
  const s = await readSession(req);
  if (!s) return Response.json({ error: "human_session_required" }, { status: 403 });

  const { data, error } = await serviceDb
    .from("delegations")
    .select(
      "id, connector_id, agent_identity_id, state, scopes, spend_cap_atomic, spend_window, rate_limit_per_hour, requires_approval, expires_at, quarantined_until, created_at",
    )
    .eq("owner_user_id", s.userId)
    .order("created_at", { ascending: false });

  if (error) return Response.json({ error: "list_failed" }, { status: 500 });
  return Response.json({ delegations: data ?? [] }, { headers: { "cache-control": "no-store" } });
}
