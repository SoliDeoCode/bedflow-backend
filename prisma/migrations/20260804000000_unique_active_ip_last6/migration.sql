-- DB-level backstop for "one ACTIVE admission per IP number", mirroring the
-- existing uq_patient_admissions_active_bed pattern (one ACTIVE admission per
-- bed) from 20260711000000_discharge_module. Until now this invariant was only
-- checked in application code (createAdmission / updateActiveAdmission), which
-- is bypassable by a concurrent request race or by any future write path that
-- forgets the check.
--
-- Partial + WHERE ip_last6 IS NOT NULL because ip_last6 is nullable (pre-existing
-- occupants backfilled before the discharge module existed, see
-- 20260711000002_backfill_admissions) — Postgres already treats NULLs as
-- distinct in a unique index, but the explicit filter makes the intent clear.
--
-- Because it's scoped to status='ACTIVE', a discharged admission's IP (status
-- flips to 'DISCHARGED' only once dischargeService.ts's completeIfEligible()/
-- handleManualVacate() actually closes it — not at any earlier discharge step)
-- drops out of the index automatically, so the same IP can be freely reused on
-- readmission.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_admissions_active_ip
  ON patient_admissions(ip_last6)
  WHERE status = 'ACTIVE' AND ip_last6 IS NOT NULL;
