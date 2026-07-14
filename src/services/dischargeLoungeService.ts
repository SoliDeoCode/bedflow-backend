import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { listBeds } from "./bedDetailService.js";

const now = () => Date.now();

export interface DischargeLoungeWard {
  id: number; name: string; total_beds: number; operational: boolean;
}

/** The one ward flagged is_discharge_lounge, or null if an admin hasn't set it up yet.
 *  It deliberately lives outside the floor/building-block hierarchy (floor_id is
 *  always NULL) — it's a virtual holding area, not a real physical ward. */
export async function getDischargeLoungeWard(): Promise<DischargeLoungeWard | null> {
  const ward = await db.prepare(
    "SELECT id, name, total_beds, operational FROM wards WHERE is_discharge_lounge=true"
  ).get<DischargeLoungeWard>();
  return ward ?? null;
}

export async function getDischargeLounge() {
  const ward = await getDischargeLoungeWard();
  if (!ward) return { configured: false, ward: null, beds: [] };
  const beds = await listBeds(ward.id);
  return { configured: true, ward, beds };
}

/** One-time setup — creates the Discharge Lounge ward with no floor_id (outside the
 *  normal hierarchy) and bed_type='Lounge' (excluded from every Census/Non-Census
 *  and total-hospital-bed count everywhere else in the app). Refuses to run twice —
 *  the partial unique index on wards.is_discharge_lounge would reject it anyway, but
 *  this gives a friendlier error pointing at "rename/add beds instead". */
export async function setupDischargeLounge(opts: {
  name: string; initialBeds: number; managerId: number;
}): Promise<{ ok: true; id: number }> {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Name is required");
  const existing = await getDischargeLoungeWard();
  if (existing) throw new HttpError(409, "A Discharge Lounge already exists — rename it or add beds instead of creating a new one.");

  const total = Math.max(0, Math.floor(opts.initialBeds));
  if (total > 200) throw new HttpError(400, "At most 200 initial beds — add more afterwards if needed.");
  const t = now();

  let wardId = 0;
  await db.transaction(async () => {
    const r = await db.prepare(
      `INSERT INTO wards (name, floor_id, total_beds, bed_type, operational, is_discharge_lounge, created_at, updated_at)
       VALUES (?, NULL, ?, 'Lounge', true, true, ?, ?) RETURNING id`
    ).run(name, total, t, t);
    wardId = Number(r.lastInsertRowid);
    await db.prepare("INSERT INTO beds (ward_id, total, vacant, reserved, occupied, occupied_reserved) VALUES (?,?,?,0,0,0)").run(wardId, total, total);
    if (total > 0) {
      const placeholders = Array.from({ length: total }, () => "(?,?,'VACANT','NONE','Lounge',true,?,?)").join(",");
      const values: unknown[] = [];
      for (let i = 1; i <= total; i++) values.push(wardId, String(i), t, opts.managerId);
      await db.prepare(
        `INSERT INTO bed_details (ward_id, bed_name, physical_status, reservation_status, bed_type, operational_status, updated_at, updated_by) VALUES ${placeholders}`
      ).run(...values);
    }
  });

  await audit(opts.managerId, "discharge_lounge_setup", name, { initialBeds: total });
  return { ok: true, id: wardId };
}

export async function renameDischargeLounge(opts: { name: string; managerId: number }): Promise<{ ok: true }> {
  const ward = await getDischargeLoungeWard();
  if (!ward) throw new HttpError(404, "Discharge Lounge is not configured yet");
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Name is required");

  await db.prepare("UPDATE wards SET name=?, updated_at=? WHERE id=?").run(name, now(), ward.id);
  await audit(opts.managerId, "discharge_lounge_rename", String(ward.id), { from: ward.name, to: name });
  return { ok: true };
}
