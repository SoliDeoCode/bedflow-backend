import { db } from "../db/index.js";
import { alarmState, userShift } from "../services/roundService.js";
import { pushToUser } from "../services/pushService.js";
import { snapshotOccupancy } from "../services/bedService.js";
import { emitUpdate } from "../websocket/io.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, WARDS } from "../config/domain.js";

const lastPush = new Map<string, number>();
const REPUSH_MS = 5 * 60 * 1000;

function tick() {
  const now = Date.now();

  // PRE overdue → push (works whether or not they're logged in)
  const pres = db.prepare("SELECT id, username FROM users WHERE role='PRE'")
    .all<{ id: number; username: string }>();
  for (const u of pres) {
    const assign = db.prepare("SELECT pre_code FROM pre_assignments WHERE user_id=?")
      .get<{ pre_code: string }>(u.id);
    if (!assign || (WARDS[assign.pre_code] || []).length === 0) continue;
    const st = alarmState(assign.pre_code, userShift(u.id));
    if (st.alarmActive) {
      emitUpdate("alarm:active", { pre: assign.pre_code }, assign.pre_code);
      const key = "pre:" + u.id;
      if (now - (lastPush.get(key) || 0) >= REPUSH_MS) {
        lastPush.set(key, now);
        void pushToUser(u.id, {
          title: `⏰ Bed round due — ${assign.pre_code}`,
          body: "Open BedFlow and submit your bed counts now.",
          tag: "pre-round", requireInteraction: true, alarm: true,
        });
      }
    }
  }

  // COO reminders at the top of each 3-hour slot
  const mins = minsNow();
  for (const r of COO_REMINDERS) {
    if (mins === hmToMin(r)) {
      const flag = "coo:" + todayStr() + ":" + r;
      if (!lastPush.has(flag)) {
        lastPush.set(flag, now);
        for (const c of db.prepare("SELECT id FROM users WHERE role='COO'").all<{ id: number }>())
          void pushToUser(c.id, {
            title: "Hospital bed-status review",
            body: `Your ${r} review is ready.`, tag: "coo-reminder",
          });
      }
    }
  }

  // hourly occupancy snapshot
  if (new Date().getMinutes() === 0) snapshotOccupancy();
}

export function startScheduler() {
  setInterval(tick, 30 * 1000);
  console.log("Scheduler started (30s tick)");
}
