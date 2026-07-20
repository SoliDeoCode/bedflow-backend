#!/usr/bin/env node
// Seed departments, doctors_master, doctor_departments, and CONSULTANT users
// into the TARGET (Mumbai) database from Doctor Master.xlsx.
//
// Usage:  node scripts/seed-consultants.mjs
//
// Target DB is the commented-out Mumbai instance in .env.development:
//   postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker@007@...

import pg from "pg";
import bcrypt from "bcryptjs";
import { readFileSync } from "fs";
import XLSX from "xlsx";

// ── Target DB (Mumbai) — hardcoded so we NEVER touch the active/production DB ──
const TARGET_URL =
  "postgresql://postgres.jaeugcgppvcbxaklxhev:kimsbedtracker%40007@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

const EXCEL_PATH = "/home/__/Documents/Doctor Master.xlsx";
const DEFAULT_PASSWORD = "12345678";

const { Pool } = pg.default ?? pg;
const pool = new Pool({ connectionString: TARGET_URL });

async function main() {
  const client = await pool.connect();

  try {
    // Read Excel
    const wb = XLSX.readFile(EXCEL_PATH);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws);
    console.log(`Read ${rows.length} rows from Excel`);

    // Collect unique departments
    const deptSet = new Map();
    for (const r of rows) {
      const name = (r.DEPARTMENT || "").trim();
      if (name && !deptSet.has(name)) deptSet.set(name, r.DEPARTMENTCD);
    }
    console.log(`${deptSet.size} unique departments`);

    await client.query("BEGIN");

    // 1. Seed departments
    const deptIdByName = new Map();
    for (const [name] of deptSet) {
      const res = await client.query(
        `INSERT INTO departments (name, active)
         VALUES ($1, true)
         ON CONFLICT (name) DO UPDATE SET active = true
         RETURNING id`,
        [name]
      );
      deptIdByName.set(name, res.rows[0].id);
    }
    console.log(`Upserted ${deptIdByName.size} departments`);

    // 2. Seed doctors_master + doctor_departments + CONSULTANT users
    const passwordHash = bcrypt.hashSync(DEFAULT_PASSWORD, 12);
    const now = Date.now();
    let doctorsInserted = 0;
    let linksInserted = 0;
    let usersInserted = 0;
    let skippedUsers = 0;

    for (const r of rows) {
      const doctorName = (r.DOCTORNAME || "").trim();
      const doctorCode = (r.DOCTORCD || "").trim();
      const deptName = (r.DEPARTMENT || "").trim();
      if (!doctorName || !doctorCode) continue;

      // Upsert doctor
      const docRes = await client.query(
        `INSERT INTO doctors_master (name, active)
         VALUES ($1, true)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [doctorName]
      );

      let doctorId;
      if (docRes.rows.length > 0) {
        doctorId = docRes.rows[0].id;
        doctorsInserted++;
      } else {
        // Already exists — fetch id
        const existing = await client.query(
          "SELECT id FROM doctors_master WHERE name = $1",
          [doctorName]
        );
        doctorId = existing.rows[0]?.id;
      }

      // Link doctor ↔ department
      if (doctorId && deptName && deptIdByName.has(deptName)) {
        const deptId = deptIdByName.get(deptName);
        await client.query(
          `INSERT INTO doctor_departments (doctor_id, department_id)
           VALUES ($1, $2)
           ON CONFLICT (doctor_id, department_id) DO NOTHING`,
          [doctorId, deptId]
        );
        linksInserted++;
      }

      // Create CONSULTANT user — username = doctor code lowercase
      const username = doctorCode.toLowerCase();
      const existing = await client.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO users (username, password_hash, role, name, status, created_at, updated_at)
           VALUES ($1, $2, 'CONSULTANT', $3, 'active', $4, $5)`,
          [username, passwordHash, doctorName, now, now]
        );
        usersInserted++;
      } else {
        skippedUsers++;
      }
    }

    await client.query("COMMIT");

    console.log("\n=== Done ===");
    console.log(`Departments: ${deptIdByName.size}`);
    console.log(`Doctors inserted: ${doctorsInserted}`);
    console.log(`Doctor↔Dept links: ${linksInserted}`);
    console.log(`Consultant users created: ${usersInserted}`);
    console.log(`Consultant users skipped (already exist): ${skippedUsers}`);
    console.log(`Password for all: ${DEFAULT_PASSWORD}`);
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
