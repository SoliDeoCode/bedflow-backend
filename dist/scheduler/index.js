import { db } from "../db/index.js";
import { pushToUser } from "../services/pushService.js";
import { snapshotOccupancy, captureMidnightCensus } from "../services/bedService.js";
import { emitUpdate } from "../websocket/io.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, currentRound, inShift, roundKey } from "../config/domain.js";
const lastPush = new Map();
const REPUSH_MS = 5 * 60 * 1000;
let lastCaptureDate = "";
let lastSnapshotHour = -1;
async function tick() {
    const now = Date.now();
    const mins = minsNow();
    const today = todayStr();
    // Evict COO reminder flags from previous days — keys are "coo:YYYY-MM-DD:HH:MM"
    for (const key of lastPush.keys())
        if (key.startsWith("coo:") && !key.startsWith(`coo:${today}:`))
            lastPush.delete(key);
    // Single JOIN: PRE users that have a block with at least one ward assigned
    const pres = await db.prepare(`SELECT u.id, u.username, u.shift, u.pre_block_id, pb.name AS block_name
     FROM users u
     JOIN pre_blocks pb ON pb.id = u.pre_block_id
     JOIN pre_block_wards pbw ON pbw.pre_block_id = u.pre_block_id
     WHERE u.role = 'PRE'
     GROUP BY u.id, u.username, u.shift, u.pre_block_id, pb.name`).all();
    if (pres.length > 0) {
        // Compute round keys for all PRE users in JS — no DB call
        const keyMeta = pres.map(u => {
            const shift = u.shift || "morning";
            const round = currentRound(shift, mins);
            const key = roundKey(`pb${u.pre_block_id}`, shift, today, round.startMin);
            return { u, shift, key };
        });
        // Batch: which of the current round keys have been submitted
        const allKeys = keyMeta.map(m => m.key);
        const submittedRows = await db.prepare(`SELECT round_key FROM pre_rounds WHERE round_key = ANY(?)`).all(allKeys);
        const submittedKeys = new Set(submittedRows.map(r => r.round_key));
        for (const { u, shift, key } of keyMeta) {
            if (!inShift(shift, mins))
                continue;
            if (submittedKeys.has(key))
                continue;
            const label = u.block_name ?? `PRE Block ${u.pre_block_id}`;
            emitUpdate("alarm:active", { floor: label }, { pre: String(u.pre_block_id) });
            const pushKey = "pre:" + u.id;
            if (now - (lastPush.get(pushKey) || 0) >= REPUSH_MS) {
                lastPush.set(pushKey, now);
                void pushToUser(u.id, {
                    title: `⏰ Bed round due — ${label}`,
                    body: "Open BedFlow and submit your bed counts now.",
                    tag: "pre-round", requireInteraction: true, alarm: true,
                });
            }
        }
    }
    // COO reminders at the top of each 3-hour slot
    for (const r of COO_REMINDERS) {
        if (mins === hmToMin(r)) {
            const flag = "coo:" + todayStr() + ":" + r;
            if (!lastPush.has(flag)) {
                lastPush.set(flag, now);
                const coos = await db.prepare("SELECT id FROM users WHERE role='COO'").all();
                for (const c of coos)
                    void pushToUser(c.id, {
                        title: "Hospital bed-status review",
                        body: `Your ${r} review is ready.`, tag: "coo-reminder",
                    });
            }
        }
    }
    // hourly occupancy snapshot — guard against double-fire (30s tick hits minute=0 twice)
    const india = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    if (india.getMinutes() === 0 && india.getHours() !== lastSnapshotHour) {
        lastSnapshotHour = india.getHours();
        void snapshotOccupancy();
    }
    // midnight census: snapshot all ward counts at 00:00 IST; the capture is
    // idempotent and the window is one hour so a restart around midnight still
    // records it, while a snapshot is never taken late in the day.
    if (mins < 60 && lastCaptureDate !== today) {
        lastCaptureDate = today;
        void captureMidnightCensus(today);
    }
}
export function startScheduler() {
    setInterval(() => { void tick(); }, 30 * 1000);
    console.log("Scheduler started (30s tick)");
}
