// Domain timing configuration.
// Block structure + ward data are now fully stored in the database —
// the old static FLOOR_MAP / WARDS / SEED_ACCOUNTS constants have been removed.
export const SHIFTS = {
    morning: { label: "Morning / General", start: "09:00", end: "18:30" },
    night: { label: "Night", start: "20:00", end: "08:00" },
};
export const PRE_INTERVAL_MIN = 120; // PRE round every 2 hours
export const COO_REMINDERS = ["09:00", "12:00", "15:00", "18:00"];
// ---- time helpers ----
export function hmToMin(s) {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
}
/** Returns a Date whose getHours/getMinutes reflect Asia/Kolkata time,
 *  regardless of the server's system timezone (Render runs UTC). */
function indiaTime() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}
export function minsNow() {
    const d = indiaTime();
    return d.getHours() * 60 + d.getMinutes();
}
export function todayStr() {
    const d = indiaTime();
    return d.getFullYear() + "-" +
        String(d.getMonth() + 1).padStart(2, "0") + "-" +
        String(d.getDate()).padStart(2, "0");
}
/** Unix-ms for IST midnight of today (safe for DB range queries). */
export function startOfDayIST() {
    return new Date(todayStr() + "T00:00:00+05:30").getTime();
}
export function inShift(shift, mins) {
    const s = SHIFTS[shift];
    const st = hmToMin(s.start), en = hmToMin(s.end);
    return st < en ? (mins >= st && mins < en) : (mins >= st || mins < en);
}
export function currentRound(shift, mins) {
    const st = hmToMin(SHIFTS[shift].start);
    let rel = mins - st;
    if (rel < 0)
        rel += 1440;
    const idx = Math.floor(rel / PRE_INTERVAL_MIN);
    const startMin = (st + idx * PRE_INTERVAL_MIN) % 1440;
    return { idx, startMin, endMin: (startMin + PRE_INTERVAL_MIN) % 1440 };
}
/** round_key format: "1A|morning|2026-05-27|540"  (block name replaces pre_code) */
export function roundKey(blockName, shift, date, startMin) {
    return `${blockName}|${shift}|${date}|${startMin}`;
}
/** Format "HH:MM" → "H:MM AM/PM" (e.g. "09:00" → "9:00 AM", "18:30" → "6:30 PM") */
function fmtHHMM(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    const period = h < 12 ? "AM" : "PM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}
/** Human-readable shift window derived from SHIFTS config (e.g. "9:00 AM – 6:30 PM") */
export function formatShiftWindow(shift) {
    const { start, end } = SHIFTS[shift];
    return `${fmtHHMM(start)} – ${fmtHHMM(end)}`;
}
