-- Free-text note for VACANT+RESERVED beds (e.g. "Reserved for incoming
-- transfer from ICU"). Optional — unlike destination, no required validation.
ALTER TABLE bed_details  ADD COLUMN IF NOT EXISTS reservation_note VARCHAR(255) NULL;
ALTER TABLE bed_movements ADD COLUMN IF NOT EXISTS reservation_note VARCHAR(255) NULL;
