// packages/kernel/src/ports.ts — plan.md §6.3, verbatim.
import type { Actor, PaymentRequired, Resource, SettleResponse } from "@musebook/schema";
import type { ResourceRow } from "./load.js";

/** Runs packages/kernel/sql/load_resource.sql (or its by-id twin). Null when no live row. */
export interface ResourcePort {
  loadRowBySlug(slug: string): Promise<ResourceRow | null>;
  loadRowByPostId(postId: string): Promise<ResourceRow | null>;
}

export interface Grant {
  readonly id: string;
  readonly settlementId: string;
  readonly contentHash: string;
  readonly payer: string;
  readonly expiresAt: string | null;
}

export interface GrantPort {
  findLiveGrant(q: {
    contentHash: string;
    payer: string | null;
    agentId: string | null;
    userId: string | null;
  }): Promise<Grant | null>;

  mintGrant(g: {
    settlementId: string;
    contentHash: string;
    postId: string;
    payer: string;
    subjectAgentId: string | null;
    subjectUserId: string | null;
    expiresAt: string | null;
  }): Promise<Grant>;
}

export type SettleOutcome =
  | { kind: "settled"; settlementId: string; payer: string; response: SettleResponse }
  | { kind: "idempotent"; settlementId: string; payer: string; response: SettleResponse }
  | { kind: "in_flight" }
  | { kind: "consumed" }
  | { kind: "quote_expired" }
  | { kind: "quote_mismatch"; detail: string }
  | { kind: "invalid"; invalidReason: string }
  | { kind: "unavailable" };

export interface PaymentPort {
  /** Build and persist a pinned quote, returning the v2 PaymentRequired to serve. */
  challenge(input: {
    resource: Resource;
    actor: Actor;
    resourceUrl: string;
    mimeType: string;
    error?: string;
  }): Promise<PaymentRequired>;

  /** Verify -> insert replay row -> settle -> flip. See §6.6. */
  settle(input: { resource: Resource; actor: Actor; resourceUrl: string }): Promise<SettleOutcome>;
}

export interface PolicyPort {
  isAgentBlocked(agentId: string): Promise<boolean>;
  previewChars(resource: Resource): number; // env.PREVIEW_CHARS, default 400 — see §6.6
  /**
   * The canonical site origin, no trailing slash — `https://musebook.dev`.
   * The Worker adapter DERIVES it from the request host (§6.3).
   */
  siteOrigin(): string;
  mode(): "live" | "shadow" | "off"; // env.X402_MODE
}

export interface KernelPorts {
  readonly now: () => Date;
  readonly resources: ResourcePort;
  readonly grants: GrantPort;
  readonly payments: PaymentPort;
  readonly policy: PolicyPort;
  readonly log: (event: {
    level: "info" | "warn" | "error";
    msg: string;
    [k: string]: unknown;
  }) => void;
}
