// packages/muse-mixer/src/adapters/pg.ts
// §16.7 deliverable entrypoint: re-exports the Postgres adapter surface.
export { postgresDbHandles, PostgresWeightsLoader } from "./postgres/index.js";
export type { SqlClient } from "./postgres/index.js";
export { SOURCE_SQL } from "./postgres/sql/index.js";
