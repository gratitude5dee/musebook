// Test stand-in for `pg`. resolve-actor.ts only constructs a Client on the
// production path (when deps.query is absent); tests always inject deps.query,
// so this module is never executed — it only has to satisfy the import graph
// and the type surface that `import type { Client } from "pg"` touches.
export class Client {
  constructor(_opts?: unknown) {
    throw new Error("pg.Client is not available under the workers test pool — inject deps.query");
  }
  query(_sql: string, _params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    return Promise.reject(new Error("pg.Client stub has no database"));
  }
  connect(): Promise<void> {
    return Promise.reject(new Error("pg.Client stub has no database"));
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

const pg = { Client };
export default pg;
