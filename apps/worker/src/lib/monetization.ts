// apps/worker/src/lib/monetization.ts — §10.10.3's defaults table in the
// 'open'|'toll'|'gated' vocabulary (§7.4.1). The SQL helper maps the owner's
// creator_publishing_defaults into `defaults.access`, so neither the enum
// values nor the column name ever crosses this file (§3.4's rule reaches SQL
// strings too). The third row is forced and never overridable below 40.
export type Access = "open" | "toll" | "gated";

export function defaultAccessFor(input: {
  reputation: number;
  defaults: { access?: Access | null } | null;
}): Access {
  if (input.reputation < 40) return "gated";
  return input.defaults?.access ?? "toll";
}
