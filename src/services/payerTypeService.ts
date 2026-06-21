import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";

export interface PayerType {
  id: number; name: string; sort_order: number; active: boolean; created_at: number;
}

export async function listPayerTypes(activeOnly = false): Promise<PayerType[]> {
  const sql = activeOnly
    ? "SELECT id, name, sort_order, active, created_at FROM payer_types WHERE active=TRUE ORDER BY sort_order, id"
    : "SELECT id, name, sort_order, active, created_at FROM payer_types ORDER BY sort_order, id";
  return db.prepare(sql).all<PayerType>();
}

export async function createPayerType(opts: { name: string; userId: number }): Promise<{ ok: boolean; id: number }> {
  const name = opts.name.trim();
  if (!name) throw new HttpError(400, "Payer type name is required");
  if (name.length > 100) throw new HttpError(400, "Name too long (max 100 characters)");

  const clash = await db.prepare("SELECT 1 FROM payer_types WHERE LOWER(name)=LOWER(?)").get(name);
  if (clash) throw new HttpError(409, `Payer type "${name}" already exists`);

  const maxRow = await db.prepare("SELECT COALESCE(MAX(sort_order),0) AS m FROM payer_types").get<{ m: number }>();
  const sortOrder = (maxRow?.m ?? 0) + 1;
  const now = Date.now();
  const r = await db.prepare(
    "INSERT INTO payer_types (name, sort_order, active, created_at) VALUES (?,?,TRUE,?) RETURNING id"
  ).run(name, sortOrder, now);

  await audit(opts.userId, "payer_type_create", String(r.lastInsertRowid), { name });
  return { ok: true, id: r.lastInsertRowid };
}

export async function updatePayerType(opts: {
  id: number; name?: string; active?: boolean; userId: number;
}): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, name FROM payer_types WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Payer type not found");

  const now = Date.now();
  if (opts.name !== undefined) {
    const name = opts.name.trim();
    if (!name) throw new HttpError(400, "Name cannot be empty");
    const clash = await db.prepare("SELECT 1 FROM payer_types WHERE LOWER(name)=LOWER(?) AND id!=?").get(name, opts.id);
    if (clash) throw new HttpError(409, `Payer type "${name}" already exists`);
    // The payer is stored on beds by name (not FK), so a rename propagates to
    // the LIVE beds (bed_details) atomically with the list update. History
    // (bed_movements) is intentionally left untouched — it's an audit trail and
    // must keep the literal payer name that was chosen at the time.
    await db.transaction(async () => {
      await db.prepare("UPDATE payer_types SET name=? WHERE id=?").run(name, opts.id);
      if (name !== row.name) {
        await db.prepare("UPDATE bed_details SET payer_type=? WHERE payer_type=?").run(name, row.name);
      }
    });
  }
  if (opts.active !== undefined) {
    await db.prepare("UPDATE payer_types SET active=? WHERE id=?").run(opts.active, opts.id);
  }

  await audit(opts.userId, "payer_type_update", String(opts.id), { name: opts.name, active: opts.active });
  return { ok: true };
}

export async function reorderPayerType(opts: {
  id: number; direction: "up" | "down"; userId: number;
}): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, sort_order FROM payer_types WHERE id=?")
    .get<{ id: number; sort_order: number }>(opts.id);
  if (!row) throw new HttpError(404, "Payer type not found");

  const neighbour = opts.direction === "up"
    ? await db.prepare("SELECT id, sort_order FROM payer_types WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order)
    : await db.prepare("SELECT id, sort_order FROM payer_types WHERE sort_order > ? ORDER BY sort_order ASC  LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order);

  if (!neighbour) return { ok: true }; // already at top/bottom

  await db.transaction(async () => {
    await db.prepare("UPDATE payer_types SET sort_order=? WHERE id=?").run(neighbour.sort_order, opts.id);
    await db.prepare("UPDATE payer_types SET sort_order=? WHERE id=?").run(row.sort_order, neighbour.id);
  });
  return { ok: true };
}

export async function deletePayerType(opts: { id: number; userId: number }): Promise<{ ok: boolean }> {
  const row = await db.prepare("SELECT id, name FROM payer_types WHERE id=?").get<{ id: number; name: string }>(opts.id);
  if (!row) throw new HttpError(404, "Payer type not found");

  const inUse = await db.prepare("SELECT 1 FROM bed_details WHERE payer_type=? LIMIT 1").get(row.name);
  if (inUse) throw new HttpError(409, `Cannot delete "${row.name}" — it is currently assigned to one or more occupied beds`);

  await db.prepare("DELETE FROM payer_types WHERE id=?").run(opts.id);
  await audit(opts.userId, "payer_type_delete", String(opts.id), { name: row.name });
  return { ok: true };
}
