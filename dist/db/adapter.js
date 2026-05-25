// Database adapter — the ONLY file that knows which database engine is used.
// Today: SQLite (file-based, zero-config). Tomorrow: swap to Postgres by
// implementing the same Db interface in db/postgres.ts and changing one import.
//
// The interface deliberately mirrors a minimal prepared-statement API
// (run / get / all) so swapping engines never touches service or route code.
export {};
