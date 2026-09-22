// packages/connectors/src/egress.ts — §10.8.2 verbatim
import { signOutbound } from "./sign.js"; // 10.8.4
import type { JsonWebKey } from "./types.js";

export interface GuardOptions {
  allowHosts: readonly string[]; // exact hostnames from the connector manifest
  totalTimeoutMs?: number; // env.CONNECTOR_EGRESS_TIMEOUT_MS, default 60_000
  maxBytes?: number; // env.CONNECTOR_EGRESS_MAX_BYTES, default 8_388_608
  signingKey?: JsonWebKey | undefined; // env.CONNECTOR_SIGNING_PRIVATE_KEY, imported once
  /** Optional post-DNS address check. Supplied ONLY on the Node call site; see below. */
  resolveAndCheck?: (hostname: string) => Promise<void>;
}

export function makeGuardedFetch(opts: GuardOptions) {
  const allow = new Set(opts.allowHosts.map((h) => h.toLowerCase()));
  return async function guardedFetch(
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const u = new URL(url);
    if (u.protocol !== "https:") throw new Error("egress_https_only");
    if (!allow.has(u.hostname.toLowerCase()))
      throw new Error("egress_host_not_allowed");
    if (u.username || u.password) throw new Error("egress_credentials_in_url");
    if (opts.resolveAndCheck) await opts.resolveAndCheck(u.hostname);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.totalTimeoutMs ?? 60_000);
    try {
      const signed = opts.signingKey
        ? await signOutbound(u, init, opts.signingKey) // RFC 9421, 10.8.4
        : init;
      const res = await fetch(u, {
        ...signed,
        redirect: "manual", // a 3xx is a failure, never a hop
        signal: ac.signal,
        headers: {
          ...(signed.headers ?? {}),
          "user-agent": "Musebook/1.0 (+https://musebook.dev)",
        },
      });
      if (res.status >= 300 && res.status < 400)
        throw new Error("egress_redirect_refused");
      const len = Number(res.headers.get("content-length") ?? "0");
      if (len > (opts.maxBytes ?? 8 * 1024 * 1024))
        throw new Error("egress_body_too_large");
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
}
