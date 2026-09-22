// packages/kernel/test/fixtures/actors.ts — plan.md §6.13, verbatim.
import { actorSchema, type Actor } from "@musebook/schema";

/** ISO-8601 form of §17.3's seed epoch. The only timestamp in the kernel fixtures. */
export const SEED_EPOCH = "2026-09-22T12:00:00Z";

export const HUMAN: Actor = actorSchema.parse({
  class: "human_reader",
  plane: "human",
  userId: null,
  sessionId: null,
  walletAddress: null,
  scopes: [],
  evidence: [{ kind: "none", verifiedAt: SEED_EPOCH }],
  requestId: "fixture-human",
  payerAddress: null,
  payment: null,
  paymentTransport: null,
  declaredIntent: "read",
  directoryKeyid: null,
});

export const AGENT: Actor = actorSchema.parse({
  class: "crawler_agent",
  plane: "agent",
  userId: null,
  agentIdentityId: "00000000-0000-4000-8000-00000000a9e7",
  signatureAgent: "https://agent.example",
  verification: "web_bot_auth",
  walletAddress: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
  scopes: [],
  evidence: [{ kind: "web_bot_auth", detail: "https://agent.example", verifiedAt: SEED_EPOCH }],
  requestId: "fixture-agent",
  payerAddress: "0x857b06519e91e3a54538791bdbb0e22373e36b66",
  payment: null,
  paymentTransport: null,
  declaredIntent: "crawl",
  directoryKeyid: "poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U",
});
