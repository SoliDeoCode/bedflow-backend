import { Router } from "express";
import { z } from "zod";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { listBeds, updateBedStatus } from "../services/bedDetailService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { listDestinations } from "../services/destinationService.js";
import { emitUpdate } from "../websocket/io.js";
import { db } from "../db/index.js";

interface NaaAssignment { id: number; ward_id: number; access_type: string; bed_names: string; station_id: number | null; }

// Joins through to the ward's station so overrides can be scoped per station —
// a nurse covering two stations may have ward-level overrides in one of them
// while still getting full default access to the other.
async function getNurseAssignments(nurseId: number): Promise<NaaAssignment[]> {
  return db.prepare(
    `SELECT naa.id, naa.ward_id, naa.access_type, naa.bed_names, w.station_id
     FROM nurse_access_assignments naa
     JOIN wards w ON w.id = naa.ward_id
     WHERE naa.nurse_id=? AND naa.status='active'`
  ).all<NaaAssignment>(nurseId);
}

/** Stations where this nurse has at least one ward-level override configured
 * — within those stations, only the explicitly assigned wards are visible.
 * Stations with no rows here keep full default access to every ward. */
function stationsWithOverrides(assignments: NaaAssignment[]): Set<number> {
  return new Set(assignments.map(a => a.station_id).filter((id): id is number => id != null));
}

async function canNurseAccessBed(nurseId: number, bedId: number, stationIds: number[]): Promise<boolean> {
  const bd = await db.prepare(
    "SELECT bd.ward_id, bd.bed_name, w.station_id FROM bed_details bd JOIN wards w ON w.id=bd.ward_id WHERE bd.id=?"
  ).get<{ ward_id: number; bed_name: string; station_id: number | null }>(bedId);
  if (!bd || bd.station_id == null || !stationIds.includes(bd.station_id)) return false;

  const assignments = await getNurseAssignments(nurseId);
  if (!stationsWithOverrides(assignments).has(bd.station_id)) return true; // whole station open

  const asgn = assignments.find(a => a.ward_id === bd.ward_id);
  if (!asgn) return false; // this station has overrides, but none for this ward
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
  if (!userId) throw new HttpError(401, "Please sign in to continue.");
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
  const overriddenStations = stationsWithOverrides(assignments);
  const openStationIds = stationIds.filter(id => !overriddenStations.has(id));
  const overriddenWardIds = assignments.map(a => a.ward_id);

  const openWards = openStationIds.length ? await db.prepare(`
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
  `).all(openStationIds) as Array<Record<string, unknown>> : [];

  const assignedWardRows = overriddenWardIds.length ? await db.prepare(`
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
  `).all(overriddenWardIds) as Array<Record<string, unknown>> : [];

  // For BEDS-type access, mark wards where bed_names is empty rather than
  // silently dropping them — nurse sees the card with a warning instead of
  // the ward disappearing with no explanation.
  const filteredAssigned = assignedWardRows.map(w => {
    const asgn = assignments.find(a => a.ward_id === w.id)!;
    if (asgn.access_type !== "BEDS") return w;
    let allowed: string[] = [];
    try { allowed = JSON.parse(asgn.bed_names || "[]"); } catch { /* ignore */ }
    if (allowed.length === 0)
      return { ...w, beds_warning: "No beds assigned to your account for this ward. Contact your manager." };
    return w;
  });

  res.json({
    nursing_station: stations.map(s => s.name).join(", "), station_id: stationIds[0],
    stations, wards: [...openWards, ...filteredAssigned],
  });
}));

router.get("/wards/:id/beds", asyncH(async (req, res) => {
  const stations = await getMyStations(req);
  const stationIds = stations.map(s => s.id);
  const wardId = Number(req.params.id);
  const physicalStatus    = req.query.physical_status    as string | undefined;
  const reservationStatus = req.query.reservation_status as string | undefined;

  const ward = await db.prepare("SELECT id, station_id FROM wards WHERE id=?")
    .get<{ id: number; station_id: number | null }>(wardId);
  if (!ward || ward.station_id == null || !stationIds.includes(ward.station_id))
    throw new HttpError(403, "Ward not in your nursing station");

  const assignments = await getNurseAssignments(req.user!.id);
  if (stationsWithOverrides(assignments).has(ward.station_id)) {
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
