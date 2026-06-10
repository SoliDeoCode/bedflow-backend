import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("NURSE"));

async function myStation(req: { user?: { id: number; nursing_station?: string | null } }) {
  const station = req.user?.nursing_station;
  if (!station) throw new HttpError(400, "No nursing station assigned to your account. Contact your manager.");
  return station;
}

router.get("/me", asyncH(async (req, res) => {
  const station = await myStation(req);
  const wards = await db.prepare(`
    SELECT w.id, w.name, w.nursing_station, w.unit_type, w.room_type,
           b.name AS block_name, b.label AS block_label
    FROM wards w
    JOIN blocks b ON b.id = w.block_id
    WHERE w.nursing_station = ?
    ORDER BY b.sort_order, b.name, w.name
  `).all(station) as Array<Record<string, unknown>>;

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

  res.json({ nursing_station: station, wards: wardsWithBeds });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const station = await myStation(req);
  const wardId = Number(req.params.id);
  const ward = await db.prepare("SELECT id FROM wards WHERE id=? AND nursing_station=?")
    .get(wardId, station);
  if (!ward) throw new HttpError(403, "Ward not in your nursing station");

  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const station = await myStation(req);
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
  }).parse(req.body);

  const owns = await db.prepare(`
    SELECT bd.id FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    WHERE bd.id = ? AND w.nursing_station = ?
  `).get(bedId, station);
  if (!owns) throw new HttpError(403, "Bed not in your nursing station");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    userId: req.user!.id,
  });
  emitUpdate("bed:update", { station }, station);
  res.json(result);
}));

export default router;
