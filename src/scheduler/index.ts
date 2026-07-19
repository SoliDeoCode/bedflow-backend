import { db } from "../db/index.js";
import { pushToUser } from "../services/pushService.js";
import { snapshotOccupancy, snapshotAdminDashboard, captureMidnightCensus } from "../services/bedService.js";
import { emitUpdate } from "../websocket/io.js";
import { COO_REMINDERS, hmToMin, minsNow, todayStr, currentRound, roundKey } from "../config/domain.js";
import { listPhaseConfig, computeWorkflow } from "../services/dischargeSlaService.js";

const lastPush = new Map<string, number>();
const REPUSH_MS = 5 * 60 * 1000;
let lastCaptureDate   = "";
let lastSnapshotHour  = -1;
/** Admissions whose delay has already been broadcast — prevents a 30s re-emit loop. */
const notifiedDelays = new Set<number>();

async function tick() {
  const now  = Date.now();
  const mins = minsNow();
  const today = todayStr();

  // Evict COO reminder flags from previous days — keys are "coo:YYYY-MM-DD:HH:MM"
  for (const key of lastPush.keys())
    if (key.startsWith("coo:") && !key.startsWith(`coo:${today}:`)) lastPush.delete(key);

  // One row per (user, block) pair — a user assigned to N blocks yields N rows
  const pres = await db.prepare(
    `SELECT u.id, u.username, upb.pre_block_id, pb.name AS block_name
     FROM users u
     JOIN user_pre_blocks upb ON upb.user_id = u.id
     JOIN pre_blocks pb ON pb.id = upb.pre_block_id
     JOIN pre_block_wards pbw ON pbw.pre_block_id = upb.pre_block_id
     WHERE u.role = 'PRE'
     GROUP BY u.id, u.username, upb.pre_block_id, pb.name`
  ).all<{ id: number; username: string; pre_block_id: number; block_name: string }>();

  if (pres.length > 0) {
    // Every PRE user is on duty 24/7 — one global round, same for everyone.
    const round = currentRound(mins);
    const keyMeta = pres.map(u => ({ u, key: roundKey(`pb${u.pre_block_id}`, today, round.startMin) }));

    // Batch: which of the current round keys have been submitted
    const allKeys = keyMeta.map(m => m.key);
    const submittedRows = await db.prepare(
      `SELECT round_key FROM pre_rounds WHERE round_key = ANY(?)`
    ).all<{ round_key: string }>(allKeys);
    const submittedKeys = new Set(submittedRows.map(r => r.round_key));

    for (const { u, key } of keyMeta) {
      if (submittedKeys.has(key)) continue;

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

  // "Start Discharge?" prompt — fires once per planned discharge, the moment its
  // planned date arrives. prompted_at is persisted on the row itself (not just in
  // lastPush) so a server restart never re-derives "already prompted" from memory.
  const dueDischarges = await db.prepare(
    `SELECT dt.id, dt.admission_id, pa.ward_id, pa.bed_id
     FROM discharge_tracking dt
     JOIN patient_admissions pa ON pa.id = dt.admission_id
     WHERE dt.status='PLANNED' AND dt.prompted_at IS NULL AND dt.planned_date <= ?`
  ).all<{ id: number; admission_id: number; ward_id: number; bed_id: number }>(today);

  for (const row of dueDischarges) {
    await db.prepare("UPDATE discharge_tracking SET prompted_at=? WHERE id=?").run(now, row.id);
    // A ward can belong to MULTIPLE PRE blocks — prompt every block that contains it,
    // and push to every distinct PRE user across those blocks (no duplicates).
    const preBlocks = await db.prepare("SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?")
      .all<{ pre_block_id: number }>(row.ward_id);
    if (preBlocks.length > 0) {
      const blockIds = preBlocks.map(b => b.pre_block_id);
      emitUpdate("discharge:prompt", { admissionId: row.admission_id, bedId: row.bed_id, wardId: row.ward_id }, {
        pre: blockIds.map(String),
      });
      const preUsers = await db.prepare(
        "SELECT DISTINCT user_id FROM user_pre_blocks WHERE pre_block_id = ANY(?)"
      ).all<{ user_id: number }>(blockIds);
      for (const u of preUsers)
        void pushToUser(u.user_id, {
          title: "Start Discharge?", body: "A planned discharge is due — open BedFlow to start it.",
          tag: "discharge-prompt", requireInteraction: true,
        });
    } else {
      emitUpdate("discharge:prompt", { admissionId: row.admission_id, bedId: row.bed_id, wardId: row.ward_id });
    }
  }

  // SLA delay sweep — a phase becomes Delayed by the clock passing its deadline,
  // with nobody touching it, so without this nothing would tell the UI to
  // re-render. Emit only on the transition into delay: `notifiedDelays` holds the
  // admissions already announced, so a stuck phase doesn't re-fire every 30s.
  {
    const config = await listPhaseConfig();
    const running = await db.prepare(
      `SELECT dt.*, pa.ward_id, pa.bed_id, pa.id AS admission_id
       FROM discharge_tracking dt
       JOIN patient_admissions pa ON pa.id = dt.admission_id
       WHERE dt.status IN ('DISCHARGE_INITIATED','IN_PROGRESS') AND pa.status='ACTIVE'`
    ).all<Record<string, unknown>>();

    const stillDelayed = new Set<number>();
    for (const row of running) {
      const wf = computeWorkflow(row as never, config, now);
      if (!wf || wf.delayed.length === 0) continue;
      const admissionId = Number(row.admission_id);
      stillDelayed.add(admissionId);
      if (notifiedDelays.has(admissionId)) continue;   // already announced

      notifiedDelays.add(admissionId);
      const wardId = Number(row.ward_id);
      const preBlocks = await db.prepare("SELECT pre_block_id FROM pre_block_wards WHERE ward_id=?")
        .all<{ pre_block_id: number }>(wardId);
      const ward = await db.prepare("SELECT station_id FROM wards WHERE id=?")
        .get<{ station_id: number | null }>(wardId);
      emitUpdate("discharge:update", {
        type: "delay", admissionId, bedId: Number(row.bed_id), wardId,
        delayed: wf.delayed, eta: wf.eta,
      }, {
        wardId,
        pre: preBlocks.map(b => String(b.pre_block_id)),
        stationId: ward?.station_id ?? undefined,
      });
    }
    // Drop admissions that recovered or finished, so a later delay re-announces.
    for (const id of notifiedDelays) if (!stillDelayed.has(id)) notifiedDelays.delete(id);
  }

  // COO reminders at the top of each 3-hour slot
  for (const r of COO_REMINDERS) {
    if (mins === hmToMin(r)) {
      const flag = "coo:" + todayStr() + ":" + r;
      if (!lastPush.has(flag)) {
        lastPush.set(flag, now);
        const coos = await db.prepare("SELECT id FROM users WHERE role='COO'").all<{ id: number }>();
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
    void snapshotAdminDashboard();
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
