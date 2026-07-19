-- Discharge SLA / ETA layer.
--
-- Keeps the existing 10 fixed phases (one *_status column each) and the parallel
-- group model untouched. Adds only what delay-detection and ETA need:
--   1. per-phase started_at / completed_at timestamps
--   2. a COO-editable expected duration (the hospital SLA) per phase
--
-- Phase ownership stays role-based in dischargeService.STEP_PERMISSIONS —
-- `department` here is a display label for the COO screen, not a permission.

-- ── 1. Per-phase timestamps ──────────────────────────────────────────────────
ALTER TABLE discharge_tracking
  ADD COLUMN IF NOT EXISTS discharge_summary_started_at           BIGINT,
  ADD COLUMN IF NOT EXISTS discharge_summary_completed_at         BIGINT,
  ADD COLUMN IF NOT EXISTS drug_return_started_at                 BIGINT,
  ADD COLUMN IF NOT EXISTS drug_return_completed_at               BIGINT,
  ADD COLUMN IF NOT EXISTS pharmacy_clearance_started_at          BIGINT,
  ADD COLUMN IF NOT EXISTS pharmacy_clearance_completed_at        BIGINT,
  ADD COLUMN IF NOT EXISTS procedure_reconciliation_started_at    BIGINT,
  ADD COLUMN IF NOT EXISTS procedure_reconciliation_completed_at  BIGINT,
  ADD COLUMN IF NOT EXISTS billing_started_started_at             BIGINT,
  ADD COLUMN IF NOT EXISTS billing_started_completed_at           BIGINT,
  ADD COLUMN IF NOT EXISTS audit_started_at                       BIGINT,
  ADD COLUMN IF NOT EXISTS audit_completed_at                     BIGINT,
  ADD COLUMN IF NOT EXISTS bill_ready_started_at                  BIGINT,
  ADD COLUMN IF NOT EXISTS bill_ready_completed_at                BIGINT,
  ADD COLUMN IF NOT EXISTS payment_started_at                     BIGINT,
  ADD COLUMN IF NOT EXISTS payment_completed_at                   BIGINT,
  ADD COLUMN IF NOT EXISTS system_checkout_started_at             BIGINT,
  ADD COLUMN IF NOT EXISTS system_checkout_completed_at           BIGINT,
  ADD COLUMN IF NOT EXISTS physical_checkout_started_at           BIGINT,
  ADD COLUMN IF NOT EXISTS physical_checkout_completed_at         BIGINT;

-- ── 2. COO-configured SLA per phase ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS discharge_phase_config (
  id               SERIAL       PRIMARY KEY,
  phase_key        VARCHAR(50)  NOT NULL UNIQUE,
  label            VARCHAR(100) NOT NULL,
  department       VARCHAR(100),
  expected_minutes INTEGER      NOT NULL DEFAULT 15 CHECK (expected_minutes >= 0),
  sort_order       INTEGER      NOT NULL DEFAULT 0,
  created_at       BIGINT       NOT NULL,
  updated_at       BIGINT       NOT NULL
);

-- Seed the 10 existing phases. Durations are starting SLAs the COO can change.
INSERT INTO discharge_phase_config (phase_key, label, department, expected_minutes, sort_order, created_at, updated_at)
VALUES
  ('DISCHARGE_SUMMARY',        'Discharge Summary',        'Doctor',    20, 1, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('DRUG_RETURN',              'Drug Return',              'Nursing',   15, 2, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('PHARMACY_CLEARANCE',       'Pharmacy Clearance',       'Pharmacy',  15, 3, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('PROCEDURE_RECONCILIATION', 'Procedure Reconciliation', 'PRE',       10, 4, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('BILLING_STARTED',          'Billing Started',          'Billing',   10, 5, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('AUDIT',                    'Audit',                    'Billing',   10, 6, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('BILL_READY',               'Bill Ready',               'Finance',   10, 7, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('PAYMENT',                  'Payment',                  'Finance',   10, 8, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('SYSTEM_CHECKOUT',          'System Checkout',          'PRE',        5, 9, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint),
  ('PHYSICAL_CHECKOUT',        'Physical Checkout',        'Nursing',    5, 10, (EXTRACT(EPOCH FROM now())*1000)::bigint, (EXTRACT(EPOCH FROM now())*1000)::bigint)
ON CONFLICT (phase_key) DO NOTHING;

-- ── 3. Backfill: running discharges get their open phases started now ────────
-- Without this, discharges already in flight would show no start time and would
-- be computed as instantly delayed once the SLA layer goes live.
UPDATE discharge_tracking
SET discharge_summary_started_at = COALESCE(discharge_summary_started_at, initiated_at, created_at),
    drug_return_started_at       = COALESCE(drug_return_started_at,       initiated_at, created_at),
    billing_started_started_at   = COALESCE(billing_started_started_at,   initiated_at, created_at),
    physical_checkout_started_at = COALESCE(physical_checkout_started_at, initiated_at, created_at)
WHERE status IN ('DISCHARGE_INITIATED', 'IN_PROGRESS');
