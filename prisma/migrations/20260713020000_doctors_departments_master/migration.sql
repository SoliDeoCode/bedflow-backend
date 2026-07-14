-- Master tables for departments and doctors (many-to-many).
-- Replaces the free-text consultant_name / department_name fields with proper
-- lookup-backed dropdowns. Old text columns remain for backward compat.

CREATE TABLE IF NOT EXISTS departments (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL UNIQUE,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS doctors_master (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(150) NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS doctor_departments (
  id            SERIAL PRIMARY KEY,
  doctor_id     INTEGER NOT NULL REFERENCES doctors_master(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  UNIQUE(doctor_id, department_id)
);

-- Link columns on patient_admissions — nullable so old rows stay valid.
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id);
ALTER TABLE patient_admissions ADD COLUMN IF NOT EXISTS doctor_id INTEGER REFERENCES doctors_master(id);
