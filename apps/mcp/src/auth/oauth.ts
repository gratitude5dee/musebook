// apps/mcp/src/auth/oauth.ts — §7.6.1's ConsentHandler: serves the
// path-suffixed RFC 9728 document the provider does not, and renders the
// /authorize consent page. The one place in this Worker that renders
// attacker-influenceable strings — client metadata is escaped, length-capped,
// and the page is CSP-locked with a CSRF token on the approve form.
//
// The consent act binds an OAuth grant to an EXISTING delegations row: the
// owner pastes an mb_dlg_ token they minted in the web app. We hash it,
// resolve it on FRESH, and store {dlg, sub, aid, scp} on the grant's props —
// never the token itself, and authority stays with the row (§7.6.4).
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { ALL_SCOPES } from "@musebook/schema";
import { fresh } from "../db/client.js";

const PRM = {
  resource: "https://mcp.musebook.dev/mcp",
  authorization_servers: ["https://mcp.musebook.dev"],
  bearer_methods_supported: ["header"],
  scopes_supported: [...ALL_SCOPES],
  resource_documentation: "https://musebook.dev/llms.txt",
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-allow-methods": "GET, OPTIONS",
  "cache-control": "public, max-age=3600",
};

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'";

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function helpers(env: Env): OAuthHelpers {
  const h = (env as unknown as { OAUTH_PROVIDER?: OAuthHelpers }).OAUTH_PROVIDER;
  if (h === undefined) throw new Error("oauth_helpers_unset");
  return h;
}

/** CSRF token: HMAC over the canonical authorize query, so an attacker's form
 *  POST for a different client/state pair never validates. */
async function csrfFor(env: Env, authQuery: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.MCP_REQUEST_STATE_KEY ?? "csrf-fallback"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(authQuery));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fstr(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

export const ConsentHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      return Response.json(PRM, { headers: CORS });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname !== "/authorize") {
      return new Response("not found", { status: 404 });
    }

    const oauth = helpers(env);

    if (req.method === "GET") {
      let authReq;
      try {
        authReq = await oauth.parseAuthRequest(req);
      } catch (e) {
        return new Response(`Invalid authorization request: ${String(e)}`, { status: 400 });
      }
      const client = await oauth.lookupClient(authReq.clientId);
      const clientName = esc((client?.clientName ?? authReq.clientId).slice(0, 120));
      const csrf = await csrfFor(env, url.search);
      const scopeList = authReq.scope.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
      const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Musebook — authorize agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:30rem;margin:4rem auto;padding:0 1rem">
<h1>Authorize ${clientName}</h1>
<p>An agent is asking to act through Musebook on your behalf.</p>
<p>Requested scopes:</p><ul>${scopeList}</ul>
<p>Paste a <code>mb_dlg_…</code> delegation token (minted under
<em>Settings → Agents</em> on musebook.dev) to bind this grant. The grant
inherits the delegation's scopes and dies when the delegation is revoked.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="csrf" value="${csrf}">
<input type="hidden" name="auth_query" value="${esc(url.search)}">
<label>Delegation token<br>
<input name="delegation" type="password" required minlength="20" maxlength="200"
  autocomplete="off" style="width:100%"></label><br>
<button type="submit" name="decision" value="approve">Authorize</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</form></body></html>`;
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP },
      });
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const authQuery = fstr(form, "auth_query");
      const csrf = fstr(form, "csrf");
      const expected = await csrfFor(env, authQuery);
      if (csrf !== expected || !authQuery.startsWith("?")) {
        return new Response("csrf_failed", { status: 403 });
      }
      const decision = fstr(form, "decision") || "deny";
      const authReq = await oauth.parseAuthRequest(
        new Request(`${url.origin}/authorize${authQuery}`, { headers: { accept: "application/json" } }),
      );
      if (decision !== "approve") {
        const dest = new URL(authReq.redirectUri);
        dest.searchParams.set("error", "access_denied");
        dest.searchParams.set("state", authReq.state);
        return Response.redirect(dest.toString(), 302);
      }
      const token = fstr(form, "delegation").trim();
      if (!token.startsWith("mb_dlg_")) return new Response("delegation_token_required", { status: 400 });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      const hash = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const sql = fresh(env);
      try {
        const rows = await sql.unsafe(
          "select * from app.resolve_delegation($1::text)",
          [hash],
        ) as {
          id: string; owner_user_id: string; agent_identity_id: string;
          connector_slug: string; scopes: string[]; state: string;
          expires_at: string | null;
        }[];
        const d = rows[0];
        if (!d || d.state !== "active") return new Response("delegation_inactive", { status: 403 });
        if (d.expires_at !== null && new Date(d.expires_at).getTime() <= Date.now()) {
          return new Response("delegation_expired", { status: 403 });
        }
        // The grant's props bind the delegation; the requested scope set is
        // clamped to what the delegation actually carries.
        const granted = authReq.scope.filter((s) => d.scopes.includes(s));
        const { redirectTo } = await oauth.completeAuthorization({
          request: authReq,
          userId: d.owner_user_id,
          metadata: { connector: d.connector_slug },
          scope: granted,
          props: { dlg: d.id, sub: d.owner_user_id, aid: d.agent_identity_id, scp: granted },
        });
        return Response.redirect(redirectTo, 302);
      } finally {
        await sql.end();
      }
    }

    return new Response("method not allowed", { status: 405 });
  },
};
