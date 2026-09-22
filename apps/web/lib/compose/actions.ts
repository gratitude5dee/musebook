// apps/web/lib/compose/actions.ts — §14.4.3's draft write path: a server
// action over PostgREST. §4.14(f) bars a writable policy for authenticated,
// so the draft save rides the security-definer RPCs public.save_draft /
// public.load_draft under the caller's own JWT (minted here the same way
// /api/auth/supabase-token mints it — auth.uid() is what the RPCs check).
"use server";

import { cookies } from "next/headers";
import { SignJWT } from "jose";
import { accessToPublishMode } from "@musebook/kernel";
import { readSession } from "@/lib/auth/read-session";
import type { ComposerInitial, DraftInput, SavedDraft } from "@musebook/ui";

const TTL_SECONDS = 600;

async function userJwt(): Promise<{ token: string; userId: string } | null> {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const req = new Request("https://musebook.local/", {
    headers: { cookie: cookieHeader },
  });
  const session = await readSession(req);
  if (session === null) return null;

  const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
  const token = await new SignJWT({
    role: "authenticated",
    wallet_address: session.primaryWalletAddress ?? undefined,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(session.userId)
    .setAudience("authenticated")
    .setIssuer(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret);
  return { token, userId: session.userId };
}

async function rpc<T>(fn: string, token: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string } | null;
    throw new Error(body?.code ?? `postgrest_${res.status}`);
  }
  return (await res.json()) as T;
}

/** Decimal USD string → USDC atomic units (6 decimals). Parses the decimal
 *  without a float on the money path (§14.4.5). */
function usdToAtomic(usd: string): string {
  const m = /^(\d+)(?:\.(\d{1,2}))?/.exec(usd.trim());
  if (m === null) throw new Error("bad_price");
  const whole = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "0").padEnd(6, "0").slice(0, 6) || "0");
  return (whole * 1_000_000n + frac).toString(10);
}

interface SaveDraftRow {
  post_id: string;
  slug: string;
  version: number;
  content_hash: string;
}

export async function saveDraft(input: DraftInput): Promise<SavedDraft> {
  const auth = await userJwt();
  if (auth === null) throw new Error("unauthenticated");

  const rows = await rpc<SaveDraftRow[]>("save_draft", auth.token, {
    p_post_id: input.postId,
    p_markdown: input.markdown,
    p_title: input.title,
    p_summary: input.summary,
    p_kind: input.kind,
    // accessToPublishMode maps the picker's AccessChoice to the column value —
    // the only name that column gets outside packages/kernel (§6.3).
    p_access_mode: accessToPublishMode(input.access),
    p_price_atomic:
      input.access === "open" || input.priceUsd === null ? "0" : usdToAtomic(input.priceUsd),
    p_license_spdx: input.licenseSpdx,
    p_train_ai: input.trainAi,
    p_ai_use: input.aiUse,
    p_search_indexable: input.searchIndexable,
    p_tags: input.tags,
  });
  const row = rows[0];
  if (row === undefined) throw new Error("draft_not_saved");
  return {
    postId: row.post_id,
    slug: row.slug,
    version: row.version,
    contentHash: row.content_hash,
  };
}

interface LoadDraftRow {
  post_id: string;
  slug: string;
  title: string | null;
  summary: string | null;
  kind: string;
  status: string;
  access_mode: string;
  price_atomic: string | number;
  license_spdx: string;
  train_ai: boolean;
  ai_use: boolean;
  search_indexable: boolean;
  tags: string[];
  canonical_markdown: string | null;
  content_hash: string;
  live_grant_count: number;
}

/** Inverse of accessToPublishMode, for the edit page's initial state. The
 *  strings are the column values; the picker's vocabulary stays AccessChoice. */
function modeToAccess(mode: string): "open" | "toll" | "gated" {
  switch (mode) {
    case "free":
      return "open";
    case "human_free_agent_paid":
      return "toll";
    default:
      return "gated";
  }
}

function atomicToUsd(atomic: string | number): string {
  const a = BigInt(atomic);
  return `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0").slice(0, 2)}`;
}

export async function loadDraft(postId: string): Promise<ComposerInitial | null> {
  const auth = await userJwt();
  if (auth === null) return null;
  const rows = await rpc<LoadDraftRow[]>("load_draft", auth.token, { p_post_id: postId });
  const row = rows[0];
  if (row === undefined) return null;
  return {
    postId: row.post_id,
    slug: row.slug,
    contentHash: row.content_hash,
    status: row.status,
    liveGrantCount: Number(row.live_grant_count),
    kind: row.kind as ComposerInitial["kind"],
    markdown: row.canonical_markdown ?? "",
    title: row.title,
    summary: row.summary,
    access: modeToAccess(row.access_mode),
    priceUsd: row.access_mode === "free" ? null : atomicToUsd(row.price_atomic),
    licenseSpdx: row.license_spdx,
    trainAi: row.train_ai,
    aiUse: row.ai_use,
    searchIndexable: row.search_indexable,
    tags: row.tags ?? [],
  };
}

interface DefaultsRow {
  access_mode: string;
  license_spdx: string;
  train_ai: boolean;
  ai_use: boolean;
  price_cents: number;
}

/** The creator's publishing defaults, pre-filling a fresh draft (§14.4.5). */
export async function loadDefaults(): Promise<{
  access: "open" | "toll" | "gated";
  priceUsd: string | null;
  licenseSpdx: string;
  trainAi: boolean;
  aiUse: boolean;
  searchIndexable: boolean;
}> {
  const auth = await userJwt();
  const fallback = {
    access: "open" as const,
    priceUsd: null,
    licenseSpdx: "CC-BY-4.0",
    trainAi: false,
    aiUse: false,
    searchIndexable: true,
  };
  if (auth === null) return fallback;
  const rows = await rpc<DefaultsRow[]>("my_publishing_defaults", auth.token, {}).catch(
    () => [] as DefaultsRow[],
  );
  const row = rows[0];
  if (row === undefined) return fallback;
  return {
    access: modeToAccess(row.access_mode),
    priceUsd: row.access_mode === "free" ? null : (row.price_cents / 100).toFixed(2),
    licenseSpdx: row.license_spdx,
    trainAi: row.train_ai,
    aiUse: row.ai_use,
    searchIndexable: true,
  };
}
