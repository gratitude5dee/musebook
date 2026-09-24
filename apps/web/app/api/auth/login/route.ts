// apps/web/app/api/auth/login/route.ts — §5.4.2 verbatim.
export const runtime = "nodejs";

import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { thirdwebAuth } from "@/lib/auth/thirdweb-auth";
import { serviceDb } from "@/lib/db/service";
import { audit } from "@/lib/audit";
import { requireSameOrigin } from "@/lib/auth/csrf";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export async function POST(req: Request) {
  const originError = requireSameOrigin(req);
  if (originError) return originError;

  const { payload, signature } = (await req.json()) as {
    payload: Parameters<typeof thirdwebAuth.verifyPayload>[0]["payload"];
    signature: string;
  };

  // (1) MANDATORY .valid branch. The success member is the only thing that
  //     carries the verified payload; there is no other way to narrow it.
  const verified = await thirdwebAuth.verifyPayload({ payload, signature });
  if (!verified.valid) {
    await audit({
      actor: "human_reader",
      action: "auth.login.rejected",
      after_state: { reason: verified.error },
    });
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  const address = verified.payload.address.toLowerCase();
  const chainId = Number(verified.payload.chain_id ?? 8453);

  // (2) Single-use nonce consumption. One statement, conditional, atomic.
  //     Two concurrent replays: exactly one UPDATE matches, the other gets 0 rows.
  const { data: consumed } = await serviceDb
    .from("wallet_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", verified.payload.nonce)
    .eq("address", address)
    .eq("action", "siwe:login")
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("message")
    .maybeSingle()
    .returns<{ message: string }>();

  if (!consumed) {
    return Response.json({ error: "nonce_replay_or_expired" }, { status: 401 });
  }

  // (3) The submitted payload must match what we issued, field by field.
  //     NOT a byte comparison of the serialization: the payload round-trips
  //     through Response.json() -> r.json() -> ConnectButton -> fetch, and
  //     thirdweb reconstructs the LoginPayload object to build the EIP-4361
  //     message, so key order and undefined-field normalization are not ours.
  const issued = JSON.parse(consumed.message) as typeof payload;
  const same =
    issued.domain === payload.domain &&
    issued.address.toLowerCase() === payload.address.toLowerCase() &&
    issued.chain_id === payload.chain_id &&
    issued.expiration_time === payload.expiration_time &&
    issued.uri === payload.uri &&
    issued.statement === payload.statement &&
    JSON.stringify(issued.resources ?? []) === JSON.stringify(payload.resources ?? []);
  if (!same) {
    await audit({
      actor: "human_reader",
      action: "auth.login.payload_mutated",
      after_state: { address, nonce: verified.payload.nonce },
    });
    return Response.json({ error: "payload_mismatch" }, { status: 401 });
  }

  // (4) Bind the address to a users row. See 5.5 for the SQL.
  const { data: linked, error: linkErr } = await serviceDb
    .rpc("link_wallet_identity", {
      p_address: address,
      p_chain_id: chainId,
    })
    .single<{ user_id: string; handle: string; created: boolean }>();
  if (linkErr || !linked) {
    return Response.json({ error: "identity_link_failed" }, { status: 500 });
  }

  // (5) Mint the opaque session. Only the hash is stored.
  //     ip_hash comes from x-mb-client-ip, which musebook-edge sets from the
  //     PoP client-IP header (§2.7). x-forwarded-for is Cloudflare PoP data
  //     here and hashing it would bucket every user in a region into one value.
  const raw = `mbs_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const { error: sessErr } = await serviceDb.from("sessions").insert({
    user_id: linked.user_id,
    actor: "human_creator",
    token_sha256: sha256hex(raw),
    expires_at: expiresAt.toISOString(),
    ip_hash: sha256hex(req.headers.get("x-mb-client-ip") || "unknown"),
    user_agent: (req.headers.get("user-agent") ?? "").slice(0, 512),
  });
  if (sessErr) {
    return Response.json({ error: "session_create_failed" }, { status: 500 });
  }

  (await cookies()).set("__Host-mb_session", raw, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });

  await audit({
    actor: "human_creator",
    actor_user_id: linked.user_id,
    action: linked.created ? "auth.signup" : "auth.login",
    after_state: { address, chain_id: chainId },
  });

  return Response.json({ ok: true, userId: linked.user_id, handle: linked.handle });
}
