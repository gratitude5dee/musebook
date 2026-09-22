// packages/connectors/test/contract/suite.ts — §17.10 verbatim, one adaptation:
// the remote-failure and off-allowlist assertions only apply to transports that
// place a URL on the wire. bridge_token has no transport URL (the far side is a
// process the USER runs — the only socket is its outbound long-poll to
// musebook.dev), so for it the same contract is asserted differently: health is
// deferred, no fetch is ever attempted, and there is nothing to poison.
import { beforeEach, expect, it } from "vitest";
import type { AgentConnector, ConnectorContext, HandshakeRequest } from "../../src/connector.js";
import type { ConnectorManifest } from "../../src/manifest.js";

export interface ContractHarness {
  /** The transport kind, as the manifest spells it: mcp_http | a2a_card | http_openapi | bridge_token. */
  readonly name: ConnectorManifest["transports"][number]["kind"];
  /** The manifest the adapter is built from. Its `capabilities` drive the draftPost assertion. */
  readonly manifest: ConnectorManifest;
  /** Whether the transport makes outbound calls itself. false for bridge_token. */
  readonly hasRemote: boolean;
  /** Builds the adapter with its transport stubbed, from `manifest`. */
  make(manifest?: ConnectorManifest): AgentConnector;
  /** A ConnectorContext for the seeded delegation (§17.3.2), with ctx.fetch bound to guardedFetch. */
  ctx(): ConnectorContext;
  /** The seeded HandshakeRequest. */
  handshakeRequest(): HandshakeRequest;
  /** Makes the stubbed remote return a 500 for the next call. */
  breakRemote(): void;
  /** Makes the stubbed remote hang past the adapter's timeout. */
  hangRemote(): void;
  /** Number of requests the stub layer has seen since make(). */
  requestCount(): number;
  /** Clears breakRemote/hangRemote/requestCount. runConnectorContract wires it to beforeEach. */
  resetRemote(): void;
}

const POISON_URL = "http://169.254.169.254/";

/** Replaces whichever URL-bearing field the transport carries (D-entry: the
 *  verbatim suite assumed a field literally named `url`, which only mcp_http has). */
function poisonTransports(m: ConnectorManifest): ConnectorManifest {
  return {
    ...m,
    transports: m.transports.map((t) => {
      if ("url" in t) return { ...t, url: POISON_URL };
      if ("agentCardUrl" in t) return { ...t, agentCardUrl: POISON_URL };
      if ("baseUrl" in t) return { ...t, baseUrl: POISON_URL };
      return t;
    }),
  };
}

export function runConnectorContract(h: ContractHarness): void {
  beforeEach(() => h.resetRemote());

  it(`${h.name}: the adapter reports the transport it was built for`, () => {
    const c = h.make();
    expect(c.transport).toBe(h.name);
    expect(c.manifest.connectorId).toBe(h.manifest.connectorId);
  });

  it(`${h.name}: handshake() grants a subset of the manifest's declared capabilities`, async () => {
    const r = await h.make().handshake(h.ctx(), h.handshakeRequest());
    for (const cap of r.grantedCapabilities) expect(h.manifest.capabilities).toContain(cap);
    expect(r.grantedCapabilities.length).toBeGreaterThan(0);
  });

  if (h.hasRemote) {
    it(`${h.name}: health() reports a remote 500 as { ok: false }, never as a throw`, async () => {
      h.breakRemote();
      const r = await h.make().health(h.ctx());
      expect(r.ok).toBe(false);
      expect(typeof r.latencyMs).toBe("number");
    });

    it(`${h.name}: a hang is cut at the adapter timeout`, async () => {
      h.hangRemote();
      const started = Date.now();
      const r = await h.make().health(h.ctx());
      expect(r.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(12_000);
    });

    it(`${h.name}: an off-allowlist transport URL is refused by guardedFetch before a socket opens`, async () => {
      // The hostile manifest points the transport at the metadata endpoint.
      // guardedFetch (§10.8.2) throws on the hostname/address check; the adapter
      // must not swallow it into a "remote error" — it is a configuration
      // refusal, and it happens before DNS-to-socket, which the stub layer
      // confirms by recording zero requests.
      const hostile = poisonTransports(h.manifest);
      const c = h.make(hostile);
      const r = await c.health(h.ctx());
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/^egress_(https_only|host_not_allowed|private_address|credentials_in_url)$/);
      expect(h.requestCount()).toBe(0);
    });
  } else {
    it(`${h.name}: health is deferred — no remote socket exists to probe`, async () => {
      const r = await h.make().health(h.ctx());
      expect(r.ok).toBe(true);
      expect(r.detail).toBe("bridge_deferred");
      expect(h.requestCount()).toBe(0);
    });

    it(`${h.name}: has no transport URL to poison — the egress corpus owns SSRF`, () => {
      const hostile = poisonTransports(h.manifest);
      const c = h.make(hostile);
      // The bridge never dials; poisoned or not, draftPost submits a handle.
      expect(typeof c.draftPost).toBe("function");
      expect(h.requestCount()).toBe(0);
    });
  }

  it(`${h.name}: draftPost is present exactly when the manifest declares post.draft`, () => {
    const c = h.make();
    expect(typeof c.draftPost).toBe(
      h.manifest.capabilities.includes("post.draft") ? "function" : "undefined",
    );
  });

  it(`${h.name}: revoke() is idempotent`, async () => {
    const c = h.make();
    await expect(c.revoke(h.ctx())).resolves.toBeUndefined();
    await expect(c.revoke(h.ctx())).resolves.toBeUndefined(); // second call: no throw, no second remote effect
  });

  it(`${h.name}: the credential never appears in any returned value`, async () => {
    const c = h.make();
    const out = [
      await c.handshake(h.ctx(), h.handshakeRequest()),
      await c.health(h.ctx()),
    ];
    expect(JSON.stringify(out)).not.toContain("SEED_CONNECTOR_CREDENTIAL");
  });
}
