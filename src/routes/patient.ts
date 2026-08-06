import { Router } from "express";
import { z } from "zod";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import { createComplaint, complaintsForPatient, listCategories } from "../services/complaintService.js";
import {
  listPhaseConfig, computeWorkflow, ALL_STEPS, STEP_GROUP,
  statusCol, startedCol, completedCol,
} from "../services/dischargeSlaService.js";

const router = Router();

const PHASE_COLUMNS = ALL_STEPS
  .flatMap(k => [statusCol(k), startedCol(k), completedCol(k)])
  .map(c => `dt.${c}`)
  .join(",\n      ");

// Grace window after full discharge (both checkouts complete) during which the
// portal can still show the "You're All Set!" goodbye card. Without this, the
// same event that completes both checkouts also closes the admission
// (completeIfEligible in dischargeService.ts, same request) — so the very
// next status fetch (the socket-triggered "discharge:refresh" fires right
// after) would find pa.status='DISCHARGED' and, under the old ACTIVE-only
// filter, return found:false — logging the patient out before they ever saw
// the goodbye message. Matching on a recently-DISCHARGED admission too closes
// that race, and naturally expires access after a day either way.
const DISCHARGED_GRACE_MS = 24 * 60 * 60 * 1000;

router.get("/status", asyncH(async (req, res) => {
  const ip = (req.query.ip as string | undefined)?.trim();
  if (!ip || !/^\d{6}$/.test(ip))
    return res.json({ found: false, reason: "Enter your 6-digit patient number." });

  const dischargedSinceMs = Date.now() - DISCHARGED_GRACE_MS;

  // A patient number can have more than one patient_admissions row (a past,
  // already-DISCHARGED visit plus a new current one) — pick the single most
  // recent admission FIRST, then decide whether to show/block/grace-window
  // it. Filtering row-by-row in the WHERE clause (the old approach) let a
  // blocked *current* admission (e.g. in the Discharge Lounge) silently fall
  // through to an older, unrelated DISCHARGED admission that happened to
  // still satisfy the grace window — leaking that old visit's bed/ward info
  // instead of correctly blocking. Never fall back across admissions.
  const row = await db.prepare(`
    WITH latest_admission AS (
      SELECT id FROM patient_admissions WHERE ip_last6 = ? ORDER BY admitted_at DESC LIMIT 1
    )
    SELECT
      pa.id AS admission_id,
      pa.ip_last6,
      pa.admitted_at,
      pa.status                        AS admission_status,
      pa.discharged_at,
      bd.bed_name,
      w.name AS ward_name,
      dt.id                            AS tracking_id,
      dt.status                        AS discharge_status,
      dt.planned_date,
      dt.planned_time,
      dt.initiated_at,
      dt.system_checkout_status,
      dt.physical_checkout_status,
      wbed.is_discharge_lounge         AS bed_in_lounge,
      ${PHASE_COLUMNS}
    FROM latest_admission la
    JOIN patient_admissions pa ON pa.id = la.id
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    -- Resolved via the BED's ward, not pa.ward_id: the bed is where the patient
    -- physically is. moveAdmission keeps the two in sync, so this is belt-and-
    -- braces, but it's the column the lounge gate below turns on.
    JOIN wards wbed ON wbed.id = bd.ward_id
    LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
  `).get<Record<string, unknown>>(ip);

  if (!row) return res.json({ found: false, reason: "No active admission found for this patient number." });

  const scStatus = row.system_checkout_status as string | null;
  const pcStatus = row.physical_checkout_status as string | null;
  const admissionStatus = row.admission_status as string;
  // The patient is in the lounge iff their bed sits in the ward flagged
  // is_discharge_lounge. This used to be inferred as
  // `pc === "COMPLETED" && sc !== "COMPLETED"`, which is a proxy for the
  // workflow state, not for where the patient actually is — and the two come
  // apart in both directions:
  //   • cancelAfterInitiation → resetAndCancelTracking resets BOTH checkout
  //     columns to PENDING without moving anyone off the lounge bed. Since
  //     readmitFromLounge refuses to run until the discharge is cancelled,
  //     every readmit passes through that state — the portal opened for a
  //     patient sitting in the lounge and showed them ward_name
  //     "Discharge Lounge".
  //   • a bed manually flipped Vacant→Occupied on a lounge ward creates an
  //     admission with no discharge_tracking row at all, so the LEFT JOIN
  //     above leaves both columns NULL and the proxy reads false.
  // Truthy rather than === true: the flag arrives as a driver-dependent
  // boolean, matching how dischargeService reads it.
  const inLounge = !!row.bed_in_lounge;
  const fullyComplete = scStatus === "COMPLETED" && pcStatus === "COMPLETED";

  if (admissionStatus === "ACTIVE" && inLounge) {
    // code lets the frontend show this in the patient's selected language
    // (i18n.js's loungeBlockedNotice) — reason is the English fallback for
    // any client that doesn't know about the code.
    return res.json({
      found: false, code: "LOUNGE_BLOCKED",
      reason: "This page is temporarily paused while your care team finishes up. It'll be back shortly.",
    });
  }
  if (admissionStatus === "DISCHARGED") {
    // Only a genuine two-checkout completion earns the goodbye-card grace
    // window — an admission closed some other way (e.g. cancelled/manually
    // vacated) has nothing to show and must not resurrect old bed/ward info.
    const dischargedAt = Number(row.discharged_at ?? 0);
    if (!fullyComplete || !dischargedAt || dischargedAt < dischargedSinceMs) {
      return res.json({ found: false, reason: "No active admission found for this patient number." });
    }
  } else if (admissionStatus !== "ACTIVE") {
    return res.json({ found: false, reason: "No active admission found for this patient number." });
  }

  const config = await listPhaseConfig();
  const wf = computeWorkflow({ ...row, status: row.discharge_status } as never, config);

  // Critical-path expected time — mirrors computeWorkflow's expectedTime.
  // Group 2 has a parallel fan-out (Drug Return → PHC + PR in parallel),
  // and group 3 is serial after group 2 (Bill Prep waits on PHC+PR).
  let totalExpectedMinutes: number | null = null;
  let expectedEta: number | null = null;
  if (wf) {
    const tat = (key: string) => {
      const p = wf.phases.find(ph => ph.key === key);
      return p && p.state !== "NOT_APPLICABLE" ? p.expectedMinutes : 0;
    };
    const g1 = tat("DISCHARGE_INITIATION") + tat("DISCHARGE_DOC");
    const g2 = tat("DRUG_RETURN") + Math.max(tat("PHARMACY_CLEARANCE"), tat("PROCEDURE_RECONCILIATION"));
    const g3 = tat("BILLING_STARTED") + tat("AUDIT") + tat("BILL_READY") + tat("PAYMENT");
    const g4 = tat("SYSTEM_CHECKOUT");
    const g5 = tat("PHYSICAL_CHECKOUT");
    totalExpectedMinutes = Math.max(g1, g2 + g3) + g4 + g5;
    const init = Number(row.initiated_at);
    if (init > 0) expectedEta = init + totalExpectedMinutes * 60_000;
  }

  const workflow = wf && {
    state: wf.state,
    eta: wf.eta,
    etaMinutes: wf.etaMinutes,
    done: wf.done,
    total: wf.total,
    pct: wf.pct,
    totalExpectedMinutes,
    expectedEta,
    phases: wf.phases.map(p => ({
      key: p.key,
      label: p.label,
      department: p.department,
      state: p.state === "DELAYED" ? "IN_PROGRESS" : p.state,
      onTime: p.state !== "DELAYED",
      expectedMinutes: p.expectedMinutes,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
    })),
  };

  res.json({ found: true, data: row, workflow });
}));

/* ── Contact Support (complaints) ──────────────────────────────────────────
   These are UNAUTHENTICATED, exactly like /status above — the portal knows a
   patient only by their 6-digit IP number. That shapes what's allowed here:

     • create + read-own only. No edit, no delete, no close, no priority, no
       reassignment — every one of those is PWO-only and lives in routes/pwo.ts.
     • only ACTIVE admissions can file (enforced in createComplaint), so portal
       access ends at discharge while the complaints themselves live on in the
       PWO system forever.
     • the read path returns only notes a PWO explicitly shared, and never the
       owning officer's identity.

   Abuse control is the 5-minute-per-admission cooldown in the service plus the
   shared /api rate limiter — a stricter identity check isn't possible today
   because BedFlow stores no patient name to verify against.                  */

router.get("/complaints", asyncH(async (req, res) => {
  const ip = (req.query.ip as string | undefined)?.trim();
  if (!ip || !/^\d{6}$/.test(ip))
    return res.json({ found: false, complaints: [] });
  res.json({ found: true, complaints: await complaintsForPatient(ip) });
}));

router.get("/complaint-categories", asyncH(async (_req, res) => {
  res.json({ categories: await listCategories() });
}));

router.post("/complaints", asyncH(async (req, res) => {
  const { ip, category, description } = z.object({
    ip:          z.string().regex(/^\d{6}$/, "Enter your 6-digit patient number."),
    category:    z.string().min(1).max(40),
    description: z.string().min(1).max(4000),
  }).parse(req.body);

  const complaint = await createComplaint({ ipLast6: ip, categoryCode: category, description });
  // Mirror what the patient may see — never the owning officer.
  res.status(201).json({
    complaint: {
      id: complaint.id,
      complaintCode: complaint.complaintCode,
      status: complaint.status,
      category: complaint.category,
      description: complaint.description,
      createdAt: complaint.createdAt,
    },
  });
}));

export default router;
