// Domain timing configuration.
// Block structure + ward data are now fully stored in the database —
// the old static FLOOR_MAP / WARDS / SEED_ACCOUNTS constants have been removed.

export const PRE_INTERVAL_MIN = 120;       // PRE round every 2 hours — no shift windows, on duty 24/7
export const COO_REMINDERS = ["09:00", "12:00", "15:00", "18:00"];

// ---- time helpers ----
export function hmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number); return h * 60 + m;
}

/** Returns a Date whose getHours/getMinutes reflect Asia/Kolkata time,
 *  regardless of the server's system timezone (Render runs UTC). */
function indiaTime(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

export function minsNow(): number {
  const d = indiaTime(); return d.getHours() * 60 + d.getMinutes();
}

export function todayStr(): string {
  const d = indiaTime();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/** Unix-ms for IST midnight of today (safe for DB range queries). */
export function startOfDayIST(): number {
  return new Date(todayStr() + "T00:00:00+05:30").getTime();
}

/** PRE rounds are due every PRE_INTERVAL_MIN, anchored at midnight IST —
 *  every PRE user is on duty all day, every day (no shift windows). */
export function currentRound(mins: number) {
  const idx = Math.floor(mins / PRE_INTERVAL_MIN);
  const startMin = idx * PRE_INTERVAL_MIN;
  return { idx, startMin, endMin: startMin + PRE_INTERVAL_MIN };
}

/** round_key format: "1A|2026-05-27|540"  (block name replaces pre_code) */
export function roundKey(blockName: string, date: string, startMin: number): string {
  return `${blockName}|${date}|${startMin}`;
}
