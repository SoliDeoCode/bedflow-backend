import bcrypt from "bcryptjs";
import { db } from "./index.js";
import { migrate } from "./migrate.js";
import {
  FLOOR_MAP, WARDS, SHIFTS, COO_REMINDERS, PRE_INTERVAL_MIN, SEED_ACCOUNTS,
} from "../config/domain.js";

function run() {
  migrate();
  const now = Date.now();

  db.transaction(() => {
    // Floors
    const insFloor = db.prepare("INSERT OR IGNORE INTO floors (name) VALUES (?)");
    for (const name of Object.keys(FLOOR_MAP)) insFloor.run(name);
    const floorId: Record<string, number> = {};
    for (const f of db.prepare("SELECT id, name FROM floors").all<{ id: number; name: string }>())
      floorId[f.name] = f.id;

    // Wards + beds
    const insWard = db.prepare(
      "INSERT OR IGNORE INTO wards (name, floor_id, pre_code, total_beds, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    );
    const insBed = db.prepare(
      "INSERT OR IGNORE INTO beds (ward_id, total, vacant, reserved, occupied, updated_at) VALUES (?,?,NULL,NULL,NULL,NULL)"
    );
    let wardCount = 0, bedTotal = 0;
    for (const [floor, pres] of Object.entries(FLOOR_MAP)) {
      for (const pre of pres) {
        for (const [wardName, total] of WARDS[pre] || []) {
          insWard.run(wardName, floorId[floor] ?? null, pre, total, now, now);
          const w = db.prepare("SELECT id FROM wards WHERE pre_code = ? AND name = ?")
            .get<{ id: number }>(pre, wardName);
          if (w) { insBed.run(w.id, total); wardCount++; bedTotal += total; }
        }
      }
    }

    // Users
    const insUser = db.prepare(
      "INSERT OR IGNORE INTO users (username, password_hash, role, name, shift, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    );
    const insAssign = db.prepare(
      "INSERT OR IGNORE INTO pre_assignments (user_id, pre_code, created_at) VALUES (?,?,?)"
    );
    for (const a of SEED_ACCOUNTS) {
      insUser.run(a.username, bcrypt.hashSync(a.password, 10), a.role, a.name, "morning", now, now);
      if (a.pre) {
        const u = db.prepare("SELECT id FROM users WHERE username = ?").get<{ id: number }>(a.username);
        if (u) insAssign.run(u.id, a.pre, now);
      }
    }

    // Shifts
    const insShift = db.prepare("INSERT OR IGNORE INTO shifts (key, label, start_time, end_time) VALUES (?,?,?,?)");
    for (const [key, s] of Object.entries(SHIFTS)) insShift.run(key, s.label, s.start, s.end);

    // Reminders
    const insRem = db.prepare(
      "INSERT OR IGNORE INTO reminders (target_role, interval_min, window_start, window_end, active) VALUES (?,?,?,?,1)"
    );
    insRem.run("PRE", PRE_INTERVAL_MIN, "09:00", "18:30");
    insRem.run("COO", 180, "09:00", "18:00");

    console.log(`Seeded: ${SEED_ACCOUNTS.length} users, ${wardCount} wards, ${bedTotal} beds.`);
  });

  console.log("Default passwords: pre1..pre10 -> preN123, manager -> manager123, coo -> coo123");
}

run();
