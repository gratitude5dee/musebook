// /agents — the creator's agent delegations, plus how agents connect over MCP
// (M9 lands the connector registry; the endpoints are already the contract).
import { cookies } from "next/headers";
import { serviceDb } from "@/lib/db/service";
import { readSession } from "@/lib/auth/read-session";

export const dynamic = "force-dynamic";

interface DelegationRow {
  id: string;
  agent_identity_id: string;
  scopes: string[];
  spend_cap_atomic: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export default async function AgentsPage() {
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const session = await readSession(
    new Request("https://musebook.local/", { headers: { cookie: cookieHeader } }),
  );
  const delegations =
    session === null
      ? []
      : ((
          await serviceDb
            .from("delegations")
            .select("id, agent_identity_id, scopes, spend_cap_atomic, expires_at, revoked_at")
            .eq("owner_user_id", session.userId)
            .order("created_at", { ascending: false })
            .limit(25)
            .returns<DelegationRow[]>()
        ).data ?? []);

  return (
    <div className="mx-auto max-w-2xl px-4">
      <h1 className="font-serif text-3xl">Agents</h1>
      <section className="mt-6 rounded-lg border border-border bg-surface p-4">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Connect an agent
        </h2>
        <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 text-xs">
          {
            "# MCP over HTTP (agent-first)\nmcp.musebook.dev/mcp\nmusebook.dev/mcp\n\n# REST twin\napi.musebook.dev"
          }
        </pre>
      </section>
      <section className="mt-6">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Your delegations
        </h2>
        <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
          {delegations.map((d) => (
            <li key={d.id} className="p-3 text-sm">
              <span className="font-mono text-xs">{d.agent_identity_id}</span>
              <span className="ml-2 text-muted-foreground">
                {d.scopes.join(", ")}
                {d.revoked_at !== null ? " · revoked" : ""}
              </span>
            </li>
          ))}
          {delegations.length === 0 && (
            <li className="p-3 text-sm text-muted-foreground">
              No delegations yet — grant an agent scopes from your wallet.
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
