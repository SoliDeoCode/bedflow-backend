import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export interface Destination {
  id: number; name: string; sort_order: number; active: boolean; created_at: number;
}

export async function listDestinations(activeOnly = false): Promise<Destination[]> {
  const sql = activeOnly
    ? "SELECT id, name, sort_order, active, created_at FROM destinations WHERE active=TRUE ORDER BY sort_order, id"
    : "SELECT id, name, sort_order, active, created_at FROM destinations ORDER BY sort_order, id";
  return db.prepare(sql).all<Destination>();
}

export async function createDestination(opts: { name: string; userId: number }): Promise<{ ok: boolean; id: number }> {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Destination name is required");
  if (name.length > 100) throw new HttpError(400, "Name too long (max 100 characters)");

  const clash = await db.prepare("SELECT 1 FROM destinations WHERE LOWER(name)=LOWER(?)").get(name);
  if (clash) throw new HttpError(409, `Destination "${name}" already exists`);

  const maxRow = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM destinations").get<{ m: number }>();
  const sortOrder = (maxRow?.m ?? 0) + 1;
  const now = Date.now();
  const r = await db.prepare(
    "INSERT INTO destinations (name, sort_order, active, created_at) VALUES (?,?,TRUE,?) RETURNING id"
  ).run(name, sortOrder, now);

  await audit(opts.userId, "destination_create", String(r.lastInsertRowid), { name });
  return { ok: true, id: r.lastInsertRowid };
}

export async function updateDestination(opts: {
  id: number; name?: string; active?: boolean; userId: number;
}): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, name FROM destinations WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Destination not found");

  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!name) throw new HttpError(400, "Name cannot be empty");
    const clash = await db.prepare("SELECT 1 FROM destinations WHERE LOWER(name)=LOWER(?) AND id!=?").get(name, opts.id);
    if (clash) throw new HttpError(409, `Destination "${name}" already exists`);
    // Destination is stored on beds by name (not FK), so a rename propagates to
    // the LIVE beds (bed_details) atomically with the list update. History
    // (bed_movements) is intentionally left untouched — it's an audit trail and
    // must keep the literal destination that was chosen at the time.
    await db.transaction(async () => {
      await db.prepare("UPDATE destinations SET name=? WHERE id=?").run(name, opts.id);
      if (name !== row.name) {
        await db.prepare("UPDATE bed_details SET destination=? WHERE destination=?").run(name, row.name);
      }
    });
  }
  if (opts.active !== undefined) {
    await db.prepare("UPDATE destinations SET active=? WHERE id=?").run(opts.active, opts.id);
  }

  await audit(opts.userId, "destination_update", String(opts.id), { name: opts.name, active: opts.active });
  return { ok: true };
}

export async function reorderDestination(opts: {
  id: number; direction: "up" | "down"; userId: number;
}): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, sort_order FROM destinations WHERE id=?")
    .get<{ id: number; sort_order: number }>(opts.id);
  if (!row) throw new HttpError(404, "Destination not found");

  const neighbour = opts.direction === "up"
    ? await db.prepare("SELECT id, sort_order FROM destinations WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order)
    : await db.prepare("SELECT id, sort_order FROM destinations WHERE sort_order > ? ORDER BY sort_order ASC  LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order);

  if (!neighbour) return { ok: true }; // already at top/bottom

  await db.transaction(async () => {
    await db.prepare("UPDATE destinations SET sort_order=? WHERE id=?").run(neighbour.sort_order, opts.id);
    await db.prepare("UPDATE destinations SET sort_order=? WHERE id=?").run(row.sort_order, neighbour.id);
  });
  return { ok: true };
}

export async function deleteDestination(opts: { id: number; userId: number }): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, name FROM destinations WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Destination not found");

  const inUse = await db.prepare("SELECT 1 FROM bed_details WHERE destination=? LIMIT 1").get(row.name);
  if (inUse) throw new HttpError(409, `Cannot delete "${row.name}" — it is currently assigned to one or more occupied+reserved beds`);

  await db.prepare("DELETE FROM destinations WHERE id=?").run(opts.id);
  await audit(opts.userId, "destination_delete", String(opts.id), { name: row.name });
  return { ok: true };
}
