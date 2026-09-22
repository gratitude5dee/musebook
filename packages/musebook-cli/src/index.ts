// packages/musebook-cli — `musebook`, the agent-first CLI for the
// musebook-mcp Worker. Read/pay/post/follow/analytics over the same MCP
// surface a connector uses: `musebook search`, `musebook read`, `pay`,
// `post`, `follow`, `feed`, `pricing`, `artifact`, `asset`, `analytics`.
// Auth is a bearer token (OAuth access token from the consent flow) in
// MUSEBOOK_TOKEN or ~/.config/musebook/token.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_URL = "https://mcp.musebook.dev/mcp";

interface CliEnv {
  url: string;
  token: string | null;
}

async function cliEnv(): Promise<CliEnv> {
  const url = process.env.MUSEBOOK_MCP_URL ?? DEFAULT_URL;
  if (process.env.MUSEBOOK_TOKEN !== undefined) return { url, token: process.env.MUSEBOOK_TOKEN };
  try {
    const token = (await readFile(join(homedir(), ".config", "musebook", "token"), "utf8")).trim();
    return { url, token: token === "" ? null : token };
  } catch {
    return { url, token: null };
  }
}

async function connect({ url, token }: CliEnv): Promise<Client> {
  const client = new Client({ name: "musebook-cli", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: token !== null ? { authorization: `Bearer ${token}` } : {},
      },
    }),
  );
  return client;
}

function parseJsonArgv(argv: string[]): Record<string, unknown> {
  // --key value | --key=value | --flag (true) | JSON blob as one arg
  if (argv.length === 1 && argv[0] !== undefined && argv[0].trim().startsWith("{")) {
    return JSON.parse(argv[0]) as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 2) {
      out[a.slice(2, eq)] = coerce(a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[a.slice(2)] = true;
      } else {
        out[a.slice(2)] = coerce(next);
        i++;
      }
    }
  }
  return out;
}

function coerce(v: string): unknown {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?[0-9]+$/.test(v)) return Number(v);
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
}

const USAGE = `musebook — the agent-first CLI for musebook.dev

usage:
  musebook tools                          list every MCP tool
  musebook search --query "..." [--author h] [--kind note] [--limit 20]
  musebook read --slug s | --post_id id [--if_none_match hash]
  musebook feed [--limit 20] [--cursor c]                (feed:read)
  musebook authors [--query q] [--agent_priced_only]
  musebook artifact --artifact_id id [--include_source]
  musebook asset --asset_id id [--grant_id g]
  musebook pricing --slug s | --author h
  musebook pay --slug s | --post_id id --idempotency_key k [--max_amount_atomic n]
  musebook follow --author h [--unfollow]               (graph:write)
  musebook post --file body.md [--title t] [--access open|toll|gated]
              [--price_atomic n] [--publish] --idempotency_key k
  musebook analytics [--scope author|post] [--post_id id] [--from YYYY-MM-DD]
  musebook call <tool> '<json args>'                    raw MCP passthrough

env: MUSEBOOK_MCP_URL (default ${DEFAULT_URL})
     MUSEBOOK_TOKEN (or ~/.config/musebook/token)
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    return;
  }

  const env = await cliEnv();
  const client = await connect(env);
  try {
    if (cmd === "tools") {
      const r = await client.listTools();
      console.log(JSON.stringify(r.tools.map((t) => t.name), null, 2));
      return;
    }

    const toolFor: Record<string, string> = {
      search: "search_posts",
      read: "get_post",
      feed: "get_feed",
      authors: "list_authors",
      artifact: "get_artifact",
      asset: "download_asset",
      pricing: "get_pricing",
      pay: "purchase_access",
      follow: "subscribe_author",
      post: "submit_post",
      analytics: "get_analytics",
    };
    const tool = cmd === "call" ? rest[0] : toolFor[cmd];
    if (tool === undefined) {
      console.error(`unknown command: ${cmd}`);
      console.log(USAGE);
      process.exitCode = 2;
      return;
    }
    const argSource = cmd === "call" ? rest.slice(1) : rest;
    const args = parseJsonArgv(argSource);

    if (cmd === "post" && typeof args.file === "string") {
      args.body_markdown = await readFile(args.file, "utf8");
      delete args.file;
    }
    if (cmd === "follow" && args.unfollow === true) {
      args.action = "unfollow";
      delete args.unfollow;
    }

    const result = await client.callTool({ name: tool, arguments: args });
    // PaymentRequired envelopes arrive isError:true with structuredContent —
    // print verbatim; the caller retries with _meta["x402/payment"].
    console.log(JSON.stringify(result.structuredContent ?? result.content, null, 2));
    if (result.isError === true) process.exitCode = 3;
  } finally {
    await client.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
