import bcrypt from "bcryptjs";
import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

// ---- PRE user lifecycle ----
export function createPre(opts: {
  username: string; password: string; name: string; preCode: string;
  floor?: string; shift?: "morning" | "night"; managerId: number;
}) {
  const username = opts.username.trim().toLowerCase();
  if (!/^[a-z0-9_]+$/.test(username)) throw new HttpError(400, "Username: letters, numbers, underscore only");
  const exists = db.prepare("SELECT 1 FROM users WHERE username=?").get(username);
  if (exists) throw new HttpError(409, "Username already taken");

  const now = Date.now();
  const shift = opts.shift || "morning";
  let userId = 0;
  db.transaction(() => {
    const r = db.prepare(
      "INSERT INTO users (username, password_hash, role, name, shift, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
    ).run(username, bcrypt.hashSync(opts.password, 10), "PRE", opts.name, shift, now, now);
    userId = Number(r.lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO pre_assignments (user_id, pre_code, created_at) VALUES (?,?,?)")
      .run(userId, opts.preCode, now);
    // optionally ensure floor exists
    if (opts.floor) db.prepare("INSERT OR IGNORE INTO floors (name) VALUES (?)").run(opts.floor);
  });
  audit(opts.managerId, "pre_create", opts.preCode, { username, name: opts.name, shift, floor: opts.floor });
  return { ok: true, id: userId, username, preCode: opts.preCode };
}

export function editPre(opts: {
  userId: number; name?: string; password?: string;
  shift?: "morning" | "night"; preCode?: string; managerId: number;
}) {
  const user = db.prepare("SELECT id, role FROM users WHERE id=?").get<{ id: number; role: string }>(opts.userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE not found");
  const now = Date.now();
  db.transaction(() => {
    if (opts.name !== undefined)
      db.prepare("UPDATE users SET name=?, updated_at=? WHERE id=?").run(opts.name, now, opts.userId);
    if (opts.password)
      db.prepare("UPDATE users SET password_hash=?, updated_at=? WHERE id=?")
        .run(bcrypt.hashSync(opts.password, 10), now, opts.userId);
    if (opts.shift)
      db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(opts.shift, now, opts.userId);
    if (opts.preCode) {
      db.prepare("DELETE FROM pre_assignments WHERE user_id=?").run(opts.userId);
      db.prepare("INSERT INTO pre_assignments (user_id, pre_code, created_at) VALUES (?,?,?)")
        .run(opts.userId, opts.preCode, now);
    }
  });
  audit(opts.managerId, "pre_edit", opts.preCode ?? null, {
    userId: opts.userId, name: opts.name, shift: opts.shift,
    preCode: opts.preCode, password: opts.password ? "(changed)" : undefined,
  });
  return { ok: true };
}

export function setPreShift(userId: number, shift: "morning" | "night", managerId: number) {
  const user = db.prepare("SELECT id, role FROM users WHERE id=?").get<{ id: number; role: string }>(userId);
  if (!user || user.role !== "PRE") throw new HttpError(404, "PRE not found");
  db.prepare("UPDATE users SET shift=?, updated_at=? WHERE id=?").run(shift, Date.now(), userId);
  audit(managerId, "pre_shift", null, { userId, shift });
  return { ok: true, shift };
}

// ---- ward / room management ----
export function createWard(opts: {
  name: string; preCode: string; totalBeds: number; floor?: string; managerId: number;
}) {
  const now = Date.now();
  let floorId: number | null = null;
  if (opts.floor) {
    db.prepare("INSERT OR IGNORE INTO floors (name) VALUES (?)").run(opts.floor);
    floorId = db.prepare("SELECT id FROM floors WHERE name=?").get<{ id: number }>(opts.floor)?.id ?? null;
  }
  try {
    const r = db.prepare(
      "INSERT INTO wards (name, floor_id, pre_code, total_beds, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).run(opts.name, floorId, opts.preCode, opts.totalBeds, now, now);
    db.prepare("INSERT INTO beds (ward_id, total) VALUES (?,?)").run(r.lastInsertRowid, opts.totalBeds);
    audit(opts.managerId, "ward_create", opts.preCode, { name: opts.name, totalBeds: opts.totalBeds });
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch {
    throw new HttpError(409, "Room already exists for this PRE");
  }
}

export function editWard(opts: { wardId: number; totalBeds?: number; floor?: string; name?: string; managerId: number }) {
  const ward = db.prepare("SELECT id, pre_code FROM wards WHERE id=?").get<{ id: number; pre_code: string }>(opts.wardId);
  if (!ward) throw new HttpError(404, "Room not found");
  const now = Date.now();
  db.transaction(() => {
    if (opts.name !== undefined)
      db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?").run(opts.name, now, opts.wardId);
    if (opts.totalBeds !== undefined) {
      db.prepare("UPDATE wards SET total_beds=?, updated_at=? WHERE id=?").run(opts.totalBeds, now, opts.wardId);
      db.prepare("UPDATE beds SET total=? WHERE ward_id=?").run(opts.totalBeds, opts.wardId);
    }
    if (opts.floor) {
      db.prepare("INSERT OR IGNORE INTO floors (name) VALUES (?)").run(opts.floor);
      const fid = db.prepare("SELECT id FROM floors WHERE name=?").get<{ id: number }>(opts.floor)?.id ?? null;
      db.prepare("UPDATE wards SET floor_id=?, updated_at=? WHERE id=?").run(fid, now, opts.wardId);
    }
  });
  audit(opts.managerId, "ward_edit", ward.pre_code, { wardId: opts.wardId, totalBeds: opts.totalBeds, floor: opts.floor, name: opts.name });
  return { ok: true };
}

export function deleteWard(wardId: number, managerId: number) {
  const ward = db.prepare("SELECT pre_code FROM wards WHERE id=?").get<{ pre_code: string }>(wardId);
  if (!ward) throw new HttpError(404, "Room not found");
  db.prepare("DELETE FROM wards WHERE id=?").run(wardId);
  audit(managerId, "ward_delete", ward.pre_code, { wardId });
  return { ok: true };
}

// ---- history (date dropdown) ----
// Distinct dates (YYYY-MM-DD) that have any submitted round.
export function availableDates(): string[] {
  const rows = db.prepare("SELECT DISTINCT round_key FROM pre_rounds ORDER BY submitted_at DESC").all<{ round_key: string }>();
  const dates = new Set<string>();
  for (const r of rows) {
    const parts = r.round_key.split("|"); // pre|shift|YYYY-MM-DD|startMin
    if (parts[2]) dates.add(parts[2]);
  }
  return [...dates];
}

// All rounds submitted on a given date, optionally filtered by PRE.
export function historyForDate(date: string, pre?: string) {
  let sql = "SELECT pre_code AS pre, shift, start_min AS startMin, submitted_at AS submittedAt, snapshot FROM pre_rounds WHERE round_key LIKE ?";
  const params: unknown[] = [`%|${date}|%`];
  if (pre) { sql += " AND pre_code=?"; params.push(pre); }
  sql += " ORDER BY submitted_at";
  const rows = db.prepare(sql).all<{ pre: string; shift: string; startMin: number; submittedAt: number; snapshot: string }>(...params);
  return rows.map((r) => ({
    pre: r.pre, shift: r.shift, startMin: r.startMin, submittedAt: r.submittedAt,
    wards: (() => { try { return JSON.parse(r.snapshot || "[]"); } catch { return []; } })(),
  }));
}
