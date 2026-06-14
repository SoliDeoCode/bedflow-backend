-- Nurse profile fields: optional contact info, independent of station assignment.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_id VARCHAR(50),
  ADD COLUMN IF NOT EXISTS phone       VARCHAR(30),
  ADD COLUMN IF NOT EXISTS email       VARCHAR(120);
