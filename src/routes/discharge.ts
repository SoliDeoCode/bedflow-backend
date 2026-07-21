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
  type StepKey,
} from "../services/dischargeService.js";
import { getAdmissionById } from "../services/patientAdmissionService.js";
import { listPhaseConfig, computeWorkflow, decorateMany } from "../services/dischargeSlaService.js";
import { listTransferCandidates, transferBed, moveToDischargeLounge } from "../services/bedTransferService.js";
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

/** A CONSULTANT owns only the beds whose ACTIVE admission carries their name —
 *  ward-level access means nothing for them, so every write must check this. */
async function consultantOwnsBed(name: string, bedId: number): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 FROM patient_admissions WHERE bed_id=? AND status='ACTIVE' AND consultant_name=?"
  ).get(bedId, name);
  return !!row;
}

async function consultantOwnsAdmission(name: string, admissionId: number): Promise<boolean> {
  const row = await db.prepare(
    "SELECT 1 FROM patient_admissions WHERE id=? AND consultant_name=?"
  ).get(admissionId, name);
  return !!row;
}

async function assertBedAccess(user: { id: number; role: Role; name: string }, bedId: number) {
  if (user.role === "NURSE") {
    const stations = await getMyStations({ user: { id: user.id } });
    const allowed = await canNurseAccessBed(user.id, bedId, stations.map(s => s.id));
    if (!allowed) throw new HttpError(403, "You do not have access to this bed");
    return;
  }
  if (user.role === "CONSULTANT") {
    if (!(await consultantOwnsBed(user.name, bedId)))
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

async function assertAdmissionAccess(user: { id: number; role: Role; name: string }, admissionId: number): Promise<number> {
  const { wardId, bedId } = await admissionWard(admissionId);
  if (user.role === "NURSE") await assertBedAccess(user, bedId);
  else if (user.role === "CONSULTANT") {
    if (!(await consultantOwnsAdmission(user.name, admissionId)))
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
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json(await dashboardCounts(wardIds));
}));

router.get("/active", asyncH(async (req, res) => {
  // A CONSULTANT's list is scoped by admission ownership, not ward — they see
  // only their own patients, whether the request is ward-filtered or not.
  const mine = req.user!.role === "CONSULTANT" ? req.user!.name : null;
  const wardIdParam = req.query.wardId as string | undefined;
  if (wardIdParam) {
    const wardId = Number(wardIdParam);
    if (!mine) await assertWardAccess(req.user!.id, req.user!.role, wardId);
    res.json({ discharges: await decorateMany(await listActiveDischarges([wardId], mine) as never[]) });
    return;
  }
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await decorateMany(await listActiveDischarges(wardIds, mine) as never[]) });
}));

router.get("/ward/:wardId", asyncH(async (req, res) => {
  const wardId = Number(req.params.wardId);
  await assertWardAccess(req.user!.id, req.user!.role, wardId);
  res.json({ discharges: await dischargesForWard(wardId) });
}));

router.get("/pending", asyncH(async (req, res) => {
  const step = z.enum(STEP_KEYS as [StepKey, ...StepKey[]]).parse(req.query.step);
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listPendingByStep(step, wardIds) });
}));

router.get("/billing-pipeline", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json(await listBillingPipeline(wardIds));
}));

router.get("/cancelled-today", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listCancelledToday(wardIds) });
}));

router.get("/initiated-today", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listInitiatedToday(wardIds) });
}));

router.get("/completed-today", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listCompletedToday(wardIds) });
}));

router.get("/admitted-today", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ admissions: await listAdmittedToday(wardIds) });
}));

router.get("/patient-left", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listPatientLeft(wardIds) });
}));

router.get("/history/:admissionId", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  if (!HOSPITAL_WIDE_ROLES.includes(req.user!.role))
    await assertAdmissionAccess(req.user!, admissionId);
  res.json(await historyForAdmission(admissionId));
}));

// ── Bed transfer (PRE only) ───────────────────────────────────────────────────

router.get("/transfer/candidates", asyncH(async (req, res) => {
  if (req.user!.role !== "PRE") throw new HttpError(403, "Only PRE can transfer beds");
  const wardId = Number(req.query.wardId);
  if (!wardId) throw new HttpError(400, "wardId is required");
  await assertWardAccess(req.user!.id, req.user!.role, wardId);
  res.json({ beds: await listTransferCandidates(wardId) });
}));

router.post("/transfer", asyncH(async (req, res) => {
  if (req.user!.role !== "PRE") throw new HttpError(403, "Only PRE can transfer beds");
  const { fromBedId, toWardId, toBedId, reason } = z.object({
    fromBedId: z.number().int(),
    toWardId: z.number().int(),
    toBedId: z.number().int(),
    reason: z.string().min(1).max(500),
  }).parse(req.body);

  const fromWardId = await bedWard(fromBedId);
  await assertWardAccess(req.user!.id, req.user!.role, fromWardId);
  await assertWardAccess(req.user!.id, req.user!.role, toWardId);

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

// Physical Checkout is complete but System Checkout is still pending — PRE-only for now
// (see moveToDischargeLounge). Moves the admission to a Discharge Lounge bed and frees
// the real bed immediately, instead of leaving it Occupied with nobody in it.
router.post("/:admissionId/move-to-lounge", asyncH(async (req, res) => {
  if (req.user!.role !== "PRE") throw new HttpError(403, "Only PRE can move a bed to the Discharge Lounge");
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
