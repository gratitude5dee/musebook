// Test stand-in for `pg`. resolve-actor.ts only constructs a Client on the
// production path (when deps.query is absent), so most tests never touch it —
// the withClient coverage test does, steering behavior through `next`.
export const next = {
  result: [] as Record<string, unknown>[],
  error: null as Error | null,
};

export class Client {
  constructor(_opts?: unknown) {}
  query(_sql: string, _params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (next.error !== null) return Promise.reject(next.error);
    return Promise.resolve({ rows: next.result });
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  end(): Promise<void> {
    return Promise.resolve();
  }
}

const pg = { Client };
export default pg;
