// apps/web/lib/db/service.ts — the Vercel plane's privileged PostgREST client.
// SUPABASE_SECRET_KEY is a Vercel env (server-only); it is never given to a
// Worker (which speaks the Postgres wire protocol, and service_role cannot log
// in anyway — rolcanlogin = false) and never to the client bundle.
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Built lazily for the same reason as thirdweb-auth: `next build` page-data
// collection imports the module without Vercel env, and createClient throws on
// a missing URL at construction time.
let cached: SupabaseClient | undefined;
function live() {
  if (cached === undefined) {
    // Free inference: assigning createClient straight into the annotated
    // `cached` would contextual-type its generics to never.
    const client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SECRET_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        db: { schema: "public" },
      },
    );
    cached = client;
  }
  return cached;
}

export const serviceDb = new Proxy({} as ReturnType<typeof live>, {
  get: (_target, prop: string | symbol) =>
    (live() as unknown as Record<PropertyKey, unknown>)[prop],
});
