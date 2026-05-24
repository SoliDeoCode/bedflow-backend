// SQLite implementation of the Db adapter.
//
// Uses Node 22's built-in node:sqlite (no native build step). To switch to
// better-sqlite3 in production, install it and change the import below — the
// exported `db` keeps the same shape so nothing else changes.
//
// To switch to PostgreSQL: create db/postgres.ts implementing the Db interface
// (e.g. with `pg`), then point db/index.ts at it. Service/route code is untouched.

import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import type { Db, DbStatement } from "./adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// database files live in backend/database (separate folder, per requirements)
const dbDir = path.resolve(__dirname, "..", "..", "database");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = process.env.SQLITE_PATH || path.join(dbDir, "bedflow.db");
const raw = new DatabaseSync(dbPath);
raw.exec("PRAGMA journal_mode = WAL;");
raw.exec("PRAGMA foreign_keys = ON;");

export const db: Db = {
  exec: (sql: string) => raw.exec(sql),
  prepare: (sql: string): DbStatement => {
    const stmt = raw.prepare(sql);
    return {
      run: (...p: unknown[]) => {
        const r = stmt.run(...(p as never[]));
        return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid as number };
      },
      get: <T>(...p: unknown[]) => stmt.get(...(p as never[])) as T | undefined,
      all: <T>(...p: unknown[]) => stmt.all(...(p as never[])) as T[],
    };
  },
  transaction: <T>(fn: () => T): T => {
    raw.exec("BEGIN");
    try { const out = fn(); raw.exec("COMMIT"); return out; }
    catch (e) { raw.exec("ROLLBACK"); throw e; }
  },
};

export { dbPath };
