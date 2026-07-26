import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { db } from "../db/index.js";
import { emitUpdate } from "../websocket/io.js";
import type { Role } from "../types/index.js";
import {
  planDischarge, reschedule, cancelPlan, initiateDischarge, cancelAfterInitiation,
  updateStep, dashboardCounts, historyForAdmission, getDischargeForBed, dischargesForWard, listPendingByStep, listBillingPipeline, listActiveDischarges, listInitiatedToday, listCancelledToday, listPatientLeft, listCompletedToday, listAdmittedToday,
  dischargeImmediate,
  type StepKey,
} from "../services/dischargeService.js";
import { getAdmissionById } from "../services/patientAdmissionService.js";
import { listPhaseConfig, computeWorkflow, decorateMany } from "../services/dischargeSlaService.js";
import { listTransferCandidates, transferBed, moveToDischargeLounge, readmitFromLounge } from "../services/bedTransferService.js";
import { wardsOperationalHospitalWide, wardIdsForUnit, loungeOriginAdmissionIds } from "../services/bedService.js";
import { ownsBed as consultantOwnsBedByOwnership, ownsAdmission as consultantOwnsAdmissionByOwnership } from "../services/consultantGroupService.js";
import { canNurseAccessBed, getMyStations } from "./nurse.js";
import { accessibleWards, blockForWard } from "./doctor.js";

const router = Router();
router.use(authRequired);

// ── Ownership / scoping helpers ──────────────────────────────────────────────
// FC and COO are hospital-wide roles for this module (billing/oversight aren't
// tied to a ward), so they skip these checks entirely — see callers below.

async function bedWard(bedId: number): Promise<number> {
  const row = await db.prepare("SELECT ward_id FROM bed_details WHERE id=?").get<{ ward_id: number }>(bedId);
  if (!row) throw new HttpError(404, "Bed not found");
  return row.ward_id;
}

async function preOwnsWard(userId: number, wardId: number): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 FROM pre_block_wards pbw
     JOIN user_pre_blocks upb ON upb.pre_block_id = pbw.pre_block_id
     WHERE pbw.ward_id = ? AND upb.user_id = ?`
  ).get(wardId, userId);
  return !!row;
}

const HOSPITAL_WIDE_ROLES: Role[] = ["FC", "MASTER_FC", "COO", "PHARMACY", "MASTER_PHARMACY"];

/** Throws 403 unless the caller (per their role) can act on this ward. FC/COO always pass. */
async function assertWardAccess(userId: number, role: Role, wardId: number) {
  if (HOSPITAL_WIDE_ROLES.includes(role)) return;
  if (role === "PRE") {
    if (!(await preOwnsWard(userId, wardId))) throw new HttpError(403, "Ward not in your PRE Block");
    return;
  }
  if (role === "DOCTOR") {
    if (!(await blockForWard(userId, wardId))) throw new HttpError(403, "Ward not in your Doctor Block");
    return;
  }
  if (role === "NURSE") {
    const stations = await getMyStations({ user: { id: userId } });
    const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?").get<{ station_id: number | null }>(wardId);
    if (!ward?.station_id || !stations.some(s => s.id === ward.station_id))
      throw new HttpError(403, "Ward not in your nursing station");
    return;
  }
}

/** Destination-ward check for Bed Transfer specifically — every transfer-capable role
 *  (PRE, Nurse, FC) can target any operational ward hospital-wide, not just their own
 *  block/station. Only the ward's operational status matters here; the *source* ward
 *  (fromWardId) still goes through the ordinary, scoped assertWardAccess above, so a
 *  PRE/Nurse user can still only transfer a patient OUT of their own wards — just not
 *  restricted on where they can send them. The Discharge Lounge is rejected separately,
 *  unconditionally, inside transferBed() itself. */
async function assertTransferDestinationAccess(wardId: number) {
  const ward = await db.prepare("SELECT operational FROM wards WHERE id=?").get<{ operational: boolean }>(wardId);
  if (!ward) throw new HttpError(404, "Ward not found");
  if (!ward.operational) throw new HttpError(409, "Destination ward is currently non-operational");
}

/** A CONSULTANT owns a bed/admission if they're the individual doctor on record,
 *  OR a member of the Consultant Group on record — resolved via consultantGroupService,
 *  never by matching consultant_name text. Ward-level access means nothing for a
 *  CONSULTANT, so every write must go through one of these. */
async function assertBedAccess(user: { id: number; role: Role; name: string; doctor_master_id?: number | null }, bedId: number) {
  if (user.role === "NURSE") {
    const stations = await getMyStations({ user: { id: user.id } });
    const allowed = await canNurseAccessBed(user.id, bedId, stations.map(s => s.id));
    if (!allowed) throw new HttpError(403, "You do not have access to this bed");
    return;
  }
  if (user.role === "CONSULTANT") {
    if (!user.doctor_master_id || !(await consultantOwnsBedByOwnership(user.doctor_master_id, bedId)))
      throw new HttpError(403, "This patient is not under your care");
    return;
  }
  const wardId = await bedWard(bedId);
  await assertWardAccess(user.id, user.role, wardId);
}

async function admissionWard(admissionId: number): Promise<{ wardId: number; bedId: number }> {
  const admission = await getAdmissionById(admissionId);
  if (!admission) throw new HttpError(404, "Admission not found");
  return { wardId: admission.ward_id, bedId: admission.bed_id };
}

async function assertAdmissionAccess(user: { id: number; role: Role; name: string; doctor_master_id?: number | null }, admissionId: number): Promise<number> {
  const { wardId, bedId } = await admissionWard(admissionId);
  if (user.role === "NURSE") await assertBedAccess(user, bedId);
  else if (user.role === "CONSULTANT") {
    if (!user.doctor_master_id || !(await consultantOwnsAdmissionByOwnership(user.doctor_master_id, admissionId)))
      throw new HttpError(403, "This patient is not under your care");
  }
  else await assertWardAccess(user.id, user.role, wardId);
  return wardId;
}

/** Same room-fanout convention used by bed:update — Admin overview is always reached. */
async function fanout(wardId: number) {
  const pre = await db.prepare("SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?").get<{ pre_block_id: number }>(wardId);
  const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?").get<{ station_id: number | null }>(wardId);
  return { wardId, pre: pre ? String(pre.pre_block_id) : undefined, stationId: ward?.station_id ?? undefined };
}

/** Ward ids the caller's discharge dashboard/history should be scoped to. null = hospital-wide. */
async function myWardScope(userId: number, role: Role): Promise<number[] | null> {
  if (HOSPITAL_WIDE_ROLES.includes(role)) return null;
  if (role === "PRE") {
    const rows = await db.prepare(
      `SELECT pbw.ward_id FROM pre_block_wards pbw
       JOIN user_pre_blocks upb ON upb.pre_block_id = pbw.pre_block_id
       WHERE upb.user_id = ?`
    ).all<{ ward_id: number }>(userId);
    return rows.map(r => r.ward_id);
  }
  if (role === "DOCTOR") return (await accessibleWards(userId)).map(w => w.ward_id);
  if (role === "NURSE") {
    const stations = await getMyStations({ user: { id: userId } });
    const rows = await db.prepare("SELECT id FROM wards WHERE station_id = ANY(?)").all<{ id: number }>(stations.map(s => s.id));
    return rows.map(r => r.id);
  }
  return null;
}

/** Same as myWardScope, but honors an explicit ?hospitalWide=true opt-in — used
 *  only by the Transaction Board's drilldown modal, which must match the same
 *  hospital-wide scope its card counts already use (adminDashboard/dashboardCounts
 *  for Nurse/PRE/Doctor are unrestricted; this modal previously wasn't, causing
 *  the card number and the drilldown list to disagree). Every OTHER caller of
 *  these routes (e.g. each role's own scoped Discharges worklist page) never
 *  sends this param, so their behavior is unchanged.
 *
 *  ?unit=<unit_type> further narrows that hospital-wide scope to the Unit
 *  toolbar's current selection (TOTAL/KIMS/Renova/Cuddles/... — resolved
 *  dynamically off wards.unit_type via bedService.ts's wardIdsForUnit, so any
 *  unit added later needs no code change here). extraAdmissionIds carries the
 *  Discharge Lounge patients who belong to that unit by ORIGIN — see
 *  loungeOriginAdmissionIds — since their pa.ward_id becomes the Lounge
 *  ward's id after transfer and would otherwise vanish from a unit-scoped
 *  list. Returned wardIds/extraAdmissionIds get OR'd together by
 *  dischargeService.ts's wardScopeSql in every list/count query below. */
async function myWardScopeOrHospitalWide(req: { query: unknown; user?: { id: number; role: Role } }): Promise<{ wardIds: number[] | null; extraAdmissionIds: number[] | null }> {
  const q = req.query as Record<string, unknown>;
  if (q?.hospitalWide === "true") {
    const unit = typeof q.unit === "string" ? q.unit : null;
    if (!unit) return { wardIds: null, extraAdmissionIds: null };
    const unitWardIds = await wardIdsForUnit(unit);
    if (!unitWardIds) return { wardIds: null, extraAdmissionIds: null };
    return { wardIds: unitWardIds, extraAdmissionIds: await loungeOriginAdmissionIds(unitWardIds) };
  }
  return { wardIds: await myWardScope(req.user!.id, req.user!.role), extraAdmissionIds: null };
}

// ── Plan / reschedule / cancel / initiate ────────────────────────────────────

router.post("/plan", asyncH(async (req, res) => {
  const { bedId, planned_date, planned_time } = z.object({
    bedId: z.number().int(),
    planned_date: z.string(),
    planned_time: z.string().max(10).nullable().optional(),
  }).parse(req.body);

  const wardId = await bedWard(bedId);
  await assertBedAccess(req.user!, bedId);

  const tracking = await planDischarge({
    bedId, plannedDate: planned_date, plannedTime: planned_time, userId: req.user!.id, role: req.user!.role,
  });
  emitUpdate("discharge:update", { type: "plan", bedId, wardId, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

router.post("/:admissionId/reschedule", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { planned_date, planned_time, reason } = z.object({
    planned_date: z.string(),
    planned_time: z.string().max(10).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
  }).parse(req.body);

  const wardId = await assertAdmissionAccess(req.user!, admissionId);
  const tracking = await reschedule({
    admissionId, plannedDate: planned_date, plannedTime: planned_time, reason, userId: req.user!.id, role: req.user!.role,
  });
  emitUpdate("discharge:update", { type: "reschedule", admissionId, wardId, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

router.post("/:admissionId/cancel-plan", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body);

  const wardId = await assertAdmissionAccess(req.user!, admissionId);
  await cancelPlan({ admissionId, reason, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "cancel-plan", admissionId, wardId }, await fanout(wardId));
  res.json({ ok: true });
}));

router.post("/:admissionId/initiate", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const wardId = await assertAdmissionAccess(req.user!, admissionId);
  const tracking = await initiateDischarge({ admissionId, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "initiate", admissionId, wardId, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

router.post("/:admissionId/cancel", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body);

  const wardId = await assertAdmissionAccess(req.user!, admissionId);
  await cancelAfterInitiation({ admissionId, reason, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "cancel", admissionId, wardId }, await fanout(wardId));
  res.json({ ok: true });
}));

// ── Step updates (PRE / NURSE / DOCTOR / FC — enforced per-step in the service) ──

const STEP_KEYS: StepKey[] = [
  "DISCHARGE_INITIATION", "DISCHARGE_DOC", "DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION",
  "BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT", "SYSTEM_CHECKOUT", "PHYSICAL_CHECKOUT",
];

router.patch("/:admissionId/step", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { step, status, patient_left, reason } = z.object({
    step: z.enum(STEP_KEYS as [StepKey, ...StepKey[]]),
    status: z.string(),
    patient_left: z.boolean().nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
  }).parse(req.body);

  let wardId: number;
  if (HOSPITAL_WIDE_ROLES.includes(req.user!.role)) {
    ({ wardId } = await admissionWard(admissionId));
  } else {
    wardId = await assertAdmissionAccess(req.user!, admissionId);
  }

  const tracking = await updateStep({
    admissionId, step, status, patientLeft: patient_left, reason, userId: req.user!.id, role: req.user!.role,
  });
  emitUpdate("discharge:update", { type: "step", admissionId, wardId, step, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

// ── Reads ─────────────────────────────────────────────────────────────────────

router.get("/bed/:bedId", asyncH(async (req, res) => {
  const bedId = Number(req.params.bedId);
  await assertBedAccess(req.user!, bedId);
  const r = await getDischargeForBed(bedId);
  const config = await listPhaseConfig();
  res.json({ ...r, workflow: computeWorkflow(r.tracking as never, config) });
}));

router.get("/dashboard", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json(await dashboardCounts(wardIds, extraAdmissionIds));
}));

router.get("/active", asyncH(async (req, res) => {
  // A CONSULTANT's list is scoped by admission ownership (individual or group
  // membership), not ward — they see only their own patients either way.
  const mine = req.user!.role === "CONSULTANT" ? (req.user!.doctor_master_id ?? null) : null;
  const wardIdParam = req.query.wardId as string | undefined;
  if (wardIdParam) {
    const wardId = Number(wardIdParam);
    if (!mine) await assertWardAccess(req.user!.id, req.user!.role, wardId);
    res.json({ discharges: await decorateMany(await listActiveDischarges([wardId], mine) as never[]) });
    return;
  }
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await decorateMany(await listActiveDischarges(wardIds, mine, extraAdmissionIds) as never[]) });
}));

router.get("/ward/:wardId", asyncH(async (req, res) => {
  const wardId = Number(req.params.wardId);
  await assertWardAccess(req.user!.id, req.user!.role, wardId);
  res.json({ discharges: await dischargesForWard(wardId) });
}));

router.get("/pending", asyncH(async (req, res) => {
  const step = z.enum(STEP_KEYS as [StepKey, ...StepKey[]]).parse(req.query.step);
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await listPendingByStep(step, wardIds, extraAdmissionIds) });
}));

router.get("/billing-pipeline", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json(await listBillingPipeline(wardIds, extraAdmissionIds));
}));

router.get("/cancelled-today", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await listCancelledToday(wardIds, extraAdmissionIds) });
}));

router.get("/initiated-today", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await listInitiatedToday(wardIds, extraAdmissionIds) });
}));

router.get("/completed-today", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await listCompletedToday(wardIds, extraAdmissionIds) });
}));

router.get("/admitted-today", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ admissions: await listAdmittedToday(wardIds, extraAdmissionIds) });
}));

router.get("/patient-left", asyncH(async (req, res) => {
  const { wardIds, extraAdmissionIds } = await myWardScopeOrHospitalWide(req);
  res.json({ discharges: await listPatientLeft(wardIds, extraAdmissionIds) });
}));

router.get("/history/:admissionId", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  if (!HOSPITAL_WIDE_ROLES.includes(req.user!.role))
    await assertAdmissionAccess(req.user!, admissionId);
  res.json(await historyForAdmission(admissionId));
}));

// ── Bed transfer (PRE + Nurse + FC) ───────────────────────────────────────────
const TRANSFER_ROLES = ["PRE", "NURSE", "FC", "MASTER_FC"];

/** Every operational ward hospital-wide, including the Discharge Lounge — moving a
 *  bed there manually is now a valid transfer (see transferBed), each flagged with
 *  whether the caller's own ordinary assignment covers it. Purely informational —
 *  every ward returned here is still a valid transfer destination; inMyScope only lets
 *  the frontend warn before transferring into a ward outside the user's usual wards. */
router.get("/transfer/wards", asyncH(async (req, res) => {
  if (!TRANSFER_ROLES.includes(req.user!.role)) throw new HttpError(403, "Only PRE, Nurse, or FC can transfer beds");
  const wards = await wardsOperationalHospitalWide();

  let ownWardIds: Set<number>;
  if (req.user!.role === "PRE") {
    const rows = await db.prepare(
      `SELECT DISTINCT pbw.ward_id FROM pre_block_wards pbw
       JOIN user_pre_blocks upb ON upb.pre_block_id = pbw.pre_block_id
       WHERE upb.user_id = ?`
    ).all<{ ward_id: number }>(req.user!.id);
    ownWardIds = new Set(rows.map(r => r.ward_id));
  } else if (req.user!.role === "NURSE") {
    const stations = await getMyStations({ user: { id: req.user!.id } });
    const stationIds = stations.map(s => s.id);
    const rows = stationIds.length
      ? await db.prepare(`SELECT id AS ward_id FROM wards WHERE station_id = ANY(?)`).all<{ ward_id: number }>(stationIds)
      : [];
    ownWardIds = new Set(rows.map(r => r.ward_id));
  } else {
    // FC/MASTER_FC already have no narrower "own wards" concept — every
    // operational ward is equally theirs, so nothing here is ever out-of-scope.
    ownWardIds = new Set(wards.map(w => w.id));
  }

  res.json({ wards: wards.map(w => ({ ...w, inMyScope: ownWardIds.has(w.id) })) });
}));

router.get("/transfer/candidates", asyncH(async (req, res) => {
  if (!TRANSFER_ROLES.includes(req.user!.role)) throw new HttpError(403, "Only PRE, Nurse, or FC can transfer beds");
  const wardId = Number(req.query.wardId);
  if (!wardId) throw new HttpError(400, "wardId is required");
  await assertTransferDestinationAccess(wardId);
  res.json({ beds: await listTransferCandidates(wardId) });
}));

router.post("/transfer", asyncH(async (req, res) => {
  if (!TRANSFER_ROLES.includes(req.user!.role)) throw new HttpError(403, "Only PRE, Nurse, or FC can transfer beds");
  const { fromBedId, toWardId, toBedId, reason } = z.object({
    fromBedId: z.number().int(),
    toWardId: z.number().int(),
    toBedId: z.number().int(),
    reason: z.string().min(1).max(500),
  }).parse(req.body);

  const fromWardId = await bedWard(fromBedId);
  await assertWardAccess(req.user!.id, req.user!.role, fromWardId);
  await assertTransferDestinationAccess(toWardId);

  const result = await transferBed({ fromBedId, toWardId, toBedId, reason, userId: req.user!.id });
  // One merged emit instead of two separate ones — emitUpdate always also hits the
  // "overview" room regardless of opts, so calling it twice (once per ward) doubled
  // every connected client's refresh for this single transfer, worst-case (same-ward
  // transfer) sending the exact same event twice to the exact same rooms.
  const fromFan = await fanout(fromWardId);
  const toFan = fromWardId === toWardId ? fromFan : await fanout(toWardId);
  const preRooms = [...new Set([fromFan.pre, toFan.pre].filter((v): v is string => !!v))];
  const stationRooms = [...new Set([fromFan.stationId, toFan.stationId].filter((v): v is number => v != null))];
  emitUpdate("discharge:update", { type: "transfer", ...result, fromWardId, toWardId }, {
    pre: preRooms.length ? preRooms : undefined,
    stationId: stationRooms.length ? stationRooms : undefined,
    wardId: [...new Set([fromWardId, toWardId])],
  });
  res.json(result);
}));

router.post("/:admissionId/readmit", asyncH(async (req, res) => {
  if (!TRANSFER_ROLES.includes(req.user!.role)) throw new HttpError(403, "Only PRE, Nurse, or FC can readmit a patient");
  const admissionId = Number(req.params.admissionId);
  const { toWardId, toBedId, reason } = z.object({
    toWardId: z.number().int(),
    toBedId: z.number().int(),
    reason: z.string().min(1).max(500),
  }).parse(req.body);

  const { wardId: fromWardId, bedId: fromBedId } = await admissionWard(admissionId);
  await assertTransferDestinationAccess(toWardId);

  const result = await readmitFromLounge({ fromBedId, toWardId, toBedId, reason, userId: req.user!.id });
  const fromFan = await fanout(fromWardId);
  const toFan = fromWardId === toWardId ? fromFan : await fanout(toWardId);
  const preRooms = [...new Set([fromFan.pre, toFan.pre].filter((v): v is string => !!v))];
  const stationRooms = [...new Set([fromFan.stationId, toFan.stationId].filter((v): v is number => v != null))];
  emitUpdate("discharge:update", { type: "readmit", ...result, fromWardId }, {
    pre: preRooms.length ? preRooms : undefined,
    stationId: stationRooms.length ? stationRooms : undefined,
    wardId: [...new Set([fromWardId, toWardId])],
  });
  res.json(result);
}));

// PRE-only emergency override: force-completes every checklist step on a lounge
// admission's discharge and closes it out immediately. Irreversible — the client
// is expected to have already confirmed this with the user before calling it.
router.post("/:admissionId/force-complete", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const fromWardId = await assertAdmissionAccess(req.user!, admissionId);
  await dischargeImmediate({ admissionId, userId: req.user!.id, role: req.user!.role as Role });
  emitUpdate("discharge:update", { type: "force-complete", admissionId, wardId: fromWardId }, await fanout(fromWardId));
  res.json({ ok: true });
}));

// Physical Checkout is complete but System Checkout is still pending — PRE or Nurse,
// matching whoever is allowed to complete Physical Checkout itself (see PHYSICAL_CHECKOUT
// in dischargeService.ts's STEP_PERMISSIONS). Moves the admission to a Discharge Lounge bed
// and frees the real bed immediately, instead of leaving it Occupied with nobody in it.
router.post("/:admissionId/move-to-lounge", asyncH(async (req, res) => {
  if (!["PRE", "NURSE"].includes(req.user!.role)) throw new HttpError(403, "Only PRE or Nurse can move a bed to the Discharge Lounge");
  const admissionId = Number(req.params.admissionId);
  const fromWardId = await assertAdmissionAccess(req.user!, admissionId);
  const { bedId: fromBedId } = await admissionWard(admissionId);

  const result = await moveToDischargeLounge({ admissionId, fromBedId, userId: req.user!.id });
  emitUpdate("discharge:update", { type: "lounge_move", ...result, fromWardId }, await fanout(fromWardId));
  res.json(result);
}));

// ── Phase SLA config (readable by everyone, so each app can label its own
//    phases and show the expected duration; COO edits it via /manager) ────────
router.get("/phase-config", asyncH(async (_req, res) => {
  res.json({ phases: await listPhaseConfig() });
}));

export default router;
