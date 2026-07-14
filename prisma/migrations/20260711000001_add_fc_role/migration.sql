-- Allow the new FC (Finance Coordinator) role — owns Bill Ready + Payment in the
-- discharge workflow. Existing roles are unaffected.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role::text = ANY (ARRAY['PRE','COO','NURSE','DOCTOR','FC']::text[]));
