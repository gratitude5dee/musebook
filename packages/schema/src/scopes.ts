// packages/schema/src/scopes.ts — §5.7.3's closed delegation-scope set.
// The ONLY registry: adding a scope is an entry here and a branch in the
// enforcement gate, never an ad-hoc string. Declared as a readonly tuple so
// z.enum(ALL_SCOPES) typechecks; §7.6.2's `scopes_supported` is [...ALL_SCOPES]
// and §10.3's CAPABILITY_SCOPES values are members of it.
export const ALL_SCOPES = [
  "feed:read",
  "post:read",
  "post:write",
  "post:publish",
  "comment:write",
  "graph:write",
  "media:generate",
  "channel:connect",
  "distribution:publish",
  "wallet:spend",
  "profile:write",
  "audit:read",
  "analytics:read",
] as const;
export type Scope = (typeof ALL_SCOPES)[number];

/** Scopes that default `requires_approval = true` when minted (§5.7.3). */
export const APPROVAL_DEFAULT_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "post:publish",
  "comment:write",
  "channel:connect",
  "distribution:publish",
  "wallet:spend",
  "profile:write",
]);

/** Scopes that can carry spend — the only ones §5.7.5's `spend` arg may accompany. */
export const SPEND_BEARING_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "media:generate",
  "wallet:spend",
]);
