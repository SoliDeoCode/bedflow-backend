import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db, DbStatement } from "./adapter.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
});

// Routes all db calls inside a db.transaction() to the same pg client,
// preserving transactional integrity without changing service call sites.
const txStore = new AsyncLocalStorage<pg.PoolClient>();

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ...
function toPositional(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function getClient(): pg.Pool | pg.PoolClient {
  return txStore.getStore() ?? pool;
}

export const db: Db = {
  async exec(sql: string): Promise<void> {
    await getClient().query(sql);
  },

  prepare(sql: string): DbStatement {
    const pgSql = toPositional(sql);
    return {
      async run(...params: unknown[]) {
        const result = await getClient().query(pgSql, params as unknown[]);
        return {
          changes: result.rowCount ?? 0,
          lastInsertRowid: (result.rows[0]?.id as number) ?? 0,
        };
      },
      async get<T>(...params: unknown[]): Promise<T | undefined> {
        const result = await getClient().query(pgSql, params as unknown[]);
        return result.rows[0] as T | undefined;
      },
      async all<T>(...params: unknown[]): Promise<T[]> {
        const result = await getClient().query(pgSql, params as unknown[]);
        return result.rows as T[];
      },
    };
  },

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await txStore.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
};
