-- Census/Non-Census is now ward-level only (no per-bed override — see
-- generateBeds/addSingleBed/updateBedMaster in bedDetailService.ts). Every bed
-- must match its ward's bed_type going forward; correct any that already drifted.
UPDATE bed_details bd
SET bed_type = w.bed_type, updated_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM wards w
WHERE w.id = bd.ward_id AND bd.bed_type IS DISTINCT FROM w.bed_type;

-- Reconcile every ward's cached totals (beds table + wards.total_beds) against
-- live bed_details, using the same rule _recalcWardTotals now enforces:
-- vacant/reserved/occupied/occupied_reserved only count operational beds;
-- total is the raw physical bed count regardless of operational_status.
WITH counts AS (
  SELECT
    ward_id,
    COUNT(*) AS total,
    SUM(CASE WHEN operational_status AND physical_status='VACANT'   AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS vacant,
    SUM(CASE WHEN operational_status AND physical_status='VACANT'   AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS reserved,
    SUM(CASE WHEN operational_status AND physical_status='OCCUPIED' AND reservation_status='NONE'     THEN 1 ELSE 0 END) AS occupied,
    SUM(CASE WHEN operational_status AND physical_status='OCCUPIED' AND reservation_status='RESERVED' THEN 1 ELSE 0 END) AS occupied_reserved
  FROM bed_details
  GROUP BY ward_id
)
INSERT INTO beds (ward_id, total, vacant, reserved, occupied, occupied_reserved, updated_at)
SELECT ward_id, total, vacant, reserved, occupied, occupied_reserved, (EXTRACT(EPOCH FROM now()) * 1000)::bigint
FROM counts
ON CONFLICT (ward_id) DO UPDATE SET
  total             = EXCLUDED.total,
  vacant            = EXCLUDED.vacant,
  reserved          = EXCLUDED.reserved,
  occupied          = EXCLUDED.occupied,
  occupied_reserved = EXCLUDED.occupied_reserved,
  updated_at        = EXCLUDED.updated_at;

UPDATE wards w
SET total_beds = c.total
FROM (SELECT ward_id, COUNT(*) AS total FROM bed_details GROUP BY ward_id) c
WHERE w.id = c.ward_id AND w.total_beds IS DISTINCT FROM c.total;
