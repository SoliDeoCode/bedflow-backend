import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "./index.js";

async function run() {
  // ── Wipe everything except migrations ──────────────────────────────────────
  await db.exec(`
    TRUNCATE TABLE
      nurse_access_assignments, bed_movements, bed_details, bed_status_updates,
      push_subscriptions, audit_logs, occupancy_snapshots, midnight_census,
      pre_rounds, beds, pre_assignments, pre_block_wards, pre_blocks,
      saved_views, reminders, shifts,
      wards, nursing_stations, floors, blocks, building_blocks,
      users
    RESTART IDENTITY CASCADE
  `);
  console.log("Database wiped.");

  const now = Date.now();

  const users = [
    { username: "admin1",    password: "Admin@1234",    role: "COO",     name: "Admin One" },
    { username: "admin2",    password: "Admin@5678",    role: "COO",     name: "Admin Two" },
    // Former MANAGER accounts now seed as COO (Admin) — usernames preserved,
    // mirroring the production merge migration (20260621000000).
    { username: "manager1",  password: "Manager@1234",  role: "COO",     name: "Manager One" },
    { username: "manager2",  password: "Manager@5678",  role: "COO",     name: "Manager Two" },
    { username: "nurse1",    password: "Nurse@1234",    role: "NURSE",   name: "Nurse One" },
  ];

  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, 10);
    await db.prepare(
      `INSERT INTO users (username, password_hash, role, name, shift, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'morning', ?, ?)`
    ).run(u.username, hash, u.role, u.name, now, now);
    console.log(`  Created: ${u.username.padEnd(12)} (${u.role})`);
  }

  // Shifts (required for app to function)
  await db.prepare(
    "INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)"
  ).run("morning", "Morning", "07:00", "14:00");
  await db.prepare(
    "INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)"
  ).run("evening", "Evening", "14:00", "21:00");
  await db.prepare(
    "INSERT INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)"
  ).run("night", "Night", "21:00", "07:00");

  console.log("\nDone. All users created.");
}

run().catch(err => { console.error("Seed failed:", err); process.exit(1); });
