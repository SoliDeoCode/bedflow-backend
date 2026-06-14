-- Enforce that a bed cannot be both OCCUPIED and RESERVED at the same time.
-- First clean up any legacy data that would violate the constraint.
UPDATE bed_details
  SET reservation_status = 'NONE'
  WHERE physical_status = 'OCCUPIED' AND reservation_status = 'RESERVED';

-- Add CHECK constraint
ALTER TABLE bed_details
  ADD CONSTRAINT chk_no_occupied_reserved
  CHECK (physical_status != 'OCCUPIED' OR reservation_status = 'NONE');

-- Recalculate beds summary table to ensure occupied_reserved is zeroed out
UPDATE beds b
  SET occupied_reserved = 0,
      occupied = (
        SELECT COUNT(*) FROM bed_details bd
        WHERE bd.ward_id = b.ward_id AND bd.physical_status = 'OCCUPIED'
      ),
      vacant = (
        SELECT COUNT(*) FROM bed_details bd
        WHERE bd.ward_id = b.ward_id
          AND bd.physical_status = 'VACANT' AND bd.reservation_status = 'NONE'
      ),
      reserved = (
        SELECT COUNT(*) FROM bed_details bd
        WHERE bd.ward_id = b.ward_id
          AND bd.physical_status = 'VACANT' AND bd.reservation_status = 'RESERVED'
      );
