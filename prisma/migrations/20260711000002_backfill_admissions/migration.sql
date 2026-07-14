-- Beds that were already Occupied before the discharge module existed have no
-- patient_admissions row (one is only created going forward, the moment a bed
-- transitions Vacant -> Occupied through the app). Without this backfill, every
-- already-occupied bed would be permanently unable to use Plan Discharge / Transfer
-- Bed until it happened to cycle through a vacate+re-occupy first.

-- ip_last6 is unknown for these pre-existing occupants (V1 has no HIS integration
-- to look it up), so it must become nullable instead of always-6-digits.
ALTER TABLE patient_admissions ALTER COLUMN ip_last6 DROP NOT NULL;

INSERT INTO patient_admissions (bed_id, ward_id, ip_last6, status, admitted_at, created_by, updated_at)
SELECT bd.id, bd.ward_id, NULL, 'ACTIVE', COALESCE(bd.updated_at, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint),
       bd.updated_by, (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
FROM bed_details bd
WHERE bd.physical_status = 'OCCUPIED'
  AND NOT EXISTS (
    SELECT 1 FROM patient_admissions pa WHERE pa.bed_id = bd.id AND pa.status = 'ACTIVE'
  );
