// agent-scope.test.ts — node-tier coverage for @musebook/connectors. §17.14
// measures this package in the Node tier, so the requireAgentScope ladder and
// the audit writer run here against injected fakes; the same paths are also
// exercised in workerd by apps/edge/test/auth.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";
import type { Actor } from "@musebook/schema";
import {
  QUARANTINE_ALLOWED,
  requireAgentScope,
  type OwnerAgent,
} from "../src/require-agent-scope.js";
import { audit, auditFromActor } from "../src/audit.js";

const DELEGATION_ID = "00000000-0000-4000-8000-000000000010";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_ID = "00000000-0000-4000-8000-000000000003";

const ownerActor = (scopes: readonly string[]): OwnerAgent => ({
  class: "owner_agent",
  plane: "agent",
  userId: USER_ID,
  delegationId: DELEGATION_ID,
  agentIdentityId: AGENT_ID,
  connectorSlug: "openai",
  scopes: [...scopes],
  requiresApproval: true,
  walletAddress: null,
  evidence: [{ type: "signature", value: "sig" }],
  requestId: "req-test",
  payerAddress: null,
  payment: null,
  paymentTransport: null,
  declaredIntent: "read",
  directoryKeyid: null,
});

const ACTIVE = {
  state: "active",
  expires_at: null,
  rate_limit_per_hour: 60,
  quarantined_until: null,
};

const freshFor = (rows: Record<string, unknown>[]) =>
  ({ query: vi.fn(async () => ({ rows })) }) as unknown as Client;

const allow = () => Promise.resolve(true);

describe("requireAgentScope", () => {
  it("non-agent classes are 401 delegation_required", async () => {
    const human = {
      class: "human_reader",
      plane: "human",
      userId: null,
      sessionId: null,
      walletAddress: null,
      scopes: [],
      evidence: [{ type: "signature", value: "s" }],
      requestId: "req",
      payerAddress: null,
      payment: null,
      paymentTransport: null,
      declaredIntent: "read",
      directoryKeyid: null,
    } as unknown as Actor;
    const gate = await requireAgentScope(human, "post:write", {
      fresh: freshFor([]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: "delegation_required" });
  });

  it("missing scope is 403 naming the scope", async () => {
    const gate = await requireAgentScope(ownerActor(["feed:read"]), "post:write", {
      fresh: freshFor([ACTIVE]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: false, status: 403, error: "insufficient_scope:post:write" });
  });

  it("missing delegation row is 401", async () => {
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: "delegation_inactive" });
  });

  it("inactive state is 401", async () => {
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([{ ...ACTIVE, state: "revoked" }]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: "delegation_inactive" });
  });

  it("expired delegation is 401", async () => {
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([{ ...ACTIVE, expires_at: "2020-01-01T00:00:00Z" }]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: false, status: 401, error: "delegation_inactive" });
  });

  it("quarantine blocks non-read scopes, allows reads", async () => {
    const quarantined = {
      ...ACTIVE,
      quarantined_until: new Date(Date.now() + 60_000).toISOString(),
    };
    const actor = ownerActor(["feed:read", "post:write"]);
    const write = await requireAgentScope(actor, "post:write", {
      fresh: freshFor([quarantined]),
      limit: allow,
    });
    expect(write).toMatchObject({ ok: false, status: 403, error: "delegation_quarantined" });
    const read = await requireAgentScope(actor, "feed:read", {
      fresh: freshFor([quarantined]),
      limit: allow,
    });
    expect(read.ok).toBe(true);
    expect(QUARANTINE_ALLOWED.has("audit:read")).toBe(true);
  });

  it("expired quarantine does not block", async () => {
    const stale = {
      ...ACTIVE,
      quarantined_until: new Date(Date.now() - 60_000).toISOString(),
    };
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([stale]),
      limit: allow,
    });
    expect(gate.ok).toBe(true);
  });

  it("rate limiter false is 429", async () => {
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([ACTIVE]),
      limit: () => Promise.resolve(false),
    });
    expect(gate).toMatchObject({ ok: false, status: 429, error: "rate_limited" });
  });

  it("passes through with null reservation when no spend is requested", async () => {
    const gate = await requireAgentScope(ownerActor(["post:write"]), "post:write", {
      fresh: freshFor([ACTIVE]),
      limit: allow,
    });
    expect(gate).toMatchObject({ ok: true, reservationId: null });
  });

  it("spend hold success returns the reservation id", async () => {
    const fresh = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [ACTIVE] })
        .mockResolvedValueOnce({
          rows: [{ allowed: true, reason: "ok", reservation_id: "res-1", remaining_atomic: "900" }],
        }),
    } as unknown as Client;
    const gate = await requireAgentScope(
      ownerActor(["post:write"]),
      "post:write",
      { fresh, limit: allow },
      { estimateAtomic: 100n, purpose: "connector.call", idempotencyKey: "k0" },
    );
    expect(gate).toMatchObject({ ok: true, reservationId: "res-1" });
  });

  it("spend reserve allowed carries reservation_id", async () => {
    const fresh = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [ACTIVE] })
        .mockResolvedValueOnce({
          rows: [{ allowed: true, reason: "ok", reservation_id: "res-9", remaining_atomic: "7" }],
        }),
    } as unknown as Client;
    const gate = await requireAgentScope(
      ownerActor(["post:write"]),
      "post:write",
      { fresh, limit: allow },
      { estimateAtomic: 100n, purpose: "connector.call", idempotencyKey: "k1" },
    );
    expect(gate).toMatchObject({ ok: true, reservationId: "res-9" });
  });

  it("spend denied with delegation_* reason is 403; budget reason is 429", async () => {
    const makeFresh = (reason: string) =>
      ({
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [ACTIVE] })
          .mockResolvedValueOnce({
            rows: [{ allowed: false, reason, reservation_id: null, remaining_atomic: "0" }],
          }),
      }) as unknown as Client;
    const spend = { estimateAtomic: 10n, purpose: "wallet.spend" as const, idempotencyKey: "k" };
    const quarantined = await requireAgentScope(
      ownerActor(["post:write"]),
      "post:write",
      { fresh: makeFresh("delegation_quarantined"), limit: allow },
      spend,
    );
    expect(quarantined).toMatchObject({ ok: false, status: 403 });
    const budget = await requireAgentScope(
      ownerActor(["post:write"]),
      "post:write",
      { fresh: makeFresh("budget_exceeded"), limit: allow },
      spend,
    );
    expect(budget).toMatchObject({ ok: false, status: 429, remainingAtomic: "0" });
  });
});

describe("audit", () => {
  it("issues one app.audit_log_insert call with the record as jsonb", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const fresh = { query } as unknown as Client;
    const rec = {
      actor: "owner_agent",
      actor_user_id: USER_ID,
      actor_agent_id: AGENT_ID,
      delegation_id: DELEGATION_ID,
      action: "delegation.revoke",
      target_kind: "delegation",
      target_id: DELEGATION_ID,
      request_id: "req",
    };
    await audit(fresh, rec);
    expect(query).toHaveBeenCalledWith("select app.audit_log_insert($1::jsonb)", [
      JSON.stringify(rec),
    ]);
  });

  it("auditFromActor maps each actor class", () => {
    const owner = auditFromActor(ownerActor(["x"]));
    expect(owner).toMatchObject({
      actor: "owner_agent",
      actor_user_id: USER_ID,
      actor_agent_id: AGENT_ID,
      delegation_id: DELEGATION_ID,
      request_id: "req-test",
    });
    const crawler = {
      class: "crawler_agent",
      plane: "agent",
      userId: null,
      agentIdentityId: AGENT_ID,
      signatureAgent: null,
      verification: "none",
      walletAddress: null,
      scopes: [],
      evidence: [{ type: "signature", value: "s" }],
      requestId: "req-c",
      payerAddress: null,
      payment: null,
      paymentTransport: null,
      declaredIntent: "crawl",
      directoryKeyid: null,
    } as const;
    const c = auditFromActor(crawler as unknown as Actor);
    expect(c.actor_agent_id).toBe(AGENT_ID);
    expect(c.delegation_id).toBeNull();
    const human = {
      class: "human_reader",
      plane: "human",
      userId: null,
      sessionId: null,
      walletAddress: null,
      scopes: [],
      evidence: [{ type: "signature", value: "s" }],
      requestId: "req-h",
      payerAddress: null,
      payment: null,
      paymentTransport: null,
      declaredIntent: "read",
      directoryKeyid: null,
    } as const;
    const h = auditFromActor(human as unknown as Actor);
    expect(h.actor_agent_id).toBeNull();
    expect(h.actor_user_id).toBeNull();
  });
});
