-- Payer types: manager-configurable list
CREATE TABLE IF NOT EXISTS payer_types (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  sort_order INTEGER      NOT NULL DEFAULT 0,
  active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at BIGINT       NOT NULL
);

-- Seed default payer types
INSERT INTO payer_types (name, sort_order, active, created_at) VALUES
  ('Cash',                  1, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('Insurance / TPA',       2, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('Corporate',             3, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000),
  ('Arogyasri / EHS / AB',  4, TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (name) DO NOTHING;

-- Add payer_type to bed_details (null = bed is vacant / no patient)
ALTER TABLE bed_details  ADD COLUMN IF NOT EXISTS payer_type VARCHAR(100) NULL;

-- Add payer_type to bed_movements so history preserves what payer was active
ALTER TABLE bed_movements ADD COLUMN IF NOT EXISTS payer_type VARCHAR(100) NULL;
