// packages/connectors/test/egress.test.ts — §10.12 check 3.
// The nine-case SSRF corpus, in BOTH passes: under plain vitest all nine throw,
// with resolveAndCheck injected so literal-private and rebind-to-private hosts
// fail on the address check; under cloudflareTest() (no resolveAndCheck — the
// Worker has no DNS escape) the seven the allowlist/scheme/credential/redirect
// rules catch still throw and the two pure-rebinding cases are asserted to be
// allowlist failures by reason string.
import { describe, expect, it, vi } from "vitest";
import { makeGuardedFetch } from "../src/egress.js";

const IS_WORKERD =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Cloudflare-Workers");

const PRIVATE = new Set([
  "127.0.0.1",
  "0.0.0.0",
  "169.254.169.254",
  "::1",
  "[::1]",
  "::ffff:7f00:1",
  "[::ffff:7f00:1]",
  "10.0.0.1",
  "rebind.test",
]);

// The Node call site's post-DNS address check, stubbed: rebind.test resolves
// to a private address, everything else in the corpus resolves literally.
const nodeResolveAndCheck = async (hostname: string): Promise<void> => {
  if (PRIVATE.has(hostname.toLowerCase())) throw new Error("egress_private_address");
};

interface Case {
  name: string;
  url: string;
  /** allowHosts on the Node pass (with resolveAndCheck). */
  allowNode: string[];
  /** allowHosts on the workerd pass (no resolveAndCheck). */
  allowWorkers: string[];
  /** Reason asserted on the Node pass. */
  nodeError: RegExp;
  /** Reason asserted on the workerd pass. */
  workersError: RegExp;
  /** Whether a fetch stub returning a 302 is needed. */
  stub302?: boolean;
}

const CORPUS: Case[] = [
  { name: "literal loopback", url: "https://127.0.0.1/x", allowNode: ["127.0.0.1"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "unspecified", url: "https://0.0.0.0/", allowNode: ["0.0.0.0"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "link-local metadata", url: "https://169.254.169.254/latest/meta-data", allowNode: ["169.254.169.254"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "ipv6 loopback", url: "https://[::1]/", allowNode: ["::1", "[::1]"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "ipv6-mapped loopback (rebinding)", url: "https://[::ffff:7f00:1]/", allowNode: ["::ffff:7f00:1", "[::ffff:7f00:1]"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "rfc1918", url: "https://10.0.0.1/", allowNode: ["10.0.0.1"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "hostname resolving private (rebinding)", url: "https://rebind.test/", allowNode: ["rebind.test"], allowWorkers: [], nodeError: /egress_private_address/, workersError: /egress_host_not_allowed/ },
  { name: "302 to a private address", url: "https://ok.test/redir", allowNode: ["ok.test"], allowWorkers: ["ok.test"], nodeError: /egress_redirect_refused/, workersError: /egress_redirect_refused/, stub302: true },
  { name: "embedded credentials", url: "https://user:pw@allowed.test/", allowNode: ["allowed.test"], allowWorkers: ["allowed.test"], nodeError: /egress_credentials_in_url/, workersError: /egress_credentials_in_url/ },
];

describe("egress SSRF corpus", () => {
  for (const c of CORPUS) {
    it(`${c.name} throws`, async () => {
      if (c.stub302) {
        vi.stubGlobal(
          "fetch",
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://10.0.0.1/stolen" },
            }),
        );
      }
      const guarded = makeGuardedFetch({
        allowHosts: IS_WORKERD ? c.allowWorkers : c.allowNode,
        ...(IS_WORKERD ? {} : { resolveAndCheck: nodeResolveAndCheck }),
      });
      await expect(guarded(c.url, { method: "GET" })).rejects.toThrow(
        IS_WORKERD ? c.workersError : c.nodeError,
      );
      vi.unstubAllGlobals();
    });
  }
});
