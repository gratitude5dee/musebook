// apps/web/lib/ratelimit.ts — a Postgres-backed fixed-window limiter for the
// Vercel plane. Serverless instances share no memory, so an in-process Map
// would reset on every cold start; rate_limit_buckets (§5.9's companion) is
// the deterministic counter store. This is best-effort, not a ledger.
import { serviceDb } from "@/lib/db/service";

/**
 * Returns true when the key may proceed; false when the window's count has
 * reached `n`. One atomic increment-or-reset inside public.check_rate_limit —
 * concurrent calls cannot both pass a full window.
 */
export async function rateLimit(key: string, n: number, windowS: number): Promise<boolean> {
  const { data, error } = await serviceDb
    .rpc("check_rate_limit", {
      p_key: key,
      p_limit: n,
      p_window_s: windowS,
    })
    .returns<boolean | null>();
  if (error) {
    // A limiter failure must not take the auth surface down with it.
    console.error("rate_limit_degraded", key, error.message);
    return true;
  }
  return data === true;
}
