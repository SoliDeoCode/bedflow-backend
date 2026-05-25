// Database adapter — the ONLY file that knows which database engine is used.
// Today: SQLite (file-based, zero-config). Tomorrow: swap to Postgres by
// implementing the same Db interface in db/postgres.ts and changing one import.
//
// The interface deliberately mirrors a minimal prepared-statement API
// (run / get / all) so swapping engines never touches service or route code.

export interface DbStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  transaction<T>(fn: () => T): T;
}
