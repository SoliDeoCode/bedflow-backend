-- Consultant Groups: lets a patient be admitted under either one individual
-- consultant (existing model, unchanged) OR a named group of 2+ consultants
-- (e.g. "Vijay / Kumari"), so joint-admission patients are visible/actionable
-- to every member of the group instead of only one doctor.

CREATE TABLE IF NOT EXISTS consultant_groups (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(150) NOT NULL UNIQUE,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS consultant_group_members (
  id        SERIAL PRIMARY KEY,
  group_id  INTEGER NOT NULL REFERENCES consultant_groups(id) ON DELETE CASCADE,
  doctor_id INTEGER NOT NULL REFERENCES doctors_master(id) ON DELETE CASCADE,
  UNIQUE(group_id, doctor_id)
);

CREATE TABLE IF NOT EXISTS consultant_group_departments (
  id            SERIAL PRIMARY KEY,
  group_id      INTEGER NOT NULL REFERENCES consultant_groups(id) ON DELETE CASCADE,
  department_id INTEGER NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  UNIQUE(group_id, department_id)
);

-- Every existing row already has doctor_id set, so owner_type defaults to
-- 'DOCTOR' and the CHECK below is satisfied automatically with zero backfill.
ALTER TABLE patient_admissions
  ADD COLUMN IF NOT EXISTS owner_type VARCHAR(10) NOT NULL DEFAULT 'DOCTOR',
  ADD COLUMN IF NOT EXISTS consultant_group_id INTEGER REFERENCES consultant_groups(id);

ALTER TABLE patient_admissions
  DROP CONSTRAINT IF EXISTS chk_admission_owner_type;
ALTER TABLE patient_admissions
  ADD CONSTRAINT chk_admission_owner_type CHECK (owner_type IN ('DOCTOR','GROUP'));

-- NOT VALID: 181 pre-existing admissions predate the doctor_id FK migration and
-- have doctor_id IS NULL with no consultant on record at all — legitimate legacy
-- data, not something to backfill/guess. NOT VALID enforces this constraint for
-- every new/updated row going forward without requiring historical rows to
-- already comply (standard Postgres pattern for adding constraints to populated
-- tables — no backfill, no downtime).
ALTER TABLE patient_admissions
  DROP CONSTRAINT IF EXISTS chk_admission_owner;
ALTER TABLE patient_admissions
  ADD CONSTRAINT chk_admission_owner CHECK (
    (owner_type = 'DOCTOR' AND consultant_group_id IS NULL) OR
    (owner_type = 'GROUP'  AND consultant_group_id IS NOT NULL AND doctor_id IS NULL)
  ) NOT VALID;

-- Turns today's fragile CONSULTANT-login <-> doctors_master link (exact name
-- string match, see manager.ts consultant-logins section) into a real FK,
-- without touching login/auth flow — POST /consultant-logins already resolves
-- doctor_master_id at creation time, this just also stores it going forward.
ALTER TABLE users ADD COLUMN IF NOT EXISTS doctor_master_id INTEGER REFERENCES doctors_master(id);

-- One-time backfill for existing consultant logins, reusing the same name-match
-- convention the app already relies on today (no manual recreation needed).
UPDATE users u SET doctor_master_id = dm.id
  FROM doctors_master dm
  WHERE u.role = 'CONSULTANT' AND u.name = dm.name AND u.doctor_master_id IS NULL;
