-- Remove the shift (morning/night) concept entirely. PRE rounds now fire
-- every 2 hours, 24/7, for every PRE user — no per-user shift assignment,
-- no shift-windowed on/off-duty state.

-- 1. Existing pre_rounds.round_key values are in the old 4-segment format
--    "block|shift|date|startMin". Two rows could theoretically collide once
--    the shift segment is stripped (e.g. a block's PRE user's shift changed
--    mid-day, producing two historical rows for the same block/date/startMin
--    under different shifts) — round_key is UNIQUE, so dedupe first, keeping
--    the earliest submission per resulting key.
WITH ranked AS (
  SELECT id,
         SPLIT_PART(round_key, '|', 1) || '|' || SPLIT_PART(round_key, '|', 3) || '|' || SPLIT_PART(round_key, '|', 4) AS new_key,
         ROW_NUMBER() OVER (
           PARTITION BY SPLIT_PART(round_key, '|', 1) || '|' || SPLIT_PART(round_key, '|', 3) || '|' || SPLIT_PART(round_key, '|', 4)
           ORDER BY submitted_at ASC
         ) AS rn
  FROM pre_rounds
  WHERE array_length(string_to_array(round_key, '|'), 1) = 4
)
DELETE FROM pre_rounds WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. Rewrite round_key to the new 3-segment format "block|date|startMin" for
--    the remaining old-format rows, so history/date-listing queries
--    (SPLIT_PART(round_key, '|', 2)) keep working for past dates.
UPDATE pre_rounds
SET round_key = SPLIT_PART(round_key, '|', 1) || '|' || SPLIT_PART(round_key, '|', 3) || '|' || SPLIT_PART(round_key, '|', 4)
WHERE array_length(string_to_array(round_key, '|'), 1) = 4;

-- 3. Drop the now-unused shift columns.
ALTER TABLE pre_rounds DROP COLUMN IF EXISTS shift;
ALTER TABLE users      DROP COLUMN IF EXISTS shift;

-- 4. Drop the shifts reference table — never queried at runtime, only ever
--    written to by seed scripts.
DROP TABLE IF EXISTS shifts;
