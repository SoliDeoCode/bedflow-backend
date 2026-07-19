-- DB-level guard: once a discharge has been planned or started for a bed's active
-- admission, the bed cannot be manually flipped back to Vacant — only completing
-- the discharge (System Checkout + Physical Checkout both COMPLETED) can vacate it.
-- Before any discharge plan exists, or after one is Cancelled, manual vacate still
-- works exactly as before. This is the actual authority for the rule — the
-- application-level check in updateBedStatus (bedDetailService.ts) exists only to
-- return a clean error message; this trigger holds even if some other code path
-- (a script, a different service, a future route) writes to bed_details directly.
CREATE OR REPLACE FUNCTION enforce_bed_vacate_rule() RETURNS trigger AS $$
DECLARE
  gate RECORD;
BEGIN
  IF OLD.physical_status = 'OCCUPIED' AND NEW.physical_status = 'VACANT' THEN
    SELECT dt.status, dt.system_checkout_status, dt.physical_checkout_status
    INTO gate
    FROM patient_admissions pa
    JOIN discharge_tracking dt ON dt.admission_id = pa.id
    WHERE pa.bed_id = OLD.id AND pa.status = 'ACTIVE';

    IF FOUND
       AND gate.status <> 'CANCELLED'
       AND NOT (gate.system_checkout_status = 'COMPLETED' AND gate.physical_checkout_status = 'COMPLETED')
    THEN
      RAISE EXCEPTION 'Bed % has a discharge planned or in progress — it can only become vacant once System Checkout and Physical Checkout are both completed.', OLD.bed_name;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_bed_vacate_rule ON bed_details;
CREATE TRIGGER trg_enforce_bed_vacate_rule
BEFORE UPDATE ON bed_details
FOR EACH ROW EXECUTE FUNCTION enforce_bed_vacate_rule();
