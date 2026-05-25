// Domain configuration derived from the hospital's Excel + floor plan.
// Verified ward totals: 13/30/25/29/21/27/12/0/6/0 = 163 (+ NA = 200 capacity).

export const FLOOR_MAP: Record<string, string[]> = {
  "1st Floor": ["PRE-1", "PRE-2"],
  "2nd Floor": ["PRE-3", "PRE-4", "PRE-5"],
  "3rd Floor": ["PRE-6", "PRE-7"],
  "4th Floor": ["PRE-8"],
  "5th Floor": ["PRE-9"],
  "Pending Assignment": ["PRE-10"],
};

export const WARDS: Record<string, [string, number][]> = {
  "PRE-1": [["Single/Sharing", 10], ["Leukemia/ICU", 3]],
  "PRE-2": [["Chemo DC", 15], ["Single", 3], ["TWIN", 12]],
  "PRE-3": [["Deluxe", 10], ["Single", 3], ["TWIN", 12]],
  "PRE-4": [["Economy G/W", 21], ["Executive G/W", 8]],
  "PRE-5": [["Chemo DC", 16], ["Leukemia/ICU", 5]],
  "PRE-6": [["ICU", 16], ["Pre & Post OP", 11]],
  "PRE-7": [["Deluxe", 12]],
  "PRE-8": [],
  "PRE-9": [["Backup G/W", 6]],
  "PRE-10": [],
};

export const SHIFTS = {
  morning: { label: "Morning / General", start: "09:00", end: "18:30" },
  night: { label: "Night", start: "20:00", end: "08:00" },
} as const;
export type ShiftKey = keyof typeof SHIFTS;

export const PRE_INTERVAL_MIN = 120;            // PRE round every 2 hours
export const COO_REMINDERS = ["09:00", "12:00", "15:00", "18:00"]; // every 3h, 9-6

// 10 PRE + 1 MANAGER + 1 COO = 12 accounts
export const SEED_ACCOUNTS = (() => {
  const list: { username: string; password: string; role: string; name: string; pre?: string }[] = [];
  for (let i = 1; i <= 10; i++)
    list.push({ username: `pre${i}`, password: `pre${i}123`, role: "PRE", name: `PRE-${i} Manager`, pre: `PRE-${i}` });
  list.push({ username: "manager", password: "manager123", role: "MANAGER", name: "Ward Manager" });
  list.push({ username: "coo", password: "coo123", role: "COO", name: "Chief Operating Officer" });
  return list;
})();

// ---- time helpers ----
export function hmToMin(s: string): number { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
export function minsNow(d = new Date()): number { return d.getHours() * 60 + d.getMinutes(); }
export function todayStr(d = new Date()): string {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
export function inShift(shift: ShiftKey, mins: number): boolean {
  const s = SHIFTS[shift]; const st = hmToMin(s.start), en = hmToMin(s.end);
  return st < en ? (mins >= st && mins < en) : (mins >= st || mins < en);
}
export function currentRound(shift: ShiftKey, mins: number) {
  const st = hmToMin(SHIFTS[shift].start);
  let rel = mins - st; if (rel < 0) rel += 1440;
  const idx = Math.floor(rel / PRE_INTERVAL_MIN);
  const startMin = (st + idx * PRE_INTERVAL_MIN) % 1440;
  return { idx, startMin, endMin: (startMin + PRE_INTERVAL_MIN) % 1440 };
}
export function roundKey(pre: string, shift: string, date: string, startMin: number): string {
  return `${pre}|${shift}|${date}|${startMin}`;
}
