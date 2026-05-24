// Single switch point for the database engine.
// SQLite now; to move to Postgres, swap this one import for ./postgres.js.
export { db } from "./sqlite.js";
