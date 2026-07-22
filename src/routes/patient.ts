import { Router } from "express";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import {
  listPhaseConfig, computeWorkflow, ALL_STEPS, STEP_GROUP,
  statusCol, startedCol, completedCol,
} from "../services/dischargeSlaService.js";

const router = Router();

const PHASE_COLUMNS = ALL_STEPS
  .flatMap(k => [statusCol(k), startedCol(k), completedCol(k)])
  .map(c => `dt.${c}`)
  .join(",\n      ");

router.get("/status", asyncH(async (req, res) => {
  const ip = (req.query.ip as string | undefined)?.trim();
  if (!ip || !/^\d{6}$/.test(ip))
    return res.json({ found: false, reason: "Enter your 6-digit patient number." });

  const row = await db.prepare(`
    SELECT
      pa.id AS admission_id,
      pa.ip_last6,
      pa.admitted_at,
      bd.bed_name,
      w.name AS ward_name,
      dt.id                            AS tracking_id,
      dt.status                        AS discharge_status,
      dt.planned_date,
      dt.planned_time,
      dt.initiated_at,
      dt.system_checkout_status,
      dt.physical_checkout_status,
      ${PHASE_COLUMNS}
    FROM patient_admissions pa
    JOIN bed_details bd ON bd.id = pa.bed_id
    JOIN wards w ON w.id = pa.ward_id
    LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
    WHERE pa.ip_last6 = ? AND pa.status = 'ACTIVE'
    ORDER BY pa.admitted_at DESC
    LIMIT 1
  `).get<Record<string, unknown>>(ip);

  if (!row) return res.json({ found: false, reason: "No active admission found for this patient number." });

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

export default router;
