// ── Single source of truth for occupancy partition totals (backend) ────────────
// Mirrors kimsbedtracker/src/bedUtils.js `calculateWardTotals`. The bed model is
// a 2×2 matrix of physical_status {VACANT, OCCUPIED} × reservation_status
// {NONE, RESERVED}; the four stored counts are the four DISJOINT cells, defined
// authoritatively by bedDetailService._recalcWardTotals:
//   vacant            = VACANT   ∧ NONE
//   reserved          = VACANT   ∧ RESERVED
//   occupied          = OCCUPIED ∧ NONE
//   occupied_reserved = OCCUPIED ∧ RESERVED
//
// NOTE: `totalBeds` here is the sum of the four CATEGORIZED counts. It is NOT
// the ward's stored capacity (`total` / `total_beds`); for an unreported ward
// the categorized sum is 0 while capacity is non-zero.

export interface WardCounts {
  vacant?: number | null;
  reserved?: number | null;
  occupied?: number | null;
  occupied_reserved?: number | null;
}

export interface WardTotals {
  totalBeds: number;
  totalVacant: number;
  totalOccupied: number;
  totalReserved: number;
}

/** Accepts a single ward-counts object or an array of them; nulls count as 0. */
export function calculateWardTotals(input: WardCounts | WardCounts[]): WardTotals {
  const list = Array.isArray(input) ? input : [input];
  let vacant = 0, reserved = 0, occupied = 0, occupiedReserved = 0;
  for (const b of list) {
    vacant           += b?.vacant            ?? 0;
    reserved         += b?.reserved          ?? 0;
    occupied         += b?.occupied          ?? 0;
    occupiedReserved += b?.occupied_reserved ?? 0;
  }
  return {
    totalBeds:     vacant + reserved + occupied + occupiedReserved,
    totalVacant:   vacant + reserved,
    totalOccupied: occupied + occupiedReserved,
    totalReserved: reserved + occupiedReserved,
  };
}
