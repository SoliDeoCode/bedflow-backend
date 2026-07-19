import { Router } from "express";
import { asyncH } from "../middleware/error.js";
import { db } from "../db/index.js";
import {
  listPhaseConfig, computeWorkflow, ALL_STEPS,
  statusCol, startedCol, completedCol,
} from "../services/dischargeSlaService.js";

const router = Router();

// Every phase column the SLA engine needs, built from the step list so adding a
// phase never means editing this SELECT by hand.
const PHASE_COLUMNS = ALL_STEPS
  .flatMap(k => [statusCol(k), startedCol(k), completedCol(k)])
  .map(c => `dt.${c}`)
  .join(",\n      ");

/** Public — no auth. Patient looks up their discharge status by their 6-digit IP number.
 *  Returns only their own data; no ward/bed details that identify others. */
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

  // The patient sees the same backend-computed ETA every staff role sees. Phase
  // internals are trimmed to what's meaningful to them: what's happening now,
  // who is doing it, and when it should be done — no deadlines or overdue
  // counters, which would read as blame rather than information.
  const config = await listPhaseConfig();
  const wf = computeWorkflow({ ...row, status: row.discharge_status } as never, config);

  const workflow = wf && {
    state: wf.state,
    eta: wf.eta,
    etaMinutes: wf.etaMinutes,
    done: wf.done,
    total: wf.total,
    pct: wf.pct,
    phases: wf.phases.map(p => ({
      key: p.key,
      label: p.label,
      department: p.department,
      state: p.state === "DELAYED" ? "IN_PROGRESS" : p.state,
      startedAt: p.startedAt,
      completedAt: p.completedAt,
    })),
  };

  res.json({ found: true, data: row, workflow });
}));

export default router;
