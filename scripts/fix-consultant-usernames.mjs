#!/usr/bin/env node
// Update CONSULTANT usernames from doctor codes (dm0270) to name-based (ravikanth.telikicherla)
// Target: Mumbai DB only

import pg from "pg";
import XLSX from "xlsx";

const TARGET_URL =
  "postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker%40007@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

const EXCEL_PATH = "/home/__/Documents/Doctor Master.xlsx";

const { Pool } = pg.default ?? pg;
const pool = new Pool({ connectionString: TARGET_URL });

function toUsername(name) {
  let u = name.toLowerCase()
    .replace(/\//g, ".")
    .replace(/\\/g, ".")
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9.-]/g, "");
  while (u.includes("..")) u = u.replace(/\.\./g, ".");
  return u.replace(/^\.+|\.+$/g, "");
}

async function main() {
  const client = await pool.connect();

  try {
    const wb = XLSX.readFile(EXCEL_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    const seen = new Map();
    const updates = [];

    for (const r of rows) {
      const oldUsername = (r.DOCTORCD || "").trim().toLowerCase();
      const name = (r.DOCTORNAME || "").trim();
      if (!oldUsername || !name) continue;

      let newUsername = toUsername(name);
      if (seen.has(newUsername)) {
        const count = seen.get(newUsername) + 1;
        seen.set(newUsername, count);
        newUsername = `${newUsername}.${count}`;
      } else {
        seen.set(newUsername, 1);
      }

      updates.push({ oldUsername, newUsername, name });
    }

    await client.query("BEGIN");

    let updated = 0;
    let skipped = 0;
    for (const { oldUsername, newUsername } of updates) {
      const res = await client.query(
        "UPDATE users SET username = $1, updated_at = $2 WHERE username = $3 AND role = 'CONSULTANT'",
        [newUsername, Date.now(), oldUsername]
      );
      if (res.rowCount > 0) updated++;
      else skipped++;
    }

    await client.query("COMMIT");

    console.log(`Updated: ${updated}`);
    console.log(`Skipped (not found): ${skipped}`);

    // Print final list
    const all = await client.query(
      "SELECT username, name FROM users WHERE role = 'CONSULTANT' ORDER BY name"
    );
    console.log(`\n=== All ${all.rows.length} consultant usernames ===\n`);
    for (const r of all.rows) {
      console.log(`${r.username.padEnd(50)} ${r.name}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLED BACK:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
