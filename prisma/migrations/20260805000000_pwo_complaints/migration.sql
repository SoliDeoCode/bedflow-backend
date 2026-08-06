-- Patient Welfare Officer (PWO) complaint-management module.
--
-- Scope note: deliberately single-hospital. There is no hospitals table and no
-- hospital_id column anywhere here — BedFlow's hierarchy is building_blocks →
-- floors → wards for one hospital, and multi-tenancy is a future requirement.
-- Adding it later is a new table + a nullable FK on complaints/users + a
-- backfill, none of which needs any of the structures below to change shape.

-- ── 1. PWO role ─────────────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role::text = ANY (ARRAY[
    'PRE','COO','NURSE','DOCTOR','FC','CONSULTANT',
    'PHARMACY','MASTER_PHARMACY','MASTER_FC','PWO'
  ]::text[]));

-- ── 2. Lookup tables ────────────────────────────────────────────────────────
-- Normalized rather than inline enums so categories/priorities can be added or
-- retired from Setup later without a migration, and so reporting can GROUP BY
-- a stable integer id instead of free text.
CREATE TABLE IF NOT EXISTS complaint_categories (
  id         SERIAL PRIMARY KEY,
  code       VARCHAR(40) NOT NULL UNIQUE,
  label      VARCHAR(80) NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  active     BOOLEAN     NOT NULL DEFAULT true
);

INSERT INTO complaint_categories (code, label, sort_order) VALUES
  ('NURSING',         'Nursing',          10),
  ('FOOD',            'Food',             20),
  ('HOUSEKEEPING',    'Housekeeping',     30),
  ('BILLING',         'Billing',          40),
  ('PHARMACY',        'Pharmacy',         50),
  ('MAINTENANCE',     'Maintenance',      60),
  ('DOCTOR',          'Doctor',           70),
  ('STAFF_BEHAVIOUR', 'Staff Behaviour',  80),
  ('WASHROOM',        'Washroom',         90),
  ('OTHER',           'Other',           100)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS complaint_priorities (
  id     SERIAL PRIMARY KEY,
  code   VARCHAR(20) NOT NULL UNIQUE,
  label  VARCHAR(40) NOT NULL,
  rank   INTEGER     NOT NULL,
  active BOOLEAN     NOT NULL DEFAULT true
);

-- Patients never set priority (they aren't shown the field at all). Every
-- complaint starts MEDIUM and only the owning PWO can change it.
INSERT INTO complaint_priorities (code, label, rank) VALUES
  ('LOW','Low',10), ('MEDIUM','Medium',20), ('HIGH','High',30), ('CRITICAL','Critical',40)
ON CONFLICT (code) DO NOTHING;

-- ── 3. complaints ───────────────────────────────────────────────────────────
-- Human-quotable id ("CMP-000123") — patients and staff refer to complaints out
-- loud/on paper, and a bare bigserial is easy to mis-transcribe. Sequence-backed
-- DEFAULT so it's assigned atomically at INSERT with no extra round-trip.
CREATE SEQUENCE IF NOT EXISTS complaint_code_seq START 1;

CREATE TABLE IF NOT EXISTS complaints (
  id             BIGSERIAL PRIMARY KEY,
  complaint_code VARCHAR(20) NOT NULL UNIQUE
                 DEFAULT ('CMP-' || LPAD(nextval('complaint_code_seq')::text, 6, '0')),

  -- Origin. ON DELETE RESTRICT everywhere: complaint data is never hard-deleted,
  -- and must never be orphaned by an upstream delete either.
  admission_id INTEGER     NOT NULL REFERENCES patient_admissions(id) ON DELETE RESTRICT,
  ip_last6     VARCHAR(6),

  category_id  INTEGER NOT NULL REFERENCES complaint_categories(id) ON DELETE RESTRICT,
  priority_id  INTEGER NOT NULL REFERENCES complaint_priorities(id) ON DELETE RESTRICT,

  -- Patient's own words. Immutable by design — no update path exists for this
  -- column anywhere in the API; PWOs add complaint_notes rows instead.
  description  TEXT NOT NULL,

  status       VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  owner_pwo_id INTEGER REFERENCES users(id) ON DELETE SET NULL,

  -- ── Point-in-time snapshot of where the patient was when they complained.
  -- Both the FK id (for GROUP BY / joins) and the denormalized name (so a later
  -- bed transfer, ward rename, or ward deletion can never silently rewrite where
  -- a historical complaint says it happened). This is also what makes the
  -- reporting queries single-table with no joins.
  ward_id         INTEGER REFERENCES wards(id) ON DELETE SET NULL,
  ward_name       VARCHAR(150),
  floor_id        INTEGER REFERENCES floors(id) ON DELETE SET NULL,
  floor_name      VARCHAR(150),
  bed_id          INTEGER REFERENCES bed_details(id) ON DELETE SET NULL,
  bed_name        VARCHAR(100),
  room_type       VARCHAR(100),
  department_id   INTEGER,
  department_name VARCHAR(120),
  admitted_at     BIGINT,

  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  -- Milestone stamps, kept as real columns rather than derived from
  -- complaint_status_history: "average acceptance time" / "average resolution
  -- time" are dashboard cards that must not require a scan+aggregate over the
  -- history table on every load.
  accepted_at BIGINT,
  resolved_at BIGINT,
  closed_at   BIGINT,

  CONSTRAINT complaints_status_check
    CHECK (status IN ('OPEN','ACCEPTED','UNDER_REVIEW','RESOLVED','CLOSED')),
  -- A complaint is owned iff it has left OPEN. Enforced here so a bug in the
  -- accept path can never produce an owner-less ACCEPTED row (which would be
  -- invisible to "my complaints" but missing from the open queue).
  CONSTRAINT complaints_owner_status_check
    CHECK ((status = 'OPEN' AND owner_pwo_id IS NULL)
        OR (status <> 'OPEN' AND owner_pwo_id IS NOT NULL))
);

-- ── 4. complaint_notes ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS complaint_notes (
  id             BIGSERIAL PRIMARY KEY,
  complaint_id   BIGINT  NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note           TEXT    NOT NULL,
  -- Internal by default. The patient portal is unauthenticated (anyone who types
  -- a valid 6-digit IP number sees that patient's data), so a note is only ever
  -- exposed to the portal when a PWO explicitly ticks "share with patient".
  is_visible_to_patient BOOLEAN NOT NULL DEFAULT false,
  created_at     BIGINT  NOT NULL
);

-- ── 5. complaint_status_history ─────────────────────────────────────────────
-- Append-only audit trail of every lifecycle transition, matching the
-- bed_movements / audit_logs convention already used across BedFlow: rows here
-- are only ever inserted, never updated or deleted.
CREATE TABLE IF NOT EXISTS complaint_status_history (
  id           BIGSERIAL PRIMARY KEY,
  complaint_id BIGINT      NOT NULL REFERENCES complaints(id) ON DELETE RESTRICT,
  from_status  VARCHAR(20),
  to_status    VARCHAR(20) NOT NULL,
  changed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at   BIGINT      NOT NULL,
  note         TEXT
);

-- ── 6. Indexes ──────────────────────────────────────────────────────────────
-- Queue: the PWO dashboard's default view is "OPEN, newest first", and every
-- other tab is the same shape filtered by a different status.
CREATE INDEX IF NOT EXISTS idx_complaints_status_created  ON complaints(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_complaints_created         ON complaints(created_at DESC);
-- "My complaints" / complaints-per-PWO reporting.
CREATE INDEX IF NOT EXISTS idx_complaints_owner           ON complaints(owner_pwo_id, status);
-- Reporting group-bys (which ward/floor/department/category generates the most).
CREATE INDEX IF NOT EXISTS idx_complaints_category        ON complaints(category_id);
CREATE INDEX IF NOT EXISTS idx_complaints_priority        ON complaints(priority_id);
CREATE INDEX IF NOT EXISTS idx_complaints_ward            ON complaints(ward_id);
CREATE INDEX IF NOT EXISTS idx_complaints_floor           ON complaints(floor_id);
CREATE INDEX IF NOT EXISTS idx_complaints_department      ON complaints(department_id);
-- "Resolved today" / "Closed today" cards + resolution-trend charts. Partial:
-- only a minority of rows are ever resolved/closed on any given day, and NULLs
-- are pure index bloat for these two.
CREATE INDEX IF NOT EXISTS idx_complaints_resolved_at     ON complaints(resolved_at) WHERE resolved_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_complaints_closed_at       ON complaints(closed_at)   WHERE closed_at   IS NOT NULL;
-- Patient portal: this patient's complaints, and the 5-minute cooldown lookup
-- (most recent complaint for this admission) — both served by this one index.
CREATE INDEX IF NOT EXISTS idx_complaints_admission       ON complaints(admission_id, created_at DESC);
-- Search by IP number.
CREATE INDEX IF NOT EXISTS idx_complaints_ip              ON complaints(ip_last6);

CREATE INDEX IF NOT EXISTS idx_complaint_notes_complaint  ON complaint_notes(complaint_id, created_at);
CREATE INDEX IF NOT EXISTS idx_complaint_hist_complaint   ON complaint_status_history(complaint_id, changed_at);
