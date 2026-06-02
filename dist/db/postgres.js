import "dotenv/config";
import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
const { Pool } = pg;
// Use DIRECT_URL when available — it points to the session-mode pooler (port 5432)
// which supports transactions and prepared statements. DATABASE_URL may point to
// PgBouncer's transaction-mode pooler (port 6543) which does not.
const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString)
    throw new Error("DATABASE_URL or DIRECT_URL must be set");
// Strip Prisma-only flags (e.g. ?pgbouncer=true) that pg driver doesn't understand
const cleanUrl = connectionString.replace(/[?&]pgbouncer=true/i, "");
const pool = new Pool({
    connectionString: cleanUrl,
    ssl: { rejectUnauthorized: false }, // Supabase always requires SSL
    max: 10,
});
// Routes all db calls inside a db.transaction() to the same pg client,
// preserving transactional integrity without changing service call sites.
const txStore = new AsyncLocalStorage();
// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ...
function toPositional(sql) {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
}
function getClient() {
    return txStore.getStore() ?? pool;
}
export const db = {
    async exec(sql) {
        await getClient().query(sql);
    },
    prepare(sql) {
        const pgSql = toPositional(sql);
        return {
            async run(...params) {
                const result = await getClient().query(pgSql, params);
                return {
                    changes: result.rowCount ?? 0,
                    lastInsertRowid: result.rows[0]?.id ?? 0,
                };
            },
            async get(...params) {
                const result = await getClient().query(pgSql, params);
                return result.rows[0];
            },
            async all(...params) {
                const result = await getClient().query(pgSql, params);
                return result.rows;
            },
        };
    },
    async transaction(fn) {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const result = await txStore.run(client, fn);
            await client.query("COMMIT");
            return result;
        }
        catch (e) {
            await client.query("ROLLBACK");
            throw e;
        }
        finally {
            client.release();
        }
    },
};
