import { db } from "../db/index.js";
import { alarmState, userShift } from "../services/roundService.js";
import { pushToUser } from "../services/pushService.js";
import { snapshotOccupancy } from "../services/bedService.js";
import { emitUpdate } from "../websocket/io.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr } from "../config/domain.js";
const lastPush = new Map();
const REPUSH_MS = 5 * 60 * 1000;
function tick() {
    const now = Date.now();
    // PRE overdue → push (works whether or not they're logged in)
    const pres = db.prepare("SELECT id, username FROM users WHERE role='PRE'")
        .all();
    for (const u of pres) {
        // Look up assigned block directly from users.block_id
        const blockRow = db.prepare(`SELECT b.id, b.name FROM users usr
       JOIN blocks b ON b.id = usr.block_id
       WHERE usr.id = ?`).get(u.id);
        if (!blockRow)
            continue;
        const wardCount = db.prepare("SELECT COUNT(*) AS n FROM wards WHERE block_id = ?").get(blockRow.id)?.n ?? 0;
        if (wardCount === 0)
            continue;
        const st = alarmState(blockRow.name, userShift(u.id));
        if (st.alarmActive) {
            emitUpdate("alarm:active", { pre: blockRow.name }, blockRow.name);
            const key = "pre:" + u.id;
            if (now - (lastPush.get(key) || 0) >= REPUSH_MS) {
                lastPush.set(key, now);
                void pushToUser(u.id, {
                    title: `⏰ Bed round due — ${blockRow.name}`,
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
                for (const c of db.prepare("SELECT id FROM users WHERE role='COO'").all())
                    void pushToUser(c.id, {
                        title: "Hospital bed-status review",
                        body: `Your ${r} review is ready.`, tag: "coo-reminder",
                    });
            }
        }
    }
    // hourly occupancy snapshot — use IST minutes so Render (UTC) fires at the right time
    const india = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    if (india.getMinutes() === 0)
        snapshotOccupancy();
}
export function startScheduler() {
    setInterval(tick, 30 * 1000);
    console.log("Scheduler started (30s tick)");
}
