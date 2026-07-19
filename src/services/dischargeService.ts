import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { updateBedStatus } from "./bedDetailService.js";
import { getActiveAdmissionByBed, getAdmissionById, closeAdmission, type PatientAdmission } from "./patientAdmissionService.js";
import { initialStartSql, nextPhaseToStart, startedCol, completedCol, ALL_STEPS } from "./dischargeSlaService.js";
import type { Role } from "../types/index.js";

export interface DischargeTracking {
  id: number;
  admission_id: number;
  status: "PLANNED" | "DISCHARGE_INITIATED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
  planned_date: string;
  planned_time: string | null;
  planned_by: number | null;
  prompted_at: number | null;
  initiated_at: number | null;
  discharge_summary_status: string;
  discharge_doc_status: string;
  drug_return_status: string;
  pharmacy_clearance_status: string;
  procedure_reconciliation_status: string;
  billing_started_status: string;
  audit_status: string;
  bill_ready_status: string;
  payment_status: string;
  system_checkout_status: string;
  physical_checkout_status: string;
  patient_left: boolean | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export type StepKey =
  | "DISCHARGE_SUMMARY" | "DISCHARGE_DOC" | "DRUG_RETURN" | "PHARMACY_CLEARANCE" | "PROCEDURE_RECONCILIATION"
  | "BILLING_STARTED" | "AUDIT" | "BILL_READY" | "PAYMENT" | "SYSTEM_CHECKOUT" | "PHYSICAL_CHECKOUT";

const STEP_COLUMN: Record<StepKey, string> = {
  DISCHARGE_SUMMARY: "discharge_summary_status",
  DISCHARGE_DOC: "discharge_doc_status",
  DRUG_RETURN: "drug_return_status",
  PHARMACY_CLEARANCE: "pharmacy_clearance_status",
  PROCEDURE_RECONCILIATION: "procedure_reconciliation_status",
  BILLING_STARTED: "billing_started_status",
  AUDIT: "audit_status",
  BILL_READY: "bill_ready_status",
  PAYMENT: "payment_status",
  SYSTEM_CHECKOUT: "system_checkout_status",
  PHYSICAL_CHECKOUT: "physical_checkout_status",
};

// Roles allowed to update each step. "Wrong checklist update" is explicitly
// allowed by the spec (edit + save history) — there is no enforced step
// ordering here, only who is allowed to touch a given step.
export const STEP_PERMISSIONS: Record<StepKey, Role[]> = {
  DISCHARGE_SUMMARY: ["DOCTOR", "CONSULTANT"],
  DISCHARGE_DOC: ["DOCTOR", "CONSULTANT"],
  DRUG_RETURN: ["PRE", "NURSE"],
  PHARMACY_CLEARANCE: ["PRE", "NURSE"],
  PROCEDURE_RECONCILIATION: ["PRE"],
  BILLING_STARTED: ["PRE"],
  AUDIT: ["PRE"],
  BILL_READY: ["FC"],
  PAYMENT: ["FC"],
  SYSTEM_CHECKOUT: ["PRE"],
  PHYSICAL_CHECKOUT: ["PRE", "NURSE"],
};

const STEP_LABELS: Record<StepKey, string> = {
  DISCHARGE_SUMMARY: "Discharge Initiate",
  DISCHARGE_DOC: "Discharge Summary",
  DRUG_RETURN: "Drug Return",
  PHARMACY_CLEARANCE: "Pharmacy Clearance",
  PROCEDURE_RECONCILIATION: "Procedure Reconciliation",
  BILLING_STARTED: "Bill Prep",
  AUDIT: "Audit",
  BILL_READY: "Bill Finalized",
  PAYMENT: "Payment Status",
  SYSTEM_CHECKOUT: "System Checkout",
  PHYSICAL_CHECKOUT: "Physical Checkout",
};

// Every step System Checkout must wait on — everything except itself and Physical
// Checkout (which happens after/parallel to it, not before it).
const PRE_SYSTEM_CHECKOUT_STEPS: StepKey[] = [
  "DISCHARGE_SUMMARY", "DISCHARGE_DOC", "DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION",
  "BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT",
];

const STEP_VALUES: Record<StepKey, string[]> = {
  DISCHARGE_SUMMARY: ["PENDING", "COMPLETED"],
  DISCHARGE_DOC: ["PENDING", "COMPLETED"],
  DRUG_RETURN: ["PENDING", "COMPLETED"],
  PHARMACY_CLEARANCE: ["PENDING", "COMPLETED"],
  PROCEDURE_RECONCILIATION: ["PENDING", "COMPLETED", "NOT_APPLICABLE"],
  BILLING_STARTED: ["PENDING", "COMPLETED"],
  AUDIT: ["PENDING", "COMPLETED"],
  BILL_READY: ["PENDING", "COMPLETED"],
  PAYMENT: ["PENDING", "COMPLETED"],
  SYSTEM_CHECKOUT: ["PENDING", "COMPLETED"],
  PHYSICAL_CHECKOUT: ["PENDING", "COMPLETED"],
};

// CONSULTANT plans/initiates only for their own patients — ownership is enforced
// upstream in discharge.ts (consultantOwnsBed / consultantOwnsAdmission).
const PLAN_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];
const RESCHEDULE_ROLES: Role[] = ["PRE", "DOCTOR", "CONSULTANT"];
const CANCEL_ROLES: Role[] = ["PRE", "DOCTOR"];
const INITIATE_ROLES: Role[] = ["PRE", "CONSULTANT"];

function requireRoleIn(role: Role, allowed: Role[], action: string) {
  if (!allowed.includes(role))
    throw new HttpError(403, `${action} requires role: ${allowed.join(" or ")}`);
}

async function logHistory(opts: {
  admissionId: number; trackingId: number | null; field: string;
  oldValue: unknown; newValue: unknown; userId: number | null; reason?: string | null;
}) {
  await db.prepare(
    `INSERT INTO discharge_history (admission_id, discharge_tracking_id, field, old_value, new_value, changed_by, changed_at, reason)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    opts.admissionId, opts.trackingId, opts.field,
    opts.oldValue === undefined || opts.oldValue === null ? null : String(opts.oldValue),
    opts.newValue === undefined || opts.newValue === null ? null : String(opts.newValue),
    opts.userId, Date.now(), opts.reason ?? null,
  );
}

export async function getTrackingByAdmission(admissionId: number): Promise<DischargeTracking | undefined> {
  return db.prepare("SELECT * FROM discharge_tracking WHERE admission_id=?").get<DischargeTracking>(admissionId);
}

async function getTrackingById(trackingId: number): Promise<DischargeTracking | undefined> {
  return db.prepare("SELECT * FROM discharge_tracking WHERE id=?").get<DischargeTracking>(trackingId);
}

function isValidDate(s: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** For the discharge view of a bed: active admission (if any) + its tracking row. */
export async function getDischargeForBed(bedId: number) {
  const admission = await getActiveAdmissionByBed(bedId);
  if (!admission) return { admission: null, tracking: null };
  const tracking = await getTrackingByAdmission(admission.id);
  return { admission, tracking: tracking ?? null };
}

/** Every active admission in a ward with its discharge tracking (if any) — powers the
 *  ward card's "Discharge" button, which shows everything in flight for that ward. */
export async function dischargesForWard(wardId: number) {
  return db.prepare(`
    SELECT pa.id AS admission_id, pa.bed_id, bd.bed_name, pa.ip_last6, dt.*
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
    WHERE pa.ward_id = ? AND pa.status = 'ACTIVE'
    ORDER BY bd.bed_name
  `).all(wardId);
}

/** Every discharge that's currently alive (planned or running) across the given wards —
 *  powers the "Discharges" page each role sees. wardIds = null is hospital-wide.
 *  Running discharges come first (most actionable), then planned by nearest date. */
/** consultantName — CONSULTANT scoping is by admission ownership, not by ward, so
 *  their Discharges page shows only their own patients. */
export async function listActiveDischarges(wardIds: number[] | null, consultantName?: string | null) {
  const params: unknown[] = [];
  let scopeClause = "";
  if (wardIds) { scopeClause += " AND pa.ward_id = ANY(?)"; params.push(wardIds); }
  if (consultantName) { scopeClause += " AND pa.consultant_name = ?"; params.push(consultantName); }

  return db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6,
           bd.bed_name, bd.payer_type, w.name AS ward_name
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('PLANNED','DISCHARGE_INITIATED','IN_PROGRESS')
      ${scopeClause}
    ORDER BY (dt.status = 'PLANNED') ASC, dt.planned_date ASC, w.name, bd.bed_name
  `).all(...params);
}

/** Admissions where the given step is PENDING and the discharge is actually running —
 *  the actionable queue behind FC's Bill Finalized / Payment Status screen (and reusable for any
 *  other role's "what do I need to act on" list). wardIds = null is hospital-wide. */
export async function listPendingByStep(step: StepKey, wardIds: number[] | null) {
  const col = STEP_COLUMN[step];
  if (!col) throw new HttpError(400, `Unknown discharge step: ${step}`);
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];

  return db.prepare(`
    SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6, bd.bed_name, w.name AS ward_name
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.status='ACTIVE' AND dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS')
      AND dt.${col} = 'PENDING' ${scopeClause}
    ORDER BY dt.updated_at ASC
  `).all(...params);
}

export async function planDischarge(opts: {
  bedId: number; plannedDate: string; plannedTime?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  requireRoleIn(opts.role, PLAN_ROLES, "Planning a discharge");
  if (!isValidDate(opts.plannedDate)) throw new HttpError(400, "planned_date must be YYYY-MM-DD");

  const admission = await getActiveAdmissionByBed(opts.bedId);
  if (!admission) throw new HttpError(404, "No active patient admission for this bed");

  const existing = await getTrackingByAdmission(admission.id);
  if (existing && !["CANCELLED"].includes(existing.status))
    throw new HttpError(409, "This admission already has a discharge in progress");

  const now = Date.now();
  const row = await db.prepare(
    `INSERT INTO discharge_tracking (admission_id, status, planned_date, planned_time, planned_by, created_by, created_at, updated_at)
     VALUES (?, 'PLANNED', ?, ?, ?, ?, ?, ?) RETURNING id`
  ).run(admission.id, opts.plannedDate, opts.plannedTime ?? null, opts.userId, opts.userId, now, now);
  const trackingId = Number(row.lastInsertRowid);

  await logHistory({
    admissionId: admission.id, trackingId, field: "plan",
    oldValue: null, newValue: `${opts.plannedDate} ${opts.plannedTime ?? ""}`.trim(), userId: opts.userId,
  });
  await audit(opts.userId, "discharge_plan", String(admission.id), { bedId: opts.bedId, plannedDate: opts.plannedDate, plannedTime: opts.plannedTime });

  return (await getTrackingById(trackingId))!;
}

export async function reschedule(opts: {
  admissionId: number; plannedDate: string; plannedTime?: string | null; reason?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  requireRoleIn(opts.role, RESCHEDULE_ROLES, "Rescheduling a discharge");
  if (!isValidDate(opts.plannedDate)) throw new HttpError(400, "planned_date must be YYYY-MM-DD");

  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Cannot reschedule a discharge that is already ${tracking.status.toLowerCase()}`);

  const oldValue = `${tracking.planned_date} ${tracking.planned_time ?? ""}`.trim();
  const newValue = `${opts.plannedDate} ${opts.plannedTime ?? ""}`.trim();
  const now = Date.now();
  await db.prepare(
    "UPDATE discharge_tracking SET planned_date=?, planned_time=?, status='PLANNED', prompted_at=NULL, updated_at=? WHERE id=?"
  ).run(opts.plannedDate, opts.plannedTime ?? null, now, tracking.id);

  await logHistory({
    admissionId: opts.admissionId, trackingId: tracking.id, field: "reschedule",
    oldValue, newValue, userId: opts.userId, reason: opts.reason,
  });
  await audit(opts.userId, "discharge_reschedule", String(opts.admissionId), { from: oldValue, to: newValue, reason: opts.reason });

  return (await getTrackingById(tracking.id))!;
}

export async function cancelPlan(opts: { admissionId: number; reason?: string | null; userId: number; role: Role }): Promise<void> {
  requireRoleIn(opts.role, CANCEL_ROLES, "Cancelling a discharge plan");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (tracking.status !== "PLANNED")
    throw new HttpError(409, "Only a discharge that hasn't started yet can be cancelled this way");

  const now = Date.now();
  await db.prepare("UPDATE discharge_tracking SET status='CANCELLED', updated_at=? WHERE id=?").run(now, tracking.id);
  await logHistory({
    admissionId: opts.admissionId, trackingId: tracking.id, field: "status",
    oldValue: tracking.status, newValue: "CANCELLED", userId: opts.userId, reason: opts.reason,
  });
  await audit(opts.userId, "discharge_cancel_plan", String(opts.admissionId), { reason: opts.reason });
}

export async function initiateDischarge(opts: { admissionId: number; userId: number; role: Role }): Promise<DischargeTracking> {
  requireRoleIn(opts.role, INITIATE_ROLES, "Starting a discharge");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge plan found for this admission");
  if (tracking.status !== "PLANNED")
    throw new HttpError(409, `Cannot start — discharge is already ${tracking.status}`);

  const now = Date.now();

  // Snapshot payer_type from the bed at initiation time — after discharge the
  // bed is vacated and bed_details.payer_type is cleared to NULL, so we need
  // to capture it now while the patient is still in the bed.
  const admRow = await db.prepare(
    `SELECT bd.payer_type FROM patient_admissions pa
     JOIN bed_details bd ON bd.id = pa.bed_id
     WHERE pa.id = ?`
  ).get<{ payer_type: string | null }>(opts.admissionId);
  const payerType = admRow?.payer_type ?? null;

  // Starting the discharge opens every group-leading phase at once — that start
  // stamp is what the SLA deadline and ETA are measured from.
  const { sql: startSql, params: startParams } = initialStartSql(now);
  await db.prepare(
    `UPDATE discharge_tracking SET status='DISCHARGE_INITIATED', initiated_at=?, payer_type=?, ${startSql}, updated_at=? WHERE id=?`
  ).run(now, payerType, ...startParams, now, tracking.id);
  await logHistory({
    admissionId: opts.admissionId, trackingId: tracking.id, field: "status",
    oldValue: tracking.status, newValue: "DISCHARGE_INITIATED", userId: opts.userId,
  });
  await audit(opts.userId, "discharge_initiate", String(opts.admissionId), {});

  return (await getTrackingById(tracking.id))!;
}

async function resetAndCancelTracking(tracking: DischargeTracking, userId: number | null, reason: string | null | undefined) {
  const now = Date.now();
  for (const step of Object.keys(STEP_COLUMN) as StepKey[]) {
    const col = STEP_COLUMN[step];
    const oldValue = (tracking as unknown as Record<string, string>)[col];
    if (oldValue !== "PENDING") {
      await logHistory({
        admissionId: tracking.admission_id, trackingId: tracking.id, field: step,
        oldValue, newValue: "PENDING", userId, reason: reason ?? "Discharge cancelled after initiation",
      });
    }
  }
  // Reset the SLA clocks too — a cancelled workflow must not carry stale start
  // times into a later re-plan, or every phase would look instantly delayed.
  const clearSla = ALL_STEPS
    .flatMap(k => [`${startedCol(k)}=NULL`, `${completedCol(k)}=NULL`])
    .join(", ");
  await db.prepare(`
    UPDATE discharge_tracking SET
      status='CANCELLED',
      discharge_summary_status='PENDING', discharge_doc_status='PENDING', drug_return_status='PENDING', pharmacy_clearance_status='PENDING',
      procedure_reconciliation_status='PENDING', billing_started_status='PENDING', audit_status='PENDING',
      bill_ready_status='PENDING', payment_status='PENDING', system_checkout_status='PENDING', physical_checkout_status='PENDING',
      ${clearSla},
      patient_left=NULL, updated_at=?
    WHERE id=?
  `).run(now, tracking.id);

  await logHistory({
    admissionId: tracking.admission_id, trackingId: tracking.id, field: "status",
    oldValue: tracking.status, newValue: "CANCELLED", userId, reason,
  });
  await audit(userId, "discharge_cancel", String(tracking.admission_id), { reason });
}

/** "Discharge cancelled after initiation" edge case: stop workflow, reset checklist, keep history. */
export async function cancelAfterInitiation(opts: { admissionId: number; reason?: string | null; userId: number; role: Role }): Promise<void> {
  requireRoleIn(opts.role, CANCEL_ROLES, "Cancelling an in-progress discharge");
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Discharge is already ${tracking.status}`);

  await resetAndCancelTracking(tracking, opts.userId, opts.reason);
}

/** Called from bedDetailService when a bed with an active admission is manually marked
 *  Vacant outside the discharge workflow. No role gate — this is a system-triggered side
 *  effect of the physical-status change itself, not a user-initiated cancel action. */
export async function handleManualVacate(bedId: number, userId: number | null): Promise<void> {
  const admission = await getActiveAdmissionByBed(bedId);
  if (!admission) return;

  const tracking = await getTrackingByAdmission(admission.id);
  if (tracking && !["COMPLETED", "CANCELLED"].includes(tracking.status))
    await resetAndCancelTracking(tracking, userId, "Bed manually marked vacant outside the discharge workflow");

  await closeAdmission(admission.id, userId);
}

/** Vacates the bed + closes the admission once both checkouts are done and the patient has left.
 *  This is the only place the discharge module is allowed to change bed status. */
async function completeIfEligible(tracking: DischargeTracking, userId: number) {
  if (tracking.system_checkout_status !== "COMPLETED") return;
  if (tracking.physical_checkout_status !== "COMPLETED") return;
  if (tracking.patient_left !== true) return;
  if (tracking.status === "COMPLETED") return;

  const admission = await getAdmissionById(tracking.admission_id);
  if (!admission) return;

  await updateBedStatus({
    bedId: admission.bed_id, physicalStatus: "VACANT", reservationStatus: "NONE",
    userId, changeReason: "DISCHARGE_CHECKOUT",
  });
  await closeAdmission(admission.id, userId);

  const now = Date.now();
  await db.prepare("UPDATE discharge_tracking SET status='COMPLETED', updated_at=? WHERE id=?").run(now, tracking.id);
  await logHistory({
    admissionId: tracking.admission_id, trackingId: tracking.id, field: "status",
    oldValue: tracking.status, newValue: "COMPLETED", userId,
  });
  await audit(userId, "discharge_complete", String(tracking.admission_id), {});
}

export async function updateStep(opts: {
  admissionId: number; step: StepKey; status: string; patientLeft?: boolean | null;
  reason?: string | null; userId: number; role: Role;
}): Promise<DischargeTracking> {
  const permission = STEP_PERMISSIONS[opts.step];
  if (!permission) throw new HttpError(400, `Unknown discharge step: ${opts.step}`);
  requireRoleIn(opts.role, permission, `Updating ${opts.step}`);

  const allowedValues = STEP_VALUES[opts.step];
  if (!allowedValues.includes(opts.status))
    throw new HttpError(400, `Invalid status for ${opts.step}. Must be one of: ${allowedValues.join(", ")}`);

  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (["COMPLETED", "CANCELLED"].includes(tracking.status))
    throw new HttpError(409, `Discharge is already ${tracking.status} — cannot update steps`);

  if (opts.step === "PHYSICAL_CHECKOUT" && opts.status === "COMPLETED" && opts.patientLeft === undefined)
    throw new HttpError(400, "patient_left (true/false) is required when completing Physical Checkout");

  // System Checkout must be the last administrative step — it can't be marked
  // complete while any other part of the discharge flow (doctor summary, drug/
  // clinical clearance, billing & payment) is still outstanding.
  if (opts.step === "SYSTEM_CHECKOUT" && opts.status === "COMPLETED") {
    const pending = PRE_SYSTEM_CHECKOUT_STEPS.filter((key) => {
      const val = (tracking as unknown as Record<string, string>)[STEP_COLUMN[key]];
      return !["COMPLETED", "NOT_APPLICABLE"].includes(val);
    });
    if (pending.length > 0)
      throw new HttpError(409, `Complete these steps before System Checkout: ${pending.map((k) => STEP_LABELS[k]).join(", ")}`);
  }

  const col = STEP_COLUMN[opts.step];
  const oldValue = (tracking as unknown as Record<string, string>)[col];
  const now = Date.now();

  // First real step update after initiation moves status from
  // DISCHARGE_INITIATED to IN_PROGRESS — purely informational for the UI.
  const nextStatus = tracking.status === "DISCHARGE_INITIATED" ? "IN_PROGRESS" : tracking.status;

  const patientLeft = opts.step === "PHYSICAL_CHECKOUT" ? (opts.patientLeft ?? null) : tracking.patient_left;

  // SLA bookkeeping. Finishing a phase stamps its completion time and opens the
  // next phase in the same group (nextPhaseToStart also unlocks System Checkout
  // once groups 1-3 are all clear). Reopening a phase clears its completion so
  // the deadline is measured from the original start again.
  const slaSets: string[] = [];
  const slaParams: unknown[] = [];
  const isDone = ["COMPLETED", "NOT_APPLICABLE"].includes(opts.status);
  if (isDone) {
    slaSets.push(`${completedCol(opts.step)}=?`); slaParams.push(now);
    // A phase can be completed before it was ever formally started (out-of-order
    // edits are allowed) — stamp a start so duration/ETA maths stay sane.
    slaSets.push(`${startedCol(opts.step)}=COALESCE(${startedCol(opts.step)}, ?)`); slaParams.push(now);
    const next = nextPhaseToStart(opts.step, tracking as unknown as Record<string, unknown>);
    if (next) { slaSets.push(`${startedCol(next)}=COALESCE(${startedCol(next)}, ?)`); slaParams.push(now); }
  } else {
    slaSets.push(`${completedCol(opts.step)}=NULL`);
  }
  const slaSql = slaSets.length ? `, ${slaSets.join(", ")}` : "";

  await db.prepare(
    `UPDATE discharge_tracking SET ${col}=?, status=?, patient_left=?${slaSql}, updated_at=? WHERE id=? AND updated_at=?`
  ).run(opts.status, nextStatus, patientLeft, ...slaParams, now, tracking.id, tracking.updated_at);

  await logHistory({
    admissionId: opts.admissionId, trackingId: tracking.id, field: opts.step,
    oldValue, newValue: opts.status, userId: opts.userId, reason: opts.reason,
  });
  await audit(opts.userId, "discharge_step_update", String(opts.admissionId), { step: opts.step, from: oldValue, to: opts.status });

  const updated = (await getTrackingById(tracking.id))!;
  await completeIfEligible(updated, opts.userId);
  return (await getTrackingById(tracking.id))!;
}

export interface DischargeDashboardCounts {
  plannedToday: number; plannedTomorrow: number; scheduledOngoingToday: number; initiated: number;
  drugReturnPending: number; drugReturnCompleted: number;
  pharmacyPending: number; pharmacyCompleted: number;
  procedurePending: number; procedureCompleted: number;
  billingStarted: number; billingStartedCompleted: number;
  auditPending: number; auditCompleted: number;
  billReady: number; billReadyCompleted: number;
  paymentPending: number; paymentCompleted: number;
  systemCheckoutPending: number; systemCheckoutCompleted: number;
  physicalCheckoutPending: number; physicalCheckoutCompleted: number;
  completedToday: number;
  overduePlanned: number;
  /** System Checkout done, Physical Checkout not — billing/paperwork finished, patient hasn't
   *  physically left yet. Bed stays Occupied as normal; this is purely a visibility count. */
  awaitingPatientLeave: number;
  /** Initiated and at least one checklist step has been touched — distinct from
   *  `initiated`, which is only the freshly-started DISCHARGE_INITIATED status. */
  pending: number;
  /** Cancelled at any point (before or after initiation). */
  cancelled: number;
  /** Initiated today (initiated_at >= todayStart) — covers both planned-for-today
   *  that got initiated + unplanned "initiate now" used today. */
  initiatedToday: number;
  /** Initiated today but NOT scheduled for today — no plan at all, or planned for
   *  a different date (future planned but pushed early). */
  unplannedToday: number;
  /** Cancelled today specifically (updated_at >= todayStart). */
  cancelledToday: number;
  /** Patient physically left before system checkout was completed — billing risk. */
  patientLeft: number;
  /** Physical Checkout done, System Checkout still pending — patient is in the Discharge Lounge. */
  inDischargeLounge: number;
}

/** wardIds = null means hospital-wide (COO/FC); otherwise scoped to the caller's wards. */
export async function dashboardCounts(wardIds: number[] | null): Promise<DischargeDashboardCounts> {
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];

  // IST day boundaries (hospital is India-based — see existing scheduler's IST usage).
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today = nowIst.toISOString().slice(0, 10);
  const tomorrow = new Date(nowIst.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();

  const row = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE dt.status='PLANNED' AND dt.planned_date=?) AS planned_today,
      COUNT(*) FILTER (WHERE dt.status='PLANNED' AND dt.planned_date=?) AS planned_tomorrow,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.planned_date=?) AS scheduled_ongoing_today,
      COUNT(*) FILTER (WHERE dt.status='DISCHARGE_INITIATED') AS initiated,
      COUNT(*) FILTER (WHERE dt.status='IN_PROGRESS') AS pending,
      COUNT(*) FILTER (WHERE dt.status='CANCELLED') AS cancelled,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.drug_return_status='PENDING') AS drug_return_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.drug_return_status='COMPLETED') AS drug_return_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.pharmacy_clearance_status='PENDING') AS pharmacy_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.pharmacy_clearance_status='COMPLETED') AS pharmacy_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.procedure_reconciliation_status='PENDING') AS procedure_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.procedure_reconciliation_status='COMPLETED') AS procedure_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.billing_started_status='PENDING') AS billing_started,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.billing_started_status='COMPLETED') AS billing_started_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.audit_status='PENDING') AS audit_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.audit_status='COMPLETED') AS audit_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.bill_ready_status='PENDING') AS bill_ready,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.bill_ready_status='COMPLETED') AS bill_ready_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.payment_status='PENDING') AS payment_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.payment_status='COMPLETED') AS payment_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.system_checkout_status='PENDING') AS system_checkout_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.system_checkout_status='COMPLETED') AS system_checkout_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.physical_checkout_status='PENDING') AS physical_checkout_pending,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.physical_checkout_status='COMPLETED') AS physical_checkout_completed,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.system_checkout_status='COMPLETED' AND dt.physical_checkout_status<>'COMPLETED') AS awaiting_patient_leave,
      COUNT(*) FILTER (WHERE dt.status='COMPLETED' AND dt.updated_at >= ?) AS completed_today,
      COUNT(*) FILTER (WHERE dt.status='PLANNED' AND dt.planned_date < ?) AS overdue_planned,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.initiated_at >= ?) AS initiated_today,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.initiated_at >= ?
                       AND (dt.planned_date IS NULL OR dt.planned_date != ?)) AS unplanned_today,
      COUNT(*) FILTER (WHERE dt.status='CANCELLED' AND dt.updated_at >= ?) AS cancelled_today,
      COUNT(*) FILTER (WHERE dt.patient_left = TRUE AND dt.system_checkout_status != 'COMPLETED') AS patient_left,
      COUNT(*) FILTER (WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND dt.physical_checkout_status='COMPLETED' AND dt.system_checkout_status!='COMPLETED') AS in_discharge_lounge
    FROM discharge_tracking dt
    JOIN patient_admissions pa ON pa.id = dt.admission_id
    WHERE pa.status IN ('ACTIVE','DISCHARGED') ${scopeClause}
  `).get<Record<string, number>>(today, tomorrow, today, Date.now() - 24 * 60 * 60 * 1000, today, todayStartMs, todayStartMs, today, todayStartMs, ...params);

  return {
    plannedToday: Number(row?.planned_today || 0),
    plannedTomorrow: Number(row?.planned_tomorrow || 0),
    scheduledOngoingToday: Number(row?.scheduled_ongoing_today || 0),
    initiated: Number(row?.initiated || 0),
    pending: Number(row?.pending || 0),
    cancelled: Number(row?.cancelled || 0),
    drugReturnPending: Number(row?.drug_return_pending || 0),
    drugReturnCompleted: Number(row?.drug_return_completed || 0),
    pharmacyPending: Number(row?.pharmacy_pending || 0),
    pharmacyCompleted: Number(row?.pharmacy_completed || 0),
    procedurePending: Number(row?.procedure_pending || 0),
    procedureCompleted: Number(row?.procedure_completed || 0),
    billingStarted: Number(row?.billing_started || 0),
    billingStartedCompleted: Number(row?.billing_started_completed || 0),
    auditPending: Number(row?.audit_pending || 0),
    auditCompleted: Number(row?.audit_completed || 0),
    billReady: Number(row?.bill_ready || 0),
    billReadyCompleted: Number(row?.bill_ready_completed || 0),
    paymentPending: Number(row?.payment_pending || 0),
    paymentCompleted: Number(row?.payment_completed || 0),
    systemCheckoutPending: Number(row?.system_checkout_pending || 0),
    systemCheckoutCompleted: Number(row?.system_checkout_completed || 0),
    physicalCheckoutPending: Number(row?.physical_checkout_pending || 0),
    physicalCheckoutCompleted: Number(row?.physical_checkout_completed || 0),
    awaitingPatientLeave: Number(row?.awaiting_patient_leave || 0),
    completedToday: Number(row?.completed_today || 0),
    overduePlanned: Number(row?.overdue_planned || 0),
    initiatedToday: Number(row?.initiated_today || 0),
    unplannedToday: Number(row?.unplanned_today || 0),
    cancelledToday: Number(row?.cancelled_today || 0),
    patientLeft: Number(row?.patient_left || 0),
    inDischargeLounge: Number(row?.in_discharge_lounge || 0),
  };
}

const DISCHARGE_LIST_SELECT = `
  SELECT dt.*, pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6,
         bd.bed_name, w.name AS ward_name
  FROM discharge_tracking dt
  JOIN patient_admissions pa ON pa.id = dt.admission_id
  JOIN bed_details bd ON bd.id = pa.bed_id
  JOIN wards w ON w.id = pa.ward_id
`;

export async function listCancelledToday(wardIds: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.status='CANCELLED' AND dt.updated_at >= ? ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(todayStartMs, ...params);
}

export async function listAdmittedToday(wardIds: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStart = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const todayEnd = todayStart + 24 * 60 * 60 * 1000;
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];
  return db.prepare(`
    SELECT pa.id AS admission_id, pa.bed_id, pa.ward_id, pa.ip_last6, pa.admitted_at,
           bd.bed_name, w.name AS ward_name
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    WHERE pa.admitted_at >= ? AND pa.admitted_at < ? ${scopeClause}
    ORDER BY pa.admitted_at DESC
  `).all(todayStart, todayEnd, ...params);
}

export async function listCompletedToday(wardIds: number[] | null) {
  const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayStartMs = new Date(nowIst.toISOString().slice(0, 10) + "T00:00:00+05:30").getTime();
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.status='COMPLETED' AND dt.updated_at >= ?
     AND pa.status='DISCHARGED' ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(todayStartMs, ...params);
}

export async function listPatientLeft(wardIds: number[] | null) {
  const scopeClause = wardIds ? "AND pa.ward_id = ANY(?)" : "";
  const params: unknown[] = wardIds ? [wardIds] : [];
  return db.prepare(
    `${DISCHARGE_LIST_SELECT} WHERE dt.patient_left = TRUE AND dt.system_checkout_status != 'COMPLETED'
     AND pa.status IN ('ACTIVE','DISCHARGED') ${scopeClause} ORDER BY dt.updated_at DESC`
  ).all(...params);
}

export async function historyForAdmission(admissionId: number) {
  const discharge = await db.prepare(
    `SELECT dh.*, u.name AS changed_by_name
     FROM discharge_history dh LEFT JOIN users u ON u.id = dh.changed_by
     WHERE dh.admission_id=? ORDER BY dh.changed_at DESC`
  ).all(admissionId);
  const transfers = await db.prepare(
    `SELECT bth.*, u.name AS transferred_by_name,
            fb.bed_name AS from_bed_name, tb.bed_name AS to_bed_name,
            fw.name AS from_ward_name, tw.name AS to_ward_name
     FROM bed_transfer_history bth
     LEFT JOIN users u ON u.id = bth.transferred_by
     LEFT JOIN bed_details fb ON fb.id = bth.from_bed_id
     LEFT JOIN bed_details tb ON tb.id = bth.to_bed_id
     LEFT JOIN wards fw ON fw.id = bth.from_ward_id
     LEFT JOIN wards tw ON tw.id = bth.to_ward_id
     WHERE bth.admission_id=? ORDER BY bth.transferred_at DESC`
  ).all(admissionId);
  return { discharge, transfers };
}
