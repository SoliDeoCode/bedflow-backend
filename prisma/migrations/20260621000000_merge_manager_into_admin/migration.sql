-- ── Merge the MANAGER role into COO (presented as "Admin" in the UI) ─────────
-- The system no longer has a separate Manager role. Former Manager accounts
-- become Admin (COO) accounts — usernames, passwords, assignments, and audit
-- history are all preserved (only the role label changes).

-- 1. Convert every existing MANAGER account into a COO (Admin) account.
UPDATE users SET role = 'COO' WHERE role = 'MANAGER';

-- 2. Tighten the role CHECK so MANAGER can never be created again.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PRE','COO','NURSE'));
