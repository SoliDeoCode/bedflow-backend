-- Nurse Access Assignments: fine-grained per-nurse per-ward access
-- (Full Ward access or Selected Beds only). Replaces/overrides station-wide
-- access when any active assignment exists for the nurse.

CREATE TABLE nurse_access_assignments (
  id          SERIAL       PRIMARY KEY,
  nurse_id    INTEGER      NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  ward_id     INTEGER      NOT NULL REFERENCES wards(id)  ON DELETE CASCADE,
  access_type VARCHAR(10)  NOT NULL DEFAULT 'FULL'
                           CHECK (access_type IN ('FULL','BEDS')),
  bed_names   TEXT         NOT NULL DEFAULT '[]',
  status      VARCHAR(10)  NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','inactive')),
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL,
  created_by  INTEGER      REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(nurse_id, ward_id)
);
CREATE INDEX ON nurse_access_assignments(nurse_id);
CREATE INDEX ON nurse_access_assignments(ward_id);
