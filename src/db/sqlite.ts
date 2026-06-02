// SQLite implementation — kept for reference / local dev fallback.
// NOTE: Not currently used. db/index.ts points to db/postgres.ts.
// To switch back to SQLite, change db/index.ts to export from "./sqlite.js".
//
// The async interface wrappers below satisfy the updated Db type so the file
// compiles cleanly, even though the underlying DatabaseSync calls are synchronous.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type { Db, DbStatement } from "./adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(__dirname, "..", "..", "database");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = process.env.SQLITE_PATH || path.join(dbDir, "bedflow.db");
const raw = new DatabaseSync(dbPath);
raw.exec("PRAGMA journal_mode = WAL;");
raw.exec("PRAGMA foreign_keys = ON;");

export const db: Db = {
  exec: async (sql: string): Promise<void> => { raw.exec(sql); },
  prepare: (sql: string): DbStatement => {
    const stmt = raw.prepare(sql);
    return {
      run: async (...p: unknown[]) => {
        const r = stmt.run(...(p as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number };
      },
      get: async <T>(...p: unknown[]) => stmt.get(...(p as never[])) as T | undefined,
      all: async <T>(...p: unknown[]) => stmt.all(...(p as never[])) as T[],
    };
  },
  transaction: async <T>(fn: () => Promise<T>): Promise<T> => {
    raw.exec("BEGIN");
    try { const out = await fn(); raw.exec("COMMIT"); return out; }
    catch (e) { raw.exec("ROLLBACK"); throw e; }
  },
};

export { dbPath };
