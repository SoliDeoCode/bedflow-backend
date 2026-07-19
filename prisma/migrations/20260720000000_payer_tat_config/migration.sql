-- Update default step SLAs to match the clinical discharge timeline:
-- DS (Discharge Summary doc): 5 min
-- DR (Drug Return): 5 min
-- PR (Procedure Reconciliation / OT/Cath): 15 min
-- BL (Billing Started / Bill Prep): 15 min
-- BR (Bill Ready / Bill Finalisation): 5 min default
-- PY (Payment): 60 min
-- PX (Physical Checkout): 60 min
-- SC (System Checkout): stays at 5 min ("Immediate" for most payers)
UPDATE discharge_phase_config SET expected_minutes = 5  WHERE phase_key = 'DISCHARGE_DOC';
UPDATE discharge_phase_config SET expected_minutes = 5  WHERE phase_key = 'DRUG_RETURN';
UPDATE discharge_phase_config SET expected_minutes = 15 WHERE phase_key = 'PROCEDURE_RECONCILIATION';
UPDATE discharge_phase_config SET expected_minutes = 15 WHERE phase_key = 'BILLING_STARTED';
UPDATE discharge_phase_config SET expected_minutes = 5  WHERE phase_key = 'BILL_READY';
UPDATE discharge_phase_config SET expected_minutes = 60 WHERE phase_key = 'PAYMENT';
UPDATE discharge_phase_config SET expected_minutes = 60 WHERE phase_key = 'PHYSICAL_CHECKOUT';

-- Payer-type TAT configuration.
-- phase_key IS NULL     → overall discharge TAT benchmark (reporting only — colours the TAT Leaderboard)
-- phase_key IS NOT NULL → step-level SLA override (affects DELAYED detection on discharge cards)
CREATE TABLE payer_tat_config (
  id             SERIAL       PRIMARY KEY,
  payer_type     VARCHAR(100) NOT NULL,
  phase_key      VARCHAR(50),
  target_minutes INTEGER      NOT NULL,
  created_at     BIGINT       NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
  updated_at     BIGINT       NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
);

CREATE UNIQUE INDEX uq_payer_tat_overall ON payer_tat_config(payer_type) WHERE phase_key IS NULL;
CREATE UNIQUE INDEX uq_payer_tat_step    ON payer_tat_config(payer_type, phase_key) WHERE phase_key IS NOT NULL;

-- Overall TAT benchmarks
INSERT INTO payer_tat_config (payer_type, phase_key, target_minutes) VALUES
  ('Cash',       NULL, 180),
  ('General',    NULL, 180),
  ('Insurance',  NULL, 300),
  ('Corporate',  NULL, 210),
  ('Arogya Sri', NULL, 210);

-- Step-level SLA overrides: Bill Ready and System Checkout differ for Corporate/Insurance
INSERT INTO payer_tat_config (payer_type, phase_key, target_minutes) VALUES
  ('Corporate', 'BILL_READY',      30),
  ('Insurance', 'BILL_READY',      45),
  ('Insurance', 'SYSTEM_CHECKOUT', 300);
