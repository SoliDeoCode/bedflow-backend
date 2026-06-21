import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

interface NaaAssignment { id: number; ward_id: number; access_type: string; bed_names: string; }

async function getNurseAssignments(nurseId: number): Promise<NaaAssignment[]> {
  return db.prepare(
    "SELECT id, ward_id, access_type, bed_names FROM nurse_access_assignments WHERE nurse_id=? AND status='active'"
  ).all<NaaAssignment>(nurseId);
}

async function canNurseAccessBed(nurseId: number, bedId: number, stationIds: number[]): Promise<boolean> {
  const assignments = await getNurseAssignments(nurseId);
  if (assignments.length === 0) {
    // Station-based: bed must belong to one of the nurse's stations
    const owns = await db.prepare(
      "SELECT 1 FROM bed_details bd JOIN wards w ON w.id=bd.ward_id WHERE bd.id=? AND w.station_id = ANY(?)"
    ).get(bedId, stationIds);
    return !!owns;
  }
  // Assignment-based: bed must be in an assigned ward, and allowed by access type
  const bd = await db.prepare(
    "SELECT bd.ward_id, bd.bed_name FROM bed_details bd WHERE bd.id=?"
  ).get<{ ward_id: number; bed_name: string }>(bedId);
  if (!bd) return false;
  const asgn = assignments.find(a => a.ward_id === bd.ward_id);
  if (!asgn) return false;
  if (asgn.access_type === "FULL") return true;
  let allowed: string[] = [];
  try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
  return allowed.includes(bd.bed_name);
}

const router = Router();
router.use(authRequired, requireRole("NURSE"));

/** Resolve all stations this nurse is assigned to, directly from DB — always fresh, no JWT dependency. */
async function getMyStations(req: { user?: { id: number } }): Promise<{ id: number; name: string }[]> {
  const userId = req.user?.id;
  if (!userId) throw new HttpError(401, "Not authenticated");
  const rows = await db.prepare(
    `SELECT ns.id, ns.name
     FROM nurse_stations nst
     JOIN nursing_stations ns ON ns.id = nst.station_id
     WHERE nst.nurse_id = ?
     ORDER BY ns.name`
  ).all<{ id: number; name: string }>(userId);
  if (rows.length === 0) throw new HttpError(400, "No nursing station assigned to your account. Contact your manager.");
  return rows;
}

const BED_ORDER_SQL = `
  ORDER BY
    substring(bed_name from '^[^0-9]*') ASC,
    NULLIF(substring(bed_name from '[0-9]+'), '')::bigint NULLS LAST,
    bed_name ASC`;

router.get("/me", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const assignments = await getNurseAssignments(req.user!.id);

  if (assignments.length > 0) {
    const wardRows = await db.prepare(`
      SELECT w.id, w.name, w.station_id, w.unit_type, w.room_type, w.total_beds, w.operational,
             b.vacant, b.reserved, b.occupied,
             bb.name AS block_name, bb.label AS block_label,
             f.name AS floor_name
      FROM wards w
      LEFT JOIN beds b ON b.ward_id = w.id
      LEFT JOIN floors f ON f.id = w.floor_id
      LEFT JOIN building_blocks bb ON bb.id = f.building_block_id
      WHERE w.id = ANY(?)
      ORDER BY bb.sort_order NULLS LAST, bb.name NULLS LAST, f.sort_order NULLS LAST, w.name
    `).all(assignments.map(a => a.ward_id)) as Array<Record<string, unknown>>;

    // For BEDS-type access, mark wards where bed_names is empty rather than
    // silently dropping them — nurse sees the card with a warning instead of
    // the ward disappearing with no explanation.
    const filtered = wardRows.map(w => {
      const asgn = assignments.find(a => a.ward_id === w.id)!;
      if (asgn.access_type !== "BEDS") return w;
      let allowed: string[] = [];
      try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
      if (allowed.length === 0)
        return { ...w, beds_warning: "No beds assigned to your account for this ward. Contact your manager." };
      return w;
    });

    return res.json({
      nursing_station: stations.map(s => s.name).join(", "), station_id: stationIds[0],
      stations, wards: filtered,
    });
  }

  // Station-based fallback (no assignments configured)
  const wards = await db.prepare(`
    SELECT w.id, w.name, w.station_id, w.unit_type, w.room_type, w.total_beds, w.operational,
           b.vacant, b.reserved, b.occupied,
           bb.name AS block_name, bb.label AS block_label,
           f.name AS floor_name
    FROM wards w
    LEFT JOIN beds b ON b.ward_id = w.id
    JOIN floors f ON f.id = w.floor_id
    JOIN building_blocks bb ON bb.id = f.building_block_id
    WHERE w.station_id = ANY(?)
    ORDER BY w.operational DESC, bb.sort_order, bb.name, f.sort_order, w.name
  `).all(stationIds);

  res.json({
    nursing_station: stations.map(s => s.name).join(", "), station_id: stationIds[0],
    stations, wards,
  });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const wardId = Number(req.params.id);
  const assignments = await getNurseAssignments(req.user!.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;

  if (assignments.length > 0) {
    const asgn = assignments.find(a => a.ward_id === wardId);
    if (!asgn) throw new HttpError(403, "Ward not in your assignments");

    const allBeds = await listBeds(wardId, physicalStatus, reservationStatus, false);
    if (asgn.access_type === "BEDS") {
      let allowed: string[] = [];
      try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
      const allowedSet = new Set(allowed);
      return res.json({ beds: allBeds.filter(b => allowedSet.has(b.bed_name)) });
    }
    return res.json({ beds: allBeds });
  }

  const ward = await db.prepare("SELECT id FROM wards WHERE id=? AND station_id = ANY(?)")
    .get(wardId, stationIds);
  if (!ward) throw new HttpError(403, "Ward not in your nursing station");
  res.json({ beds: await listBeds(wardId, physicalStatus, reservationStatus, false) });
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

router.get("/destinations", asyncH(async (_req, res) => {
  res.json({ destinations: await listDestinations(true) });
}));

router.patch("/beds/:id/status", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const bedId = Number(req.params.id);
  const { physical_status, reservation_status, payer_type, destination, reservation_note } = z.object({
    physical_status:    z.enum(["VACANT", "OCCUPIED"]),
    reservation_status: z.enum(["NONE", "RESERVED"]),
    payer_type:         z.string().max(100).nullable().optional(),
    destination:        z.string().max(100).nullable().optional(),
    reservation_note:   z.string().max(255).nullable().optional(),
  }).parse(req.body);

  const allowed = await canNurseAccessBed(req.user!.id, bedId, stationIds);
  if (!allowed) throw new HttpError(403, "You do not have access to this bed");

  const result = await updateBedStatus({
    bedId, physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: payer_type, destination, reservationNote: reservation_note, userId: req.user!.id,
  });

  const preBlockRow = await db.prepare(
    "SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?"
  ).get<{ pre_block_id: number }>(result.ward_id);

  // Broadcast to the ward's own station room(s) — not necessarily every station
  // this nurse happens to also cover.
  const wardStation = await db.prepare("SELECT station_id FROM wards WHERE id=?")
    .get<{ station_id: number | null }>(result.ward_id);
  const broadcastStationId = wardStation?.station_id ?? stationIds[0];

  emitUpdate("bed:update", {
    bedId, wardId: result.ward_id, stationId: broadcastStationId,
    physicalStatus: physical_status, reservationStatus: reservation_status,
    payerType: result.payer_type, destination: result.destination, reservationNote: result.reservation_note,
  }, {
    stationId: broadcastStationId,
    pre: preBlockRow ? String(preBlockRow.pre_block_id) : undefined,
  });
  res.json(result);
}));

export default router;
