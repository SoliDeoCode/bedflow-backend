import { Router } from "express";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { db } from "../db/index.js";
import { emitUpdate } from "../websocket/io.js";
import type { Role } from "../types/index.js";
import {
  planDischarge, reschedule, cancelPlan, initiateDischarge, cancelAfterInitiation,
  updateStep, dashboardCounts, historyForAdmission, getDischargeForBed, dischargesForWard, listPendingByStep, listActiveDischarges,
  type StepKey,
} from "../services/dischargeService.js";
import { getAdmissionById } from "../services/patientAdmissionService.js";
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

/** Throws 403 unless the caller (per their role) can act on this ward. FC/COO always pass. */
async function assertWardAccess(userId: number, role: Role, wardId: number) {
  if (role === "FC" || role === "COO") return;
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

async function assertBedAccess(userId: number, role: Role, bedId: number) {
  if (role === "NURSE") {
    const stations = await getMyStations({ user: { id: userId } });
    const allowed = await canNurseAccessBed(userId, bedId, stations.map(s => s.id));
    if (!allowed) throw new HttpError(403, "You do not have access to this bed");
    return;
  }
  const wardId = await bedWard(bedId);
  await assertWardAccess(userId, role, wardId);
}

async function admissionWard(admissionId: number): Promise<{ wardId: number; bedId: number }> {
  const admission = await getAdmissionById(admissionId);
  if (!admission) throw new HttpError(404, "Admission not found");
  return { wardId: admission.ward_id, bedId: admission.bed_id };
}

async function assertAdmissionAccess(userId: number, role: Role, admissionId: number): Promise<number> {
  const { wardId, bedId } = await admissionWard(admissionId);
  if (role === "NURSE") await assertBedAccess(userId, role, bedId);
  else await assertWardAccess(userId, role, wardId);
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
  if (role === "FC" || role === "COO") return null;
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
  await assertWardAccess(req.user!.id, req.user!.role, wardId);

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

  const wardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
  const tracking = await reschedule({
    admissionId, plannedDate: planned_date, plannedTime: planned_time, reason, userId: req.user!.id, role: req.user!.role,
  });
  emitUpdate("discharge:update", { type: "reschedule", admissionId, wardId, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

router.post("/:admissionId/cancel-plan", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body);

  const wardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
  await cancelPlan({ admissionId, reason, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "cancel-plan", admissionId, wardId }, await fanout(wardId));
  res.json({ ok: true });
}));

router.post("/:admissionId/initiate", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const wardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
  const tracking = await initiateDischarge({ admissionId, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "initiate", admissionId, wardId, tracking }, await fanout(wardId));
  res.json({ ok: true, tracking });
}));

router.post("/:admissionId/cancel", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  const { reason } = z.object({ reason: z.string().max(500).nullable().optional() }).parse(req.body);

  const wardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
  await cancelAfterInitiation({ admissionId, reason, userId: req.user!.id, role: req.user!.role });
  emitUpdate("discharge:update", { type: "cancel", admissionId, wardId }, await fanout(wardId));
  res.json({ ok: true });
}));

// ── Step updates (PRE / NURSE / DOCTOR / FC — enforced per-step in the service) ──

const STEP_KEYS: StepKey[] = [
  "DISCHARGE_SUMMARY", "DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION",
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

  // FC's steps (BILL_READY, PAYMENT) are hospital-wide — no ward scoping.
  // Every other role's step is scoped to wards/beds they're allowed to touch.
  let wardId: number;
  if (req.user!.role === "FC") {
    ({ wardId } = await admissionWard(admissionId));
  } else {
    wardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
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
  await assertBedAccess(req.user!.id, req.user!.role, bedId);
  res.json(await getDischargeForBed(bedId));
}));

router.get("/dashboard", asyncH(async (req, res) => {
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json(await dashboardCounts(wardIds));
}));

router.get("/active", asyncH(async (req, res) => {
  const wardIdParam = req.query.wardId as string | undefined;
  if (wardIdParam) {
    const wardId = Number(wardIdParam);
    await assertWardAccess(req.user!.id, req.user!.role, wardId);
    res.json({ discharges: await listActiveDischarges([wardId]) });
    return;
  }
  const wardIds = await myWardScope(req.user!.id, req.user!.role);
  res.json({ discharges: await listActiveDischarges(wardIds) });
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

router.get("/history/:admissionId", asyncH(async (req, res) => {
  const admissionId = Number(req.params.admissionId);
  if (req.user!.role !== "FC" && req.user!.role !== "COO")
    await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
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
  emitUpdate("discharge:update", { type: "transfer", ...result, fromWardId, toWardId }, await fanout(fromWardId));
  emitUpdate("discharge:update", { type: "transfer", ...result, fromWardId, toWardId }, await fanout(toWardId));
  res.json(result);
}));

// Physical Checkout is complete but System Checkout is still pending — PRE-only for now
// (see moveToDischargeLounge). Moves the admission to a Discharge Lounge bed and frees
// the real bed immediately, instead of leaving it Occupied with nobody in it.
router.post("/:admissionId/move-to-lounge", asyncH(async (req, res) => {
  if (req.user!.role !== "PRE") throw new HttpError(403, "Only PRE can move a bed to the Discharge Lounge");
  const admissionId = Number(req.params.admissionId);
  const fromWardId = await assertAdmissionAccess(req.user!.id, req.user!.role, admissionId);
  const { bedId: fromBedId } = await admissionWard(admissionId);

  const result = await moveToDischargeLounge({ admissionId, fromBedId, userId: req.user!.id });
  emitUpdate("discharge:update", { type: "lounge_move", ...result, fromWardId }, await fanout(fromWardId));
  res.json(result);
}));

export default router;
