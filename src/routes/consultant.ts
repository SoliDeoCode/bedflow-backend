import { Router } from "express";
import { authRequired, requireRole } from "../middleware/auth.js";
import { asyncH } from "../middleware/error.js";
import { allWardsLive, allBedDetailsLive, adminDashboard } from "../services/bedService.js";
import { listPayerTypes } from "../services/payerTypeService.js";
import { db } from "../db/index.js";

const router = Router();
router.use(authRequired, requireRole("CONSULTANT"));

// ── Dashboard mirrors COO dashboard (read-only, no unit-type restriction) ─────

router.get("/live-wards", asyncH(async (_req, res) => {
  res.json(await allWardsLive());
}));

router.get("/bed-details", asyncH(async (_req, res) => {
  res.json(await allBedDetailsLive());
}));

router.get("/admin-dashboard", asyncH(async (req, res) => {
  const unit = typeof req.query.unit === "string" ? req.query.unit : null;
  res.json(await adminDashboard(unit));
}));

router.get("/payer-types", asyncH(async (_req, res) => {
  res.json({ payerTypes: await listPayerTypes(true) });
}));

// ── My Wards: wards where this consultant has active patients ────────────────

router.get("/my-wards", asyncH(async (req, res) => {
  const consultantName = req.user!.name;

  const rows = await db.prepare(
    `SELECT
       w.id, w.name, w.unit_type, w.bed_type, w.total_beds,
       COUNT(bd.id)::int AS my_beds
     FROM wards w
     JOIN bed_details bd ON bd.ward_id = w.id
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     WHERE pa.consultant_name = $1
       AND w.operational = true
     GROUP BY w.id, w.name, w.unit_type, w.bed_type, w.total_beds
     ORDER BY w.name`
  ).all<Record<string, unknown>>(consultantName);

  res.json({ wards: rows });
}));

// ── Beds for a ward: only the consultant's active patient beds ───────────────

router.get("/beds/:wardId", asyncH(async (req, res) => {
  const consultantName = req.user!.name;
  const wardId = Number(req.params.wardId);

  const rows = await db.prepare(
    `SELECT
       bd.id, bd.ward_id, bd.bed_name, bd.physical_status, bd.reservation_status,
       bd.bed_type, bd.operational_status, bd.payer_type, bd.destination, bd.reservation_note,
       bd.updated_at, row_to_json(dt.*) AS discharge_tracking,
       pa.ip_last6, pa.admission_type, pa.consultant_name, pa.department_name,
       pa.doctor_id, pa.department_id
     FROM bed_details bd
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE bd.ward_id = $1
       AND pa.consultant_name = $2
     ORDER BY
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<Record<string, unknown>>(wardId, consultantName);

  res.json({ beds: rows });
}));

// ── My Patients: active beds where this consultant is attached ────────────────

router.get("/my-patients", asyncH(async (req, res) => {
  const consultantName = req.user!.name;

  const rows = await db.prepare(
    `SELECT
       bd.id          AS bed_id,
       bd.bed_name,
       bd.ward_id,
       w.name         AS ward_name,
       bd.physical_status,
       bd.reservation_status,
       pa.consultant_name,
       pa.department_name,
       pa.ip_last6,
       pa.admission_type,
       bd.payer_type,
       pa.admitted_at,
       row_to_json(dt.*) AS discharge_tracking
     FROM bed_details bd
     JOIN wards w ON w.id = bd.ward_id
     JOIN patient_admissions pa ON pa.bed_id = bd.id AND pa.status = 'ACTIVE'
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE pa.consultant_name = $1
       AND w.operational = true
     ORDER BY w.name,
       substring(bd.bed_name from '^[^0-9]*') ASC,
       NULLIF(substring(bd.bed_name from '[0-9]+'), '')::bigint NULLS LAST,
       bd.bed_name ASC`
  ).all<Record<string, unknown>>(consultantName);

  res.json({ patients: rows });
}));

// ── My Discharges: completed discharges for this consultant ──────────────────

router.get("/my-discharges", asyncH(async (req, res) => {
  const consultantName = req.user!.name;
  const from  = typeof req.query.from  === "string" ? Number(req.query.from)  : null;
  const to    = typeof req.query.to    === "string" ? Number(req.query.to)    : null;
  const limit = Math.min(Number(req.query.limit) || 100, 200);

  const rows = await db.prepare(
    `SELECT
       bd.id          AS bed_id,
       bd.bed_name,
       bd.ward_id,
       w.name         AS ward_name,
       pa.consultant_name,
       pa.department_name,
       pa.ip_last6,
       pa.admission_type,
       bd.payer_type,
       pa.admitted_at,
       pa.discharged_at,
       row_to_json(dt.*) AS discharge_tracking
     FROM patient_admissions pa
     JOIN bed_details bd ON bd.id = pa.bed_id
     JOIN wards w ON w.id = bd.ward_id
     LEFT JOIN discharge_tracking dt ON dt.admission_id = pa.id
     WHERE pa.consultant_name = $1
       AND pa.status = 'DISCHARGED'
       ${from ? "AND pa.updated_at >= $2" : ""}
       ${to   ? `AND pa.updated_at <= ${from ? "$3" : "$2"}` : ""}
     ORDER BY pa.updated_at DESC
     LIMIT ${limit}`
  ).all<Record<string, unknown>>(
    ...[consultantName, ...(from ? [from] : []), ...(to ? [to] : [])]
  );

  res.json({ discharges: rows });
}));

export default router;
