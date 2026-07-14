-- Discharge Management + Bed Transfer module (BedFlow V2).
-- This is a separate workflow layer on top of the existing bed_details/beds
-- tables — it never touches physical bed status columns or occupancy math.
-- bed_details / beds / wards remain the source of truth for occupancy.

CREATE TABLE IF NOT EXISTS patient_admissions (
  id            SERIAL  PRIMARY KEY,
  bed_id        INTEGER NOT NULL REFERENCES bed_details(id) ON DELETE RESTRICT,
  ward_id       INTEGER NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  ip_last6      VARCHAR(6) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  admitted_at   BIGINT NOT NULL,
  discharged_at BIGINT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient_admissions_bed  ON patient_admissions(bed_id);
CREATE INDEX IF NOT EXISTS idx_patient_admissions_ward ON patient_admissions(ward_id);
-- Only one ACTIVE admission per bed at a time — enforced at the DB level so a
-- race between two callers can't create two "current patients" for one bed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_patient_admissions_active_bed
  ON patient_admissions(bed_id) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS discharge_tracking (
  id                               SERIAL  PRIMARY KEY,
  admission_id                     INTEGER NOT NULL UNIQUE REFERENCES patient_admissions(id) ON DELETE CASCADE,
  status                           VARCHAR(20) NOT NULL DEFAULT 'PLANNED',
  planned_date                     VARCHAR(10) NOT NULL,
  planned_time                     VARCHAR(10),
  planned_by                       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  prompted_at                      BIGINT,
  initiated_at                     BIGINT,
  discharge_summary_status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  drug_return_status               VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  pharmacy_clearance_status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  procedure_reconciliation_status  VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  billing_started_status           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  audit_status                     VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  bill_ready_status                VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  payment_status                   VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  system_checkout_status           VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  physical_checkout_status         VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  patient_left                     BOOLEAN,
  created_by                       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at                       BIGINT NOT NULL,
  updated_at                       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discharge_tracking_status  ON discharge_tracking(status);
CREATE INDEX IF NOT EXISTS idx_discharge_tracking_planned ON discharge_tracking(planned_date, status);

-- Append-only. Rows here are never updated or deleted, only inserted —
-- same convention as bed_movements.
CREATE TABLE IF NOT EXISTS discharge_history (
  id                     SERIAL  PRIMARY KEY,
  admission_id           INTEGER NOT NULL REFERENCES patient_admissions(id) ON DELETE CASCADE,
  discharge_tracking_id  INTEGER REFERENCES discharge_tracking(id) ON DELETE SET NULL,
  field                  VARCHAR(50) NOT NULL,
  old_value              TEXT,
  new_value              TEXT,
  changed_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at             BIGINT NOT NULL,
  reason                 TEXT
);
CREATE INDEX IF NOT EXISTS idx_discharge_history_admission ON discharge_history(admission_id, changed_at);

CREATE TABLE IF NOT EXISTS bed_transfer_history (
  id              SERIAL  PRIMARY KEY,
  admission_id    INTEGER NOT NULL REFERENCES patient_admissions(id) ON DELETE CASCADE,
  from_bed_id     INTEGER NOT NULL REFERENCES bed_details(id) ON DELETE RESTRICT,
  to_bed_id       INTEGER NOT NULL REFERENCES bed_details(id) ON DELETE RESTRICT,
  from_ward_id    INTEGER NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  to_ward_id      INTEGER NOT NULL REFERENCES wards(id) ON DELETE RESTRICT,
  reason          TEXT NOT NULL,
  transferred_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  transferred_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bed_transfer_history_admission ON bed_transfer_history(admission_id, transferred_at);
