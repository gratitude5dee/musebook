// apps/edge/src/auth/rdns.ts — §6.11 layer 2, verbatim.
// Forward-confirmed reverse DNS over DNS-over-HTTPS. The UA is the hint; the
// FCrDNS is the proof. DoH through global fetch (node:dns reverse is unverified
// on workerd — CF-SPINE §12), KV-cached so the common case costs 0 subrequests.
const VERIFIED_CRAWLERS: ReadonlyArray<{
  agentSlug: string;
  uaMatch: RegExp;
  suffixes: readonly string[];
}> = [
  { agentSlug: "gptbot", uaMatch: /GPTBot/i, suffixes: [".openai.com"] },
  { agentSlug: "oai-searchbot", uaMatch: /OAI-SearchBot/i, suffixes: [".openai.com"] },
  { agentSlug: "claudebot", uaMatch: /ClaudeBot/i, suffixes: [".anthropic.com"] },
  { agentSlug: "perplexitybot", uaMatch: /PerplexityBot/i, suffixes: [".perplexity.ai"] },
  { agentSlug: "googlebot", uaMatch: /Googlebot/i, suffixes: [".googlebot.com", ".google.com"] },
  { agentSlug: "bingbot", uaMatch: /bingbot/i, suffixes: [".search.msn.com"] },
];

/**
 * Forward-confirmed reverse DNS. The UA is the hint; the FCrDNS is the proof.
 * Only WBA_DIR is consumed — the classification cache lives in that namespace.
 */
export async function verifiedCrawler(
  env: { WBA_DIR: KVNamespace },
  ip: string,
  userAgent: string,
): Promise<string | null> {
  const entry = VERIFIED_CRAWLERS.find((c) => c.uaMatch.test(userAgent));
  if (entry === undefined) return null;

  const cacheKey = `rdns:${entry.agentSlug}:${ip}`;
  const cached = await env.WBA_DIR.get(cacheKey, { cacheTtl: 3600 });
  if (cached !== null) return cached === "1" ? entry.agentSlug : null;

  const ok = await confirm(entry, ip);
  // Both answers are cached HERE on purpose: this is a classification cache, not a
  // grant cache, and a wrong negative costs one crawler one free page — not a
  // double charge. §6.12.3 is where negatives must never be cached.
  await env.WBA_DIR.put(cacheKey, ok ? "1" : "0", {
    expirationTtl: ok ? 86400 : 3600,
  });
  return ok ? entry.agentSlug : null;
}

async function confirm(entry: { suffixes: readonly string[] }, ip: string): Promise<boolean> {
  const names = await doh(ptrName(ip), "PTR");
  for (const name of names) {
    if (!entry.suffixes.some((s) => name.replace(/\.$/, "").endsWith(s))) continue;
    const forward = [...(await doh(name, "A")), ...(await doh(name, "AAAA"))];
    if (forward.includes(ip)) return true;
  }
  return false;
}

/** PTR owner name: in-addr.arpa for v4, ip6.arpa for v6. */
function ptrName(ip: string): string {
  if (ip.includes(":")) {
    const [headPart = "", tailPart = ""] = ip.split("::");
    const head = headPart === "" ? [] : headPart.split(":");
    const tail = tailPart === "" ? [] : tailPart.split(":");
    const hextets = [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail];
    const nibbles = hextets.map((h) => h.padStart(4, "0")).join("");
    return [...nibbles.split("").reverse(), "ip6", "arpa"].join(".");
  }
  return [...ip.split(".").reverse(), "in-addr", "arpa"].join(".");
}

/** One DoH query. 1.1.1.1 is a Cloudflare service, so this stays inside the network. */
async function doh(name: string, type: "PTR" | "A" | "AAAA"): Promise<string[]> {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(2000),
    },
  );
  if (!res.ok) return [];
  const body: { Answer?: Array<{ data: string }> } = await res.json();
  return (body.Answer ?? []).map((a) => a.data);
}
