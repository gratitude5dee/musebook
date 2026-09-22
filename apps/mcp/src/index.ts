// musebook-mcp — the remote MCP server on mcp.musebook.dev (§3.1, CF-SPINE §9).
// agents/mcp/server + workers-oauth-provider; NO McpAgent, NO Durable Objects,
// no Vercel behind it. Tools land at M9.
export default {
  fetch(_request: Request, env: Env): Response {
    void env.HYPERDRIVE_CACHED;
    void env.HYPERDRIVE_FRESH;
    void env.OAUTH_KV;
    void env.GRANTS;
    void env.PUBLIC_MEDIA;
    void env.PAID_MEDIA;
    void env.Q_CLASSIFY;
    void env.Q_MEDIA;
    void env.Q_MEDIA_FINALIZE;
    void env.Q_AGENT_CANCEL;
    void env.TELEMETRY;
    return new Response("musebook-mcp: not yet implemented (lands at M9)", {
      status: 501,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
