-- Ward operational status change log
-- Tracks every time a ward is toggled operational/non-operational
-- including who changed it, when, old value, new value, and an optional reason
CREATE TABLE ward_operational_log (
  id          SERIAL PRIMARY KEY,
  ward_id     INT    NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
  changed_by  INT    REFERENCES users(id) ON DELETE SET NULL,
  changed_at  BIGINT NOT NULL,
  old_value   BOOLEAN NOT NULL,
  new_value   BOOLEAN NOT NULL,
  reason      TEXT
);

CREATE INDEX idx_ward_op_log_ward    ON ward_operational_log(ward_id);
CREATE INDEX idx_ward_op_log_changed ON ward_operational_log(changed_at DESC);

-- Bed operational status change log
-- Tracks every time a bed is toggled operational/non-operational
-- forced_vacant = true means the bed was OCCUPIED when marked non-op and was forced to VACANT
CREATE TABLE bed_operational_log (
  id            SERIAL PRIMARY KEY,
  bed_id        INT    NOT NULL REFERENCES bed_details(id) ON DELETE CASCADE,
  ward_id       INT    NOT NULL,
  changed_by    INT    REFERENCES users(id) ON DELETE SET NULL,
  changed_at    BIGINT NOT NULL,
  old_value     BOOLEAN NOT NULL,
  new_value     BOOLEAN NOT NULL,
  forced_vacant BOOLEAN NOT NULL DEFAULT false,
  reason        TEXT
);

CREATE INDEX idx_bed_op_log_bed     ON bed_operational_log(bed_id);
CREATE INDEX idx_bed_op_log_ward    ON bed_operational_log(ward_id);
CREATE INDEX idx_bed_op_log_changed ON bed_operational_log(changed_at DESC);
