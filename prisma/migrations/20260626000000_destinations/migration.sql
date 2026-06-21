-- Destinations: admin-configurable list of where a patient is sent while a bed
-- is held OCCUPIED+RESERVED (e.g. OT, Scanning). Mirrors payer_types exactly.
CREATE TABLE IF NOT EXISTS destinations (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at BIGINT       NOT NULL
);

-- Seed common defaults — admin can add/rename/remove from there
INSERT INTO destinations (name, sort_order, active, created_at) VALUES
  ('OT',       1, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('Scanning', 2, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (name) DO NOTHING;

-- Add destination to bed_details (null = not currently OCC+RES)
ALTER TABLE bed_details  ADD COLUMN IF NOT EXISTS destination VARCHAR(100) NULL;

-- Add destination to bed_movements so history preserves where the patient was
-- sent, even after the bed returns to OCCUPIED or goes VACANT.
ALTER TABLE bed_movements ADD COLUMN IF NOT EXISTS destination VARCHAR(100) NULL;
