#!/usr/bin/env node
// Update CONSULTANT usernames to simple first/middle name based usernames
// Target: Mumbai DB only

import pg from "pg";
import XLSX from "xlsx";

const TARGET_URL =
  "postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker%40007@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

const EXCEL_PATH = "/home/__/Documents/Doctor Master.xlsx";

const { Pool } = pg.default ?? pg;
const pool = new Pool({ connectionString: TARGET_URL });

function toOldUsername(name) {
  let u = name.toLowerCase()
    .replace(/\//g, ".").replace(/\\/g, ".").replace(/\s+/g, ".")
    .replace(/[^a-z0-9.-]/g, "");
  while (u.includes("..")) u = u.replace(/\.\./g, ".");
  return u.replace(/^\.+|\.+$/g, "");
}

function pickUsername(fullName) {
  let primary = fullName.split(/[/\\]/)[0].trim();
  primary = primary.replace(/\./g, " ").replace(/\s+/g, " ").trim();
  let parts = primary.toLowerCase().split(" ");
  parts = parts.filter(p => p !== "dr" && p !== "asst");

  if (parts.length === 0) return fullName.toLowerCase().replace(/\s+/g, ".");

  const realParts = parts.filter(p => p.length > 1);

  if (realParts.length >= 2) {
    return realParts[0] + "." + realParts[realParts.length - 1];
  } else if (realParts.length === 1) {
    return realParts[0];
  } else {
    return parts.join("");
  }
}

async function main() {
  const client = await pool.connect();

  try {
    const wb = XLSX.readFile(EXCEL_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);

    // First pass: generate old usernames the same way the previous script did
    const oldSeen = new Map();
    const updates = [];

    for (const r of rows) {
      const name = (r.DOCTORNAME || "").trim();
      if (!name) continue;

      // Recreate old username (from fix-consultant-usernames.mjs logic)
      let oldUsername = toOldUsername(name);
      if (oldSeen.has(oldUsername)) {
        const count = oldSeen.get(oldUsername) + 1;
        oldSeen.set(oldUsername, count);
        oldUsername = `${oldUsername}.${count}`;
      } else {
        oldSeen.set(oldUsername, 1);
      }

      updates.push({ name, oldUsername });
    }

    // Second pass: generate new simple usernames
    const newSeen = new Map();
    for (const u of updates) {
      let newUsername = pickUsername(u.name);
      if (newSeen.has(newUsername)) {
        const count = newSeen.get(newUsername) + 1;
        newSeen.set(newUsername, count);
        newUsername = `${newUsername}${count}`;
      } else {
        newSeen.set(newUsername, 1);
      }
      u.newUsername = newUsername;
    }

    await client.query("BEGIN");

    // Temp prefix to avoid mid-update collisions
    for (const { oldUsername } of updates) {
      await client.query(
        "UPDATE users SET username = '__tmp__' || username WHERE username = $1 AND role = 'CONSULTANT'",
        [oldUsername]
      );
    }

    let updated = 0;
    for (const { oldUsername, newUsername } of updates) {
      const res = await client.query(
        "UPDATE users SET username = $1, updated_at = $2 WHERE username = $3 AND role = 'CONSULTANT'",
        [newUsername, Date.now(), "__tmp__" + oldUsername]
      );
      if (res.rowCount > 0) updated++;
    }

    await client.query("COMMIT");
    console.log(`Updated: ${updated}`);

    const all = await client.query(
      "SELECT username, name FROM users WHERE role = 'CONSULTANT' ORDER BY name"
    );
    console.log(`\n=== All ${all.rows.length} consultant usernames ===\n`);
    for (const r of all.rows) {
      console.log(`${r.username.padEnd(35)} ${r.name}`);
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
