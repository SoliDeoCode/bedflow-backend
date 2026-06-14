-- Re-enable OCCUPIED + RESERVED combination.
-- The previous migration added this constraint to prevent it; we now remove it
-- because a bed being physically occupied but reserved for the next patient is a
-- valid and common hospital workflow.

ALTER TABLE bed_details DROP CONSTRAINT IF EXISTS chk_no_occupied_reserved;
