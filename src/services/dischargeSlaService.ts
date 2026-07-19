// Discharge SLA / ETA engine.
//
// The backend is the source of truth for phase status, deadlines and ETA — the
// frontend renders what this computes and never derives it itself.
//
// Phases keep the existing parallel-group model: groups 1-3 run concurrently,
// System Checkout (g4) waits on all of them, Physical Checkout (g5) runs
// alongside g4 (a patient can move to the lounge before system checkout).
// Within a group, phases unlock one at a time.

import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import type { StepKey } from "./dischargeService.js";

export interface PhaseConfig {
  id: number;
  phase_key: StepKey;
  label: string;
  department: string | null;
  expected_minutes: number;
  sort_order: number;
}

/** Parallel groups — mirrors DischargeTab.jsx GROUP_LABELS. */
export const STEP_GROUP: Record<StepKey, number> = {
  DISCHARGE_SUMMARY: 1,
  DRUG_RETURN: 2,
  PHARMACY_CLEARANCE: 2,
  PROCEDURE_RECONCILIATION: 2,
  BILLING_STARTED: 3,
  AUDIT: 3,
  BILL_READY: 3,
  PAYMENT: 3,
  SYSTEM_CHECKOUT: 4,
  PHYSICAL_CHECKOUT: 5,
};

/** Phases in group order — the sequence a phase unlocks within its own group. */
export const GROUP_STEPS: Record<number, StepKey[]> = {
  1: ["DISCHARGE_SUMMARY"],
  2: ["DRUG_RETURN", "PHARMACY_CLEARANCE", "PROCEDURE_RECONCILIATION"],
  3: ["BILLING_STARTED", "AUDIT", "BILL_READY", "PAYMENT"],
  4: ["SYSTEM_CHECKOUT"],
  5: ["PHYSICAL_CHECKOUT"],
};

export const ALL_STEPS = Object.keys(STEP_GROUP) as StepKey[];

const snake = (k: StepKey) => k.toLowerCase();
export const startedCol   = (k: StepKey) => `${snake(k)}_started_at`;
export const completedCol = (k: StepKey) => `${snake(k)}_completed_at`;
export const statusCol    = (k: StepKey) => `${snake(k)}_status`;

// ── Config (COO-editable SLAs) ───────────────────────────────────────────────
// Cached because list endpoints decorate many rows per request. Invalidated on
// every write, so a COO change takes effect on the next request.

let cache: { rows: PhaseConfig[]; at: number } | null = null;
const CACHE_MS = 30_000;

export function invalidatePhaseConfigCache() { cache = null; }

export async function listPhaseConfig(): Promise<PhaseConfig[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  const rows = await db.prepare(
    `SELECT id, phase_key, label, department, expected_minutes, sort_order
     FROM discharge_phase_config ORDER BY sort_order, id`
  ).all<PhaseConfig>();
  cache = { rows, at: Date.now() };
  return rows;
}

export async function updatePhaseConfig(opts: {
  id: number; label?: string; department?: string | null;
  expectedMinutes?: number; userId: number;
}) {
  const row = await db.prepare("SELECT * FROM discharge_phase_config WHERE id=?")
    .get<PhaseConfig>(opts.id);
  if (!row) throw new HttpError(404, "Discharge phase not found");

  const sets: string[] = [];
  const params: unknown[] = [];
  if (opts.label !== undefined)      { sets.push("label=?");            params.push(opts.label); }
  if (opts.department !== undefined) { sets.push("department=?");       params.push(opts.department); }
  if (opts.expectedMinutes !== undefined) {
    if (opts.expectedMinutes < 0) throw new HttpError(400, "Expected duration cannot be negative");
    sets.push("expected_minutes=?"); params.push(opts.expectedMinutes);
  }
  if (sets.length === 0) return { ok: true };

  sets.push("updated_at=?"); params.push(Date.now());
  params.push(opts.id);
  await db.prepare(`UPDATE discharge_phase_config SET ${sets.join(", ")} WHERE id=?`).run(...params);
  invalidatePhaseConfigCache();
  await audit(opts.userId, "discharge_phase_config_update", "discharge_phase_config", {
    id: opts.id, phase: row.phase_key,
    label: opts.label, department: opts.department, expectedMinutes: opts.expectedMinutes,
  });
  return { ok: true };
}

export async function reorderPhaseConfig(opts: { id: number; direction: "up" | "down"; userId: number }) {
  const row = await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE id=?")
    .get<{ id: number; sort_order: number }>(opts.id);
  if (!row) throw new HttpError(404, "Discharge phase not found");

  const neighbour = opts.direction === "up"
    ? await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order)
    : await db.prepare("SELECT id, sort_order FROM discharge_phase_config WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1").get<{ id: number; sort_order: number }>(row.sort_order);
  if (!neighbour) return { ok: true };

  await db.transaction(async () => {
    await db.prepare("UPDATE discharge_phase_config SET sort_order=? WHERE id=?").run(neighbour.sort_order, opts.id);
    await db.prepare("UPDATE discharge_phase_config SET sort_order=? WHERE id=?").run(row.sort_order, neighbour.id);
  });
  invalidatePhaseConfigCache();
  return { ok: true };
}

// ── Workflow computation ─────────────────────────────────────────────────────

export type PhaseState = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "NOT_APPLICABLE" | "DELAYED";

export interface PhaseView {
  key: StepKey;
  label: string;
  department: string | null;
  group: number;
  expectedMinutes: number;
  state: PhaseState;
  startedAt: number | null;
  completedAt: number | null;
  deadline: number | null;
  /** Minutes past deadline; 0 when on time. */
  overdueMinutes: number;
  /** Minutes the phase actually took, once completed. */
  actualMinutes: number | null;
}

export interface WorkflowView {
  phases: PhaseView[];
  /** Phases currently open and started — the ones being worked right now. */
  current: StepKey[];
  delayed: StepKey[];
  /** Overall: ON_TIME while nothing is past its deadline. */
  state: "ON_TIME" | "DELAYED" | "COMPLETED";
  /** Estimated discharge time (epoch ms), null once complete. */
  eta: number | null;
  etaMinutes: number | null;
  done: number;
  total: number;
  pct: number;
}

type TrackingRow = Record<string, unknown> & { status?: string };

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Compute the full workflow view for one tracking row.
 * `now` is injectable so the scheduler and tests can evaluate at a fixed instant.
 */
export function computeWorkflow(
  tracking: TrackingRow | null | undefined,
  config: PhaseConfig[],
  now = Date.now(),
): WorkflowView | null {
  if (!tracking) return null;
  const live = ["DISCHARGE_INITIATED", "IN_PROGRESS"].includes(String(tracking.status));
  const finished = tracking.status === "COMPLETED";
  if (!live && !finished) return null;   // PLANNED / CANCELLED have no running workflow

  const byKey = new Map(config.map(c => [c.phase_key, c]));

  const phases: PhaseView[] = ALL_STEPS.map((key) => {
    const cfg = byKey.get(key);
    const expectedMinutes = cfg?.expected_minutes ?? 15;
    const rawStatus = String(tracking[statusCol(key)] ?? "PENDING");
    const startedAt = num(tracking[startedCol(key)]);
    const completedAt = num(tracking[completedCol(key)]);
    const deadline = startedAt !== null ? startedAt + expectedMinutes * 60_000 : null;

    let state: PhaseState;
    if (rawStatus === "NOT_APPLICABLE") state = "NOT_APPLICABLE";
    else if (rawStatus === "COMPLETED") state = "COMPLETED";
    else if (startedAt === null) state = "NOT_STARTED";
    else if (deadline !== null && now > deadline) state = "DELAYED";
    else state = "IN_PROGRESS";

    const overdueMinutes = state === "DELAYED" && deadline !== null
      ? Math.floor((now - deadline) / 60_000) : 0;
    const actualMinutes = completedAt !== null && startedAt !== null
      ? Math.max(0, Math.round((completedAt - startedAt) / 60_000)) : null;

    return {
      key,
      label: cfg?.label ?? key,
      department: cfg?.department ?? null,
      group: STEP_GROUP[key],
      expectedMinutes, state, startedAt, completedAt, deadline,
      overdueMinutes, actualMinutes,
    };
  });

  const isDone = (p: PhaseView) => p.state === "COMPLETED" || p.state === "NOT_APPLICABLE";

  // Remaining minutes for a group: the in-flight phase contributes only its
  // leftover time, phases that haven't started contribute their full SLA.
  const groupRemaining = (group: number): number => {
    let mins = 0;
    for (const p of phases) {
      if (p.group !== group || isDone(p)) continue;
      if (p.startedAt !== null && p.deadline !== null) {
        mins += Math.max(0, Math.ceil((p.deadline - now) / 60_000));
      } else {
        mins += p.expectedMinutes;
      }
    }
    return mins;
  };

  // Critical path: groups 1-3 overlap, then checkout. g5 runs alongside g4.
  const parallelHead = Math.max(groupRemaining(1), groupRemaining(2), groupRemaining(3));
  const tail = Math.max(groupRemaining(4), groupRemaining(5));
  const etaMinutes = parallelHead + tail;

  const counted = phases.filter(p => p.state !== "NOT_APPLICABLE");
  const done = counted.filter(p => p.state === "COMPLETED").length;
  const total = counted.length;
  const delayed = phases.filter(p => p.state === "DELAYED").map(p => p.key);
  const current = phases.filter(p => p.state === "IN_PROGRESS" || p.state === "DELAYED").map(p => p.key);

  return {
    phases, current, delayed,
    state: finished ? "COMPLETED" : delayed.length > 0 ? "DELAYED" : "ON_TIME",
    eta: finished ? null : now + etaMinutes * 60_000,
    etaMinutes: finished ? null : etaMinutes,
    done, total,
    pct: total ? Math.round((done / total) * 100) : 0,
  };
}

/** Attach `workflow` to a tracking row (or to a row that embeds one). */
export function withWorkflow<T extends TrackingRow>(row: T, config: PhaseConfig[], now = Date.now()) {
  return { ...row, workflow: computeWorkflow(row, config, now) };
}

/** Decorate a list of rows with one config fetch. */
export async function decorateMany<T extends TrackingRow>(rows: T[]) {
  const config = await listPhaseConfig();
  const now = Date.now();
  return rows.map(r => withWorkflow(r, config, now));
}

// ── Phase start bookkeeping ──────────────────────────────────────────────────

/**
 * SQL fragment starting every group-leading phase. Called when a discharge is
 * initiated — groups 1, 2, 3 and 5 all open at once; group 4 (System Checkout)
 * only opens once its prerequisites clear.
 */
export function initialStartSql(now: number): { sql: string; params: unknown[] } {
  const leads: StepKey[] = ["DISCHARGE_SUMMARY", "DRUG_RETURN", "BILLING_STARTED", "PHYSICAL_CHECKOUT"];
  const sets = leads.map(k => `${startedCol(k)} = COALESCE(${startedCol(k)}, ?)`);
  return { sql: sets.join(", "), params: leads.map(() => now) };
}

/**
 * The phase that should start when `completed` finishes: the next unstarted
 * phase in the same group. System Checkout is special — it opens only when
 * every group 1-3 phase is done.
 */
export function nextPhaseToStart(completed: StepKey, tracking: TrackingRow): StepKey | null {
  const group = STEP_GROUP[completed];
  const siblings = GROUP_STEPS[group] ?? [];
  const idx = siblings.indexOf(completed);
  const next = siblings[idx + 1];
  if (next && tracking[startedCol(next)] == null) return next;

  // Nothing left in this group — does that unlock System Checkout?
  if (tracking[startedCol("SYSTEM_CHECKOUT")] == null) {
    const blockers = [...GROUP_STEPS[1], ...GROUP_STEPS[2], ...GROUP_STEPS[3]];
    const allClear = blockers.every((k) => {
      const v = k === completed ? "COMPLETED" : String(tracking[statusCol(k)] ?? "PENDING");
      return v === "COMPLETED" || v === "NOT_APPLICABLE";
    });
    if (allClear) return "SYSTEM_CHECKOUT";
  }
  return null;
}
