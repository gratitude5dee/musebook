// rdns.test.ts — FCrDNS coverage: UA match, cache hits/misses, PTR suffix
// matching, forward confirmation, v4/v6 PTR names, DoH failure tolerance.
// DoH is stubbed at globalThis.fetch; the KV namespace is a Map fake so the
// cached answers are asserted, not just returned.
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifiedCrawler } from "../src/auth/rdns";

const kv = () => {
  const store = new Map<string, string>();
  const puts: Array<[string, string, { expirationTtl?: number } | undefined]> = [];
  const ns = {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    put: (k: string, v: string, opts?: { expirationTtl?: number }) => {
      puts.push([k, v, opts]);
      store.set(k, v);
      return Promise.resolve();
    },
  } as unknown as KVNamespace;
  return { store, puts, ns };
};

/** DoH stub: `answers` maps "name|TYPE" to the Answer[].data list. */
const stubDoh = (answers: Record<string, string[]>, ok = true) => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      const name = /name=([^&]+)/.exec(url)?.[1] ?? "";
      const type = /type=([^&]+)/.exec(url)?.[1] ?? "";
      const data = answers[`${decodeURIComponent(name)}|${type}`] ?? [];
      return Promise.resolve(
        new Response(JSON.stringify(ok ? { Answer: data.map((d) => ({ data: d })) } : {}), {
          status: ok ? 200 : 500,
        }),
      );
    }),
  );
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe("verifiedCrawler", () => {
  it("a non-crawler UA returns null without touching KV or the network", async () => {
    const { ns } = kv();
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "Mozilla/5.0")).toBeNull();
  });

  it("cache hit '1' returns the slug and '0' returns null, with no DoH", async () => {
    const { ns } = kv();
    await ns.put("rdns:gptbot:1.2.3.4", "1");
    await ns.put("rdns:gptbot:5.6.7.8", "0");
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "GPTBot/1.0")).toBe("gptbot");
    expect(await verifiedCrawler({ WBA_DIR: ns }, "5.6.7.8", "GPTBot/1.0")).toBeNull();
  });

  it("a confirmed PTR+forward pair verifies and caches '1' for a day", async () => {
    const { ns, puts } = kv();
    stubDoh({
      "4.3.2.1.in-addr.arpa|PTR": ["crawl-66-249-66-1.openai.com."],
      "crawl-66-249-66-1.openai.com.|A": ["1.2.3.4"],
    });
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "GPTBot")).toBe("gptbot");
    expect(puts[0]).toMatchObject(["rdns:gptbot:1.2.3.4", "1", { expirationTtl: 86400 }]);
  });

  it("a PTR outside the suffix set fails and caches '0' for an hour", async () => {
    const { ns, puts } = kv();
    stubDoh({ "4.3.2.1.in-addr.arpa|PTR": ["evil.example.com."] });
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "GPTBot")).toBeNull();
    expect(puts[0]).toMatchObject(["rdns:gptbot:1.2.3.4", "0", { expirationTtl: 3600 }]);
  });

  it("a matching PTR whose forward lookup lacks the ip fails", async () => {
    const { ns } = kv();
    stubDoh({
      "4.3.2.1.in-addr.arpa|PTR": ["crawl-66-249-66-1.openai.com."],
      "crawl-66-249-66-1.openai.com.|A": ["9.9.9.9"],
      "crawl-66-249-66-1.openai.com.|AAAA": ["::1"],
    });
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "GPTBot")).toBeNull();
  });

  it("v6 addresses produce an ip6.arpa PTR name and still verify", async () => {
    const { ns } = kv();
    const calls = stubDoh({
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.e.f.ip6.arpa|PTR": [
        "crawl.openai.com.",
      ],
      "crawl.openai.com.|A": [],
      "crawl.openai.com.|AAAA": ["fe80::1"],
    });
    expect(await verifiedCrawler({ WBA_DIR: ns }, "fe80::1", "OAI-SearchBot")).toBe(
      "oai-searchbot",
    );
    expect(calls[0]).toContain("ip6.arpa");
  });

  it("a DoH failure degrades to an empty answer, not an exception", async () => {
    const { ns } = kv();
    stubDoh({}, false);
    expect(await verifiedCrawler({ WBA_DIR: ns }, "1.2.3.4", "ClaudeBot")).toBeNull();
  });
});
