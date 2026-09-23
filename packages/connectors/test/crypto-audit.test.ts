// packages/connectors/test/crypto-audit.test.ts — §10.8.1 credential sealing
// (HKDF per delegation + AES-GCM, iv||tag||body) and §5.7.7's audit mapping.
import { describe, expect, it, vi } from "vitest";
import { sealCredential, openCredential } from "../src/crypto.js";
import { audit, auditFromActor, type Queryable } from "../src/audit.js";
import type { Actor } from "@musebook/schema";

const KEK = crypto.getRandomValues(new Uint8Array(32));
const DLG = "cccccccc-cccc-4ccc-8ccc-0000000000aa";
const DLG_OTHER = "cccccccc-cccc-4ccc-8ccc-0000000000bb";

const U1 = "11111111-1111-4111-8111-000000000003";
const AG = "cccccccc-cccc-4ccc-8ccc-000000000001";

describe("§10.8.1 — credential sealing", () => {
  it("round-trips a credential under the iv||tag||body layout", async () => {
    const { ciphertext, keyId } = await sealCredential(KEK, "k1", DLG, "sk-live-secret");
    expect(keyId).toBe("k1");
    // 12-byte iv + 16-byte tag + the 14-byte body.
    expect(ciphertext.length).toBe(12 + 16 + "sk-live-secret".length);
    expect(await openCredential(KEK, DLG, ciphertext)).toBe("sk-live-secret");
  });

  it("a different delegation id derives a different key: opening fails", async () => {
    const { ciphertext } = await sealCredential(KEK, "k1", DLG, "sk-live-secret");
    await expect(openCredential(KEK, DLG_OTHER, ciphertext)).rejects.toThrow();
  });

  it("a different KEK cannot open the seal", async () => {
    const { ciphertext } = await sealCredential(KEK, "k1", DLG, "sk-live-secret");
    await expect(
      openCredential(crypto.getRandomValues(new Uint8Array(32)), DLG, ciphertext),
    ).rejects.toThrow();
  });

  it("a flipped byte anywhere in tag or body fails GCM verification", async () => {
    const { ciphertext } = await sealCredential(KEK, "k1", DLG, "sk-live-secret");
    const tampered = Uint8Array.from(ciphertext);
    tampered[20]! ^= 0xff; // inside the 16-byte tag
    await expect(openCredential(KEK, DLG, tampered)).rejects.toThrow();
  });

  it("ivs are random: two seals of the same plaintext differ", async () => {
    const a = await sealCredential(KEK, "k1", DLG, "same");
    const b = await sealCredential(KEK, "k1", DLG, "same");
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });
});

describe("§5.7.7 — auditFromActor", () => {
  const base = { requestId: "req-1" };

  it("owner_agent maps delegation and agent identity", () => {
    const a = {
      ...base,
      class: "owner_agent",
      userId: U1,
      delegationId: DLG,
      agentIdentityId: AG,
    } as unknown as Actor;
    expect(auditFromActor(a)).toEqual({
      actor: "owner_agent",
      actor_user_id: U1,
      actor_agent_id: AG,
      delegation_id: DLG,
      request_id: "req-1",
    });
  });

  it("crawler_agent maps the agent identity but never a delegation", () => {
    const a = {
      ...base,
      class: "crawler_agent",
      userId: null,
      agentIdentityId: AG,
    } as unknown as Actor;
    expect(auditFromActor(a)).toEqual({
      actor: "crawler_agent",
      actor_user_id: null,
      actor_agent_id: AG,
      delegation_id: null,
      request_id: "req-1",
    });
  });

  it("human_creator maps userId and nulls the agent fields", () => {
    const a = {
      ...base,
      class: "human_creator",
      userId: U1,
    } as unknown as Actor;
    expect(auditFromActor(a)).toEqual({
      actor: "human_creator",
      actor_user_id: U1,
      actor_agent_id: null,
      delegation_id: null,
      request_id: "req-1",
    });
  });

  it("human_reader maps a null userId", () => {
    const a = {
      ...base,
      class: "human_reader",
      userId: null,
    } as unknown as Actor;
    expect(auditFromActor(a).actor_user_id).toBeNull();
  });
});

describe("audit()", () => {
  it("inserts exactly one row via app.audit_log_insert", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const q: Queryable = { query };
    await audit(q, { actor: "owner_agent", action: "post.publish" });
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toBe("select app.audit_log_insert($1::jsonb)");
    expect(params).toEqual([{ actor: "owner_agent", action: "post.publish" }]);
  });
});
