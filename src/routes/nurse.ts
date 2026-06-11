import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("NURSE"));

/** Resolve the nurse's station — prefers station_id FK, falls back to DB lookup for old tokens. */
async function getMyStation(req: { user?: { id: number; station_id?: number | null; nursing_station?: string | null } }) {
  const stationId = req.user?.station_id;
  if (stationId) {
    const ns = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
      .get<{ id: number; name: string }>(stationId);
    if (!ns) throw new HttpError(400, "Your nursing station no longer exists. Contact your manager.");
    return ns;
  }
  // Fallback: look up from DB (covers tokens issued before station_id was in JWT)
  const userId = req.user?.id;
  if (!userId) throw new HttpError(401, "Not authenticated");
  const user = await db.prepare("SELECT station_id FROM users WHERE id=?")
    .get<{ station_id: number | null }>(userId);
  if (!user?.station_id) throw new HttpError(400, "No nursing station assigned to your account. Contact your manager.");
  const ns = await db.prepare("SELECT id, name FROM nursing_stations WHERE id=?")
    .get<{ id: number; name: string }>(user.station_id);
  if (!ns) throw new HttpError(400, "Your nursing station no longer exists. Contact your manager.");
  return ns;
}

router.get("/me", asyncH(async (req, res) => {
  const station = await getMyStation(req);
  const wards = await db.prepare(`
    SELECT w.id, w.name, w.station_id, w.unit_type, w.room_type,
           bb.name AS block_name, bb.label AS block_label,
           f.name AS floor_name
    FROM wards w
    JOIN floors f ON f.id = w.floor_id
    JOIN building_blocks bb ON bb.id = f.building_block_id
    WHERE w.station_id = ?
    ORDER BY bb.sort_order, bb.name, f.sort_order, w.name
  `).all(station.id) as Array<Record<string, unknown>>;

  const wardsWithBeds = await Promise.all(wards.map(async (w) => {
    const beds = await db.prepare(`
      SELECT id, bed_name, physical_status, reservation_status, bed_type, operational_status
      FROM bed_details
      WHERE ward_id = ?
      ORDER BY
        substring(bed_name from '^[^0-9]*') ASC,
        NULLIF(substring(bed_name from '[0-9]+'), '')::bigint NULLS LAST,
        bed_name ASC
    `).all(w.id);
    return { ...w, beds };
  }));

  res.json({ nursing_station: station.name, station_id: station.id, wards: wardsWithBeds });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const station = await getMyStation(req);
  const wardId = Number(req.params.id);
  const ward = await db.prepare("SELECT id FROM wards WHERE id=? AND station_id=?")
    .get(wardId, station.id);
  if (!ward) throw new HttpError(403, "Ward not in your nursing station");

  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const station = await getMyStation(req);
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
  }).parse(req.body);

  const owns = await db.prepare(`
    SELECT bd.id FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    WHERE bd.id = ? AND w.station_id = ?
  `).get(bedId, station.id);
  if (!owns) throw new HttpError(403, "Bed not in your nursing station");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    userId: req.user!.id,
  });
  emitUpdate("bed:update", { station: station.name }, station.name);
  res.json(result);
}));

export default router;
