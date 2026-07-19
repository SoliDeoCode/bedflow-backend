-- Allow the CONSULTANT role — named consultants who log in to the
-- consultant portal to view patients and complete Doctor Summary.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role::text = ANY (ARRAY['PRE','COO','NURSE','DOCTOR','FC','CONSULTANT']::text[]));
