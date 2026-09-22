import { env } from "cloudflare:test";
import pg from "pg";
import { describe, expect, it } from "vitest";

describe("pg over the Hyperdrive localConnectionString", () => {
  it("connects to the local Supabase from workerd", async () => {
    const client = new pg.Client({
      connectionString: env.HYPERDRIVE_FRESH.connectionString,
    });
    await client.connect();
    const { rows } = await client.query("select 1 as one");
    await client.end();
    expect(rows[0]?.one).toBe(1);
  });

  it("runs a parameterized query + a second client on the same binding", async () => {
    const a = new pg.Client({ connectionString: env.HYPERDRIVE_FRESH.connectionString });
    const r1 = await a.query("select $1::text as v", ["hello"]);
    await a.end();
    const b = new pg.Client({ connectionString: env.HYPERDRIVE_FRESH.connectionString });
    // musebook_worker (the connstring role) reaches the plane helper under RLS —
    // the two-role test topology's proof that app.enter resolves for it.
    const r2 = await b.query("select slug from app.load_resource_by_slug($1, $2::uuid)", [
      "seed-article-free",
      null,
    ]);
    await b.end();
    expect(r1.rows[0]?.v).toBe("hello");
    expect(r2.rows[0]?.slug).toBe("seed-article-free");
  });
});
