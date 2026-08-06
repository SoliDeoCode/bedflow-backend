import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { startOfDayIST } from "../config/domain.js";
import { audit } from "./auditService.js";
import { emitComplaintEvent } from "../websocket/io.js";

/* ═══════════════════════════════════════════════════════════════════════════
   Patient Welfare Officer (PWO) complaint management.

   Two callers with very different trust levels:
     • PWO staff  — JWT-authenticated, role-gated in routes/pwo.ts.
     • Patient    — UNAUTHENTICATED (the patient portal identifies a person by
                    a 6-digit IP number and nothing else). Everything reachable
                    from the patient side is therefore deliberately narrow:
                    create-only, read-only-own, and never internal notes.

   Every mutation emits a targeted, self-describing websocket payload — enough
   for a client to patch one row and adjust its counters in place. Nothing here
   ever tells a client to "go refetch"; see emitComplaintEvent in websocket/io.ts.
   ═══════════════════════════════════════════════════════════════════════════ */

export const COMPLAINT_STATUSES = ["OPEN", "ACCEPTED", "UNDER_REVIEW", "RESOLVED", "CLOSED"] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Strictly linear and forward-only — a complaint can never be reopened, and
 *  never skips a stage. Keyed by current status → the single legal next one.
 *  OPEN is absent on purpose: leaving OPEN happens only via acceptComplaint(),
 *  which is a different operation (it also claims ownership, atomically). */
const NEXT_STATUS: Partial<Record<ComplaintStatus, ComplaintStatus>> = {
  ACCEPTED: "UNDER_REVIEW",
  UNDER_REVIEW: "RESOLVED",
  RESOLVED: "CLOSED",
};

/** Complaints a PWO still has to do something about. Used by both the "Pending"
 *  card and the high-priority/critical cards (a resolved critical complaint is
 *  not an outstanding critical complaint). */
const PENDING_STATUSES = "('OPEN','ACCEPTED','UNDER_REVIEW')";

const COOLDOWN_MS = 5 * 60 * 1000;

/** One canonical projection, reused by the queue, the detail view AND every
 *  websocket payload — so a client patching a row from an event never ends up
 *  with a different shape than the row it originally rendered from REST. */
const COMPLAINT_SELECT = `
  SELECT c.id, c.complaint_code, c.admission_id, c.ip_last6,
         c.description, c.status,
         c.category_id,  cat.code  AS category_code,  cat.label  AS category_label,
         c.priority_id,  pri.code  AS priority_code,  pri.label  AS priority_label, pri.rank AS priority_rank,
         c.owner_pwo_id, owner.name AS owner_name,
         c.ward_id, c.ward_name, c.floor_id, c.floor_name,
         c.bed_id, c.bed_name, c.room_type,
         c.department_id, c.department_name,
         c.admitted_at, c.created_at, c.updated_at,
         c.accepted_at, c.resolved_at, c.closed_at
    FROM complaints c
    JOIN complaint_categories cat ON cat.id = c.category_id
    JOIN complaint_priorities pri ON pri.id = c.priority_id
    LEFT JOIN users owner         ON owner.id = c.owner_pwo_id`;

/** pg returns BIGINT/BIGSERIAL as strings (they exceed JS's safe integer range
 *  in the general case). Every id and epoch-ms column below goes through here so
 *  the API contract is numbers, not a mix of numbers and numeric strings that
 *  would break === comparisons on the client. */
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

type RawComplaint = Record<string, unknown>;

function shapeComplaint(r: RawComplaint) {
  return {
    id: num(r.id)!,
    complaintCode: r.complaint_code as string,
    admissionId: num(r.admission_id),
    ipLast6: r.ip_last6 as string | null,
    description: r.description as string,
    status: r.status as ComplaintStatus,
    category: { id: num(r.category_id), code: r.category_code as string, label: r.category_label as string },
    priority: { id: num(r.priority_id), code: r.priority_code as string, label: r.priority_label as string, rank: num(r.priority_rank) },
    ownerPwoId: num(r.owner_pwo_id),
    ownerName: (r.owner_name as string | null) ?? null,
    location: {
      wardId: num(r.ward_id), wardName: (r.ward_name as string | null) ?? null,
      floorId: num(r.floor_id), floorName: (r.floor_name as string | null) ?? null,
      bedId: num(r.bed_id), bedName: (r.bed_name as string | null) ?? null,
      roomType: (r.room_type as string | null) ?? null,
      departmentId: num(r.department_id), departmentName: (r.department_name as string | null) ?? null,
    },
    admittedAt: num(r.admitted_at),
    createdAt: num(r.created_at),
    updatedAt: num(r.updated_at),
    acceptedAt: num(r.accepted_at),
    resolvedAt: num(r.resolved_at),
    closedAt: num(r.closed_at),
  };
}

async function getComplaintRow(id: number) {
  const r = await db.prepare(`${COMPLAINT_SELECT} WHERE c.id = ?`).get<RawComplaint>(id);
  return r ? shapeComplaint(r) : null;
}

/** Loads a complaint and asserts the acting PWO owns it. Ownership is the whole
 *  authorization model on the write side: any active PWO can SEE everything, but
 *  only the one who accepted a complaint can change it. */
async function requireOwned(complaintId: number, pwoUserId: number) {
  const row = await db.prepare(
    "SELECT c.id, c.status, c.owner_pwo_id, u.name AS owner_name FROM complaints c LEFT JOIN users u ON u.id=c.owner_pwo_id WHERE c.id=?"
  ).get<{ id: string; status: ComplaintStatus; owner_pwo_id: number | null; owner_name: string | null }>(complaintId);
  if (!row) throw new HttpError(404, "Complaint not found");
  if (row.owner_pwo_id == null)
    throw new HttpError(409, "Accept this complaint before working on it.");
  if (row.owner_pwo_id !== pwoUserId)
    throw new HttpError(403, `This complaint is assigned to ${row.owner_name ?? "another officer"}.`);
  return row;
}

// ── Lookups ────────────────────────────────────────────────────────────────
export async function listCategories() {
  return db.prepare(
    "SELECT id, code, label FROM complaint_categories WHERE active ORDER BY sort_order, label"
  ).all<{ id: number; code: string; label: string }>();
}

export async function listPriorities() {
  return db.prepare(
    "SELECT id, code, label, rank FROM complaint_priorities WHERE active ORDER BY rank"
  ).all<{ id: number; code: string; label: string; rank: number }>();
}

// ── Patient side ───────────────────────────────────────────────────────────

/** The single most recent admission for this IP number, plus everything the
 *  complaint snapshot needs. Returns the admission even when DISCHARGED so the
 *  caller can distinguish "unknown number" from "no longer admitted" — the two
 *  need different messages in the portal. */
async function admissionForIp(ipLast6: string) {
  return db.prepare(`
    SELECT pa.id AS admission_id, pa.ip_last6, pa.status AS admission_status, pa.admitted_at,
           pa.department_id, pa.department_name,
           bd.id AS bed_id, bd.bed_name,
           w.id  AS ward_id, w.name AS ward_name, w.room_type, w.floor_id,
           f.name AS floor_name
      FROM patient_admissions pa
      LEFT JOIN bed_details bd ON bd.id = pa.bed_id
      LEFT JOIN wards w        ON w.id  = bd.ward_id
      LEFT JOIN floors f       ON f.id  = w.floor_id
     WHERE pa.ip_last6 = ?
     ORDER BY pa.admitted_at DESC
     LIMIT 1`
  ).get<Record<string, unknown>>(ipLast6);
}

/** Patient-submitted complaint. Everything except category + description is
 *  captured automatically — the patient never selects a ward/bed/department,
 *  and cannot set priority (it always starts MEDIUM). */
export async function createComplaint(opts: { ipLast6: string; categoryCode: string; description: string }) {
  const ipLast6 = (opts.ipLast6 ?? "").trim();
  if (!/^\d{6}$/.test(ipLast6)) throw new HttpError(400, "Enter your 6-digit patient number.");

  const description = (opts.description ?? "").trim();
  if (!description) throw new HttpError(400, "Please describe your complaint.");
  if (description.length > 4000) throw new HttpError(400, "Complaint is too long (max 4000 characters).");

  const category = await db.prepare(
    "SELECT id, code, label FROM complaint_categories WHERE code=? AND active"
  ).get<{ id: number; code: string; label: string }>(opts.categoryCode);
  if (!category) throw new HttpError(400, "Please choose a valid category.");

  const adm = await admissionForIp(ipLast6);
  if (!adm) throw new HttpError(404, "We couldn't find that patient number.");
  if (adm.admission_status !== "ACTIVE")
    throw new HttpError(403, "This admission has been discharged. Please contact the Patient Welfare desk directly.");

  const admissionId = num(adm.admission_id)!;
  const now = Date.now();

  // Rate limit, not a data invariant — checked inside the same transaction as
  // the insert so two taps of the same button can't both slip through.
  const created = await db.transaction(async () => {
    const last = await db.prepare(
      "SELECT created_at FROM complaints WHERE admission_id=? ORDER BY created_at DESC LIMIT 1"
    ).get<{ created_at: string }>(admissionId);
    if (last) {
      const elapsed = now - num(last.created_at)!;
      if (elapsed < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
        throw new HttpError(429, `Please wait ${Math.ceil(wait / 60)} more minute(s) before sending another complaint.`);
      }
    }

    const medium = await db.prepare("SELECT id FROM complaint_priorities WHERE code='MEDIUM'").get<{ id: number }>();

    const inserted = await db.prepare(`
      INSERT INTO complaints
        (admission_id, ip_last6, category_id, priority_id, description, status,
         ward_id, ward_name, floor_id, floor_name, bed_id, bed_name, room_type,
         department_id, department_name, admitted_at, created_at, updated_at)
      VALUES (?,?,?,?,?,'OPEN',?,?,?,?,?,?,?,?,?,?,?,?)
      RETURNING id`
    ).get<{ id: string }>(
      admissionId, ipLast6, category.id, medium!.id, description,
      adm.ward_id ?? null, adm.ward_name ?? null,
      adm.floor_id ?? null, adm.floor_name ?? null,
      adm.bed_id ?? null, adm.bed_name ?? null, adm.room_type ?? null,
      adm.department_id ?? null, adm.department_name ?? null,
      adm.admitted_at ?? null, now, now,
    );

    const id = num(inserted!.id)!;
    await db.prepare(
      "INSERT INTO complaint_status_history (complaint_id, from_status, to_status, changed_by, changed_at, note) VALUES (?,?,?,?,?,?)"
    ).run(id, null, "OPEN", null, now, "Submitted by patient");
    return id;
  });

  const row = (await getComplaintRow(created))!;
  // New row for every PWO's queue — carries the whole complaint because there is
  // nothing to patch yet; the client prepends it and bumps its Open/Today counters.
  emitComplaintEvent("complaint:created", { complaint: row }, { admissionId });
  await audit(null, "complaint_create", String(created), { ipLast6, category: category.code, admissionId });
  return row;
}

/** Patient's own complaint list. Only notes a PWO explicitly shared are ever
 *  included — see is_visible_to_patient on complaint_notes. */
export async function complaintsForPatient(ipLast6: string) {
  const rows = await db.prepare(
    `${COMPLAINT_SELECT} WHERE c.ip_last6 = ? ORDER BY c.created_at DESC LIMIT 50`
  ).all<RawComplaint>(ipLast6);
  const complaints = rows.map(shapeComplaint);
  if (complaints.length === 0) return [];

  const ids = complaints.map(c => c.id);
  const notes = await db.prepare(
    `SELECT n.id, n.complaint_id, n.note, n.created_at, u.name AS author_name
       FROM complaint_notes n LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.complaint_id = ANY(?) AND n.is_visible_to_patient = true
      ORDER BY n.created_at`
  ).all<Record<string, unknown>>(ids);

  const history = await db.prepare(
    `SELECT complaint_id, from_status, to_status, changed_at
       FROM complaint_status_history WHERE complaint_id = ANY(?) ORDER BY changed_at`
  ).all<Record<string, unknown>>(ids);

  return complaints.map(c => ({
    ...c,
    // Patients see status + timeline + shared notes. Never the owning officer's
    // identity or internal working notes.
    ownerPwoId: undefined, ownerName: undefined,
    notes: notes.filter(n => num(n.complaint_id) === c.id)
      .map(n => ({ id: num(n.id), note: n.note as string, authorName: n.author_name as string | null, createdAt: num(n.created_at) })),
    timeline: history.filter(h => num(h.complaint_id) === c.id)
      .map(h => ({ from: h.from_status as string | null, to: h.to_status as string, at: num(h.changed_at) })),
  }));
}

// ── PWO side: lifecycle ────────────────────────────────────────────────────

/** Claim an OPEN complaint. The conditional UPDATE is the entire race control:
 *  two PWOs tapping Accept at the same instant both run this, Postgres serializes
 *  them, and the second one matches zero rows because status is no longer OPEN.
 *  No SELECT-then-UPDATE window exists for them to race inside. */
export async function acceptComplaint(complaintId: number, pwoUserId: number) {
  const now = Date.now();
  const res = await db.prepare(
    `UPDATE complaints
        SET status='ACCEPTED', owner_pwo_id=?, accepted_at=?, updated_at=?
      WHERE id=? AND status='OPEN' AND owner_pwo_id IS NULL`
  ).run(pwoUserId, now, now, complaintId);

  if (res.changes === 0) {
    const cur = await db.prepare(
      "SELECT c.status, u.name AS owner_name FROM complaints c LEFT JOIN users u ON u.id=c.owner_pwo_id WHERE c.id=?"
    ).get<{ status: string; owner_name: string | null }>(complaintId);
    if (!cur) throw new HttpError(404, "Complaint not found");
    throw new HttpError(409, `Already accepted by ${cur.owner_name ?? "another officer"}.`);
  }

  await db.prepare(
    "INSERT INTO complaint_status_history (complaint_id, from_status, to_status, changed_by, changed_at) VALUES (?,?,?,?,?)"
  ).run(complaintId, "OPEN", "ACCEPTED", pwoUserId, now);

  const row = (await getComplaintRow(complaintId))!;
  // fromStatus lets every other PWO's dashboard do exact counter math
  // (Open −1, Accepted +1) without recomputing anything server-side.
  emitComplaintEvent("complaint:accepted", {
    complaintId, fromStatus: "OPEN", status: "ACCEPTED",
    ownerPwoId: row.ownerPwoId, ownerName: row.ownerName,
    acceptedAt: row.acceptedAt, updatedAt: row.updatedAt,
  }, { admissionId: row.admissionId ?? undefined });
  await audit(pwoUserId, "complaint_accept", String(complaintId), {});
  return row;
}

/** Advance one stage. `toStatus` is required from the client and validated
 *  against NEXT_STATUS rather than inferred, so a stale UI can never silently
 *  skip a stage it didn't know about. */
export async function advanceStatus(opts: { complaintId: number; toStatus: ComplaintStatus; pwoUserId: number; note?: string | null }) {
  const owned = await requireOwned(opts.complaintId, opts.pwoUserId);
  const expected = NEXT_STATUS[owned.status];
  if (!expected)
    throw new HttpError(409, `A ${owned.status.toLowerCase().replace("_", " ")} complaint cannot be changed further.`);
  if (opts.toStatus !== expected)
    throw new HttpError(409, `This complaint must move to ${expected} next.`);

  const now = Date.now();
  const stamp = expected === "RESOLVED" ? ", resolved_at=?" : expected === "CLOSED" ? ", closed_at=?" : "";
  const params: unknown[] = [expected, now];
  if (stamp) params.push(now);
  params.push(opts.complaintId, owned.status);

  const res = await db.prepare(
    `UPDATE complaints SET status=?, updated_at=?${stamp} WHERE id=? AND status=?`
  ).run(...params);
  if (res.changes === 0)
    throw new HttpError(409, "This complaint was just updated by someone else. Refreshing.");

  const note = (opts.note ?? "").trim() || null;
  await db.prepare(
    "INSERT INTO complaint_status_history (complaint_id, from_status, to_status, changed_by, changed_at, note) VALUES (?,?,?,?,?,?)"
  ).run(opts.complaintId, owned.status, expected, opts.pwoUserId, now, note);

  const row = (await getComplaintRow(opts.complaintId))!;
  emitComplaintEvent("complaint:status_changed", {
    complaintId: opts.complaintId, fromStatus: owned.status, status: expected,
    updatedBy: opts.pwoUserId, updatedByName: row.ownerName,
    updatedAt: row.updatedAt, resolvedAt: row.resolvedAt, closedAt: row.closedAt,
  }, { admissionId: row.admissionId ?? undefined });
  await audit(opts.pwoUserId, "complaint_status", String(opts.complaintId), { from: owned.status, to: expected });
  return row;
}

export async function setPriority(opts: { complaintId: number; priorityCode: string; pwoUserId: number }) {
  await requireOwned(opts.complaintId, opts.pwoUserId);
  const pri = await db.prepare(
    "SELECT id, code, label, rank FROM complaint_priorities WHERE code=? AND active"
  ).get<{ id: number; code: string; label: string; rank: number }>(opts.priorityCode);
  if (!pri) throw new HttpError(400, "Unknown priority");

  const prev = await db.prepare(
    "SELECT p.code FROM complaints c JOIN complaint_priorities p ON p.id=c.priority_id WHERE c.id=?"
  ).get<{ code: string }>(opts.complaintId);

  const now = Date.now();
  await db.prepare("UPDATE complaints SET priority_id=?, updated_at=? WHERE id=?").run(pri.id, now, opts.complaintId);

  const row = (await getComplaintRow(opts.complaintId))!;
  emitComplaintEvent("complaint:priority_changed", {
    complaintId: opts.complaintId,
    fromPriority: prev?.code ?? null,
    priority: { id: pri.id, code: pri.code, label: pri.label, rank: pri.rank },
    updatedAt: now,
  });
  await audit(opts.pwoUserId, "complaint_priority", String(opts.complaintId), { from: prev?.code, to: pri.code });
  return row;
}

export async function addNote(opts: { complaintId: number; pwoUserId: number; note: string; visibleToPatient: boolean }) {
  await requireOwned(opts.complaintId, opts.pwoUserId);
  const note = (opts.note ?? "").trim();
  if (!note) throw new HttpError(400, "Note cannot be empty.");
  if (note.length > 4000) throw new HttpError(400, "Note is too long (max 4000 characters).");

  const now = Date.now();
  const inserted = await db.prepare(
    "INSERT INTO complaint_notes (complaint_id, author_user_id, note, is_visible_to_patient, created_at) VALUES (?,?,?,?,?) RETURNING id"
  ).get<{ id: string }>(opts.complaintId, opts.pwoUserId, note, opts.visibleToPatient, now);

  const author = await db.prepare("SELECT name FROM users WHERE id=?").get<{ name: string }>(opts.pwoUserId);
  const shaped = {
    id: num(inserted!.id), note, authorName: author?.name ?? null,
    visibleToPatient: opts.visibleToPatient, createdAt: now,
  };

  const adm = await db.prepare("SELECT admission_id FROM complaints WHERE id=?").get<{ admission_id: number }>(opts.complaintId);
  emitComplaintEvent("complaint:note_added", { complaintId: opts.complaintId, note: shaped },
    // Only reaches the patient's own socket room when it was actually shared.
    opts.visibleToPatient ? { admissionId: adm?.admission_id } : undefined);
  return shaped;
}

// ── PWO side: reads ────────────────────────────────────────────────────────

export async function getComplaintDetail(complaintId: number) {
  const row = await getComplaintRow(complaintId);
  if (!row) throw new HttpError(404, "Complaint not found");

  const notes = await db.prepare(
    `SELECT n.id, n.note, n.is_visible_to_patient, n.created_at, u.name AS author_name
       FROM complaint_notes n LEFT JOIN users u ON u.id=n.author_user_id
      WHERE n.complaint_id=? ORDER BY n.created_at`
  ).all<Record<string, unknown>>(complaintId);

  const history = await db.prepare(
    `SELECT h.from_status, h.to_status, h.changed_at, h.note, u.name AS changed_by_name
       FROM complaint_status_history h LEFT JOIN users u ON u.id=h.changed_by
      WHERE h.complaint_id=? ORDER BY h.changed_at`
  ).all<Record<string, unknown>>(complaintId);

  // Live admission context for the detail panel. Read fresh from
  // patient_admissions rather than from the complaint's own snapshot columns:
  // the snapshot deliberately freezes *where the complaint happened*, whereas
  // this answers "who is this patient and are they still here right now",
  // which the officer needs while actually working the case.
  const adm = await db.prepare(
    `SELECT pa.status AS admission_status, pa.admission_type, pa.consultant_name,
            pa.department_name, pa.admitted_at, pa.discharged_at,
            bd.bed_name AS current_bed, w.name AS current_ward
       FROM patient_admissions pa
       LEFT JOIN bed_details bd ON bd.id = pa.bed_id
       LEFT JOIN wards w        ON w.id  = bd.ward_id
      WHERE pa.id = ?`
  ).get<Record<string, unknown>>(row.admissionId);

  return {
    ...row,
    admission: adm ? {
      status: adm.admission_status as string,
      admissionType: (adm.admission_type as string | null) ?? null,
      consultantName: (adm.consultant_name as string | null) ?? null,
      departmentName: (adm.department_name as string | null) ?? null,
      admittedAt: num(adm.admitted_at),
      dischargedAt: num(adm.discharged_at),
      currentWard: (adm.current_ward as string | null) ?? null,
      currentBed: (adm.current_bed as string | null) ?? null,
    } : null,
    notes: notes.map(n => ({
      id: num(n.id), note: n.note as string, authorName: n.author_name as string | null,
      visibleToPatient: n.is_visible_to_patient as boolean, createdAt: num(n.created_at),
    })),
    timeline: history.map(h => ({
      from: h.from_status as string | null, to: h.to_status as string,
      at: num(h.changed_at), by: h.changed_by_name as string | null, note: h.note as string | null,
    })),
  };
}

export interface QueueFilters {
  status?: string; categoryId?: number; priorityId?: number;
  wardId?: number; floorId?: number; departmentId?: number;
  ownerPwoId?: number; unassigned?: boolean;
  from?: number; to?: number;
  search?: string;
  sort?: string; page?: number; pageSize?: number;
}

/** Paginated queue. Every filter is optional and composes; all of them are
 *  index-backed (see the migration). Returns a total so the client can render
 *  pagination without a second count request. */
export async function listComplaints(f: QueueFilters) {
  const where: string[] = [];
  const params: unknown[] = [];

  // "ACTIVE" is a group, not a stored status: everything still needing work.
  // It's the queue's default because officers work the live pile — closed and
  // resolved complaints are history and were pushing real work down the list.
  // Same set as PENDING_STATUSES so the queue and the dashboard counters can
  // never drift apart.
  if (f.status === "ACTIVE") { where.push(`c.status IN ${PENDING_STATUSES}`); }
  else if (f.status)  { where.push("c.status = ?");        params.push(f.status); }
  if (f.categoryId)   { where.push("c.category_id = ?");   params.push(f.categoryId); }
  if (f.priorityId)   { where.push("c.priority_id = ?");   params.push(f.priorityId); }
  if (f.wardId)       { where.push("c.ward_id = ?");       params.push(f.wardId); }
  if (f.floorId)      { where.push("c.floor_id = ?");      params.push(f.floorId); }
  if (f.departmentId) { where.push("c.department_id = ?"); params.push(f.departmentId); }
  if (f.ownerPwoId)   { where.push("c.owner_pwo_id = ?");  params.push(f.ownerPwoId); }
  if (f.unassigned)     where.push("c.owner_pwo_id IS NULL");
  if (f.from)         { where.push("c.created_at >= ?");   params.push(f.from); }
  if (f.to)           { where.push("c.created_at < ?");    params.push(f.to); }

  // Search covers the three things staff actually have in hand: the complaint
  // code a patient quotes, the IP number, or a word from the complaint itself.
  // (There is no patient name column anywhere in BedFlow to search on.)
  if (f.search) {
    const q = f.search.trim();
    if (q) {
      where.push("(c.complaint_code ILIKE ? OR c.ip_last6 ILIKE ? OR c.description ILIKE ?)");
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  // Whitelisted — never interpolate a client string into ORDER BY.
  const SORTS: Record<string, string> = {
    newest: "c.created_at DESC",
    oldest: "c.created_at ASC",
    priority: "pri.rank DESC, c.created_at ASC",
    updated: "c.updated_at DESC",
  };
  const orderSql = SORTS[f.sort ?? "newest"] ?? SORTS.newest;

  const pageSize = Math.min(Math.max(f.pageSize ?? 25, 1), 100);
  const page = Math.max(f.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const rows = await db.prepare(
    `${COMPLAINT_SELECT} ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
  ).all<RawComplaint>(...params, pageSize, offset);

  const totalRow = await db.prepare(
    `SELECT COUNT(*)::int AS n FROM complaints c ${whereSql}`
  ).get<{ n: number }>(...params);

  return {
    complaints: rows.map(shapeComplaint),
    total: totalRow?.n ?? 0,
    page, pageSize,
  };
}

/** All ten dashboard cards in a single pass over the table. */
export async function dashboardStats() {
  const dayStart = startOfDayIST();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;

  const r = await db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE c.status='OPEN')::int                                        AS open,
      COUNT(*) FILTER (WHERE c.status='ACCEPTED')::int                                    AS accepted,
      COUNT(*) FILTER (WHERE c.status='UNDER_REVIEW')::int                                AS under_review,
      COUNT(*) FILTER (WHERE c.resolved_at >= ? AND c.resolved_at < ?)::int               AS resolved_today,
      COUNT(*) FILTER (WHERE c.closed_at   >= ? AND c.closed_at   < ?)::int               AS closed_today,
      COUNT(*) FILTER (WHERE p.code='HIGH'     AND c.status IN ${PENDING_STATUSES})::int   AS high_priority,
      COUNT(*) FILTER (WHERE p.code='CRITICAL' AND c.status IN ${PENDING_STATUSES})::int   AS critical,
      COUNT(*) FILTER (WHERE c.created_at >= ? AND c.created_at < ?)::int                 AS today_total,
      COUNT(*) FILTER (WHERE c.status IN ${PENDING_STATUSES})::int                        AS pending,
      AVG(c.resolved_at - c.created_at) FILTER (WHERE c.resolved_at IS NOT NULL)          AS avg_resolution_ms,
      AVG(c.accepted_at - c.created_at) FILTER (WHERE c.accepted_at IS NOT NULL)          AS avg_acceptance_ms
    FROM complaints c JOIN complaint_priorities p ON p.id = c.priority_id`
  ).get<Record<string, unknown>>(dayStart, dayEnd, dayStart, dayEnd, dayStart, dayEnd);

  return {
    open: Number(r?.open ?? 0),
    accepted: Number(r?.accepted ?? 0),
    underReview: Number(r?.under_review ?? 0),
    resolvedToday: Number(r?.resolved_today ?? 0),
    closedToday: Number(r?.closed_today ?? 0),
    highPriority: Number(r?.high_priority ?? 0),
    critical: Number(r?.critical ?? 0),
    todayTotal: Number(r?.today_total ?? 0),
    pending: Number(r?.pending ?? 0),
    avgResolutionMs: num(r?.avg_resolution_ms),
    avgAcceptanceMs: num(r?.avg_acceptance_ms),
  };
}

/** Chart datasets. `days` bounds the trend series; the group-bys are unbounded
 *  because management asks "which ward complains most" over all time. */
export async function charts(days = 30) {
  const since = startOfDayIST() - (days - 1) * 24 * 60 * 60 * 1000;

  // to_timestamp(ms/1000) then shift to IST so day/hour buckets line up with
  // the hospital's own calendar rather than UTC.
  const IST = `(to_timestamp(c.created_at / 1000.0) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;

  const groupBy = async (col: string, label: string) =>
    db.prepare(
      `SELECT COALESCE(${col}, 'Unspecified') AS key, COUNT(*)::int AS n
         FROM complaints c ${label === "category" ? "JOIN complaint_categories cat ON cat.id=c.category_id" : ""}
        GROUP BY 1 ORDER BY n DESC LIMIT 20`
    ).all<{ key: string; n: number }>();

  const [byCategory, byWard, byFloor, byDepartment] = await Promise.all([
    groupBy("cat.label", "category"),
    groupBy("c.ward_name", "ward"),
    groupBy("c.floor_name", "floor"),
    groupBy("c.department_name", "department"),
  ]);

  const byHour = await db.prepare(
    `SELECT EXTRACT(HOUR FROM ${IST})::int AS key, COUNT(*)::int AS n
       FROM complaints c WHERE c.created_at >= ? GROUP BY 1 ORDER BY 1`
  ).all<{ key: number; n: number }>(since);

  const daily = await db.prepare(
    `SELECT to_char(${IST}, 'YYYY-MM-DD') AS key, COUNT(*)::int AS n
       FROM complaints c WHERE c.created_at >= ? GROUP BY 1 ORDER BY 1`
  ).all<{ key: string; n: number }>(since);

  const weekly = await db.prepare(
    `SELECT to_char(date_trunc('week', ${IST}), 'YYYY-MM-DD') AS key, COUNT(*)::int AS n
       FROM complaints c WHERE c.created_at >= ? GROUP BY 1 ORDER BY 1`
  ).all<{ key: string; n: number }>(startOfDayIST() - 180 * 24 * 60 * 60 * 1000);

  const monthly = await db.prepare(
    `SELECT to_char(date_trunc('month', ${IST}), 'YYYY-MM') AS key, COUNT(*)::int AS n
       FROM complaints c WHERE c.created_at >= ? GROUP BY 1 ORDER BY 1`
  ).all<{ key: string; n: number }>(startOfDayIST() - 365 * 24 * 60 * 60 * 1000);

  // Average hours-to-resolve per day — the "is our response time improving" line.
  const resolutionTrend = await db.prepare(
    `SELECT to_char((to_timestamp(c.resolved_at / 1000.0) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS key,
            ROUND(AVG(c.resolved_at - c.created_at) / 3600000.0, 2)::float8 AS hours,
            COUNT(*)::int AS n
       FROM complaints c WHERE c.resolved_at IS NOT NULL AND c.resolved_at >= ?
      GROUP BY 1 ORDER BY 1`
  ).all<{ key: string; hours: number; n: number }>(since);

  return { byCategory, byWard, byFloor, byDepartment, byHour, daily, weekly, monthly, resolutionTrend };
}

/** Complaints per PWO — the management report. LEFT JOIN from users so an
 *  officer with zero complaints still appears (otherwise "who is idle" is
 *  invisible). */
export async function perPwoReport() {
  return db.prepare(`
    SELECT u.id, u.name, u.username, u.status,
           COUNT(c.id)::int                                                    AS total,
           COUNT(c.id) FILTER (WHERE c.status IN ${PENDING_STATUSES})::int      AS pending,
           COUNT(c.id) FILTER (WHERE c.status='RESOLVED')::int                  AS resolved,
           COUNT(c.id) FILTER (WHERE c.status='CLOSED')::int                    AS closed,
           AVG(c.resolved_at - c.created_at) FILTER (WHERE c.resolved_at IS NOT NULL) AS avg_resolution_ms
      FROM users u LEFT JOIN complaints c ON c.owner_pwo_id = u.id
     WHERE u.role='PWO'
     GROUP BY u.id, u.name, u.username, u.status
     ORDER BY total DESC, u.name`
  ).all<Record<string, unknown>>().then(rows => rows.map(r => ({
    id: num(r.id), name: r.name as string, username: r.username as string, status: r.status as string,
    total: Number(r.total), pending: Number(r.pending), resolved: Number(r.resolved), closed: Number(r.closed),
    avgResolutionMs: num(r.avg_resolution_ms),
  })));
}

/** Distinct ward/floor/department values actually present on complaints —
 *  drives the queue filter dropdowns without listing wards that have never
 *  generated one. */
export async function filterOptions() {
  const [wards, floors, departments] = await Promise.all([
    db.prepare("SELECT DISTINCT ward_id AS id, ward_name AS name FROM complaints WHERE ward_id IS NOT NULL ORDER BY 2").all<{ id: number; name: string }>(),
    db.prepare("SELECT DISTINCT floor_id AS id, floor_name AS name FROM complaints WHERE floor_id IS NOT NULL ORDER BY 2").all<{ id: number; name: string }>(),
    db.prepare("SELECT DISTINCT department_id AS id, department_name AS name FROM complaints WHERE department_id IS NOT NULL ORDER BY 2").all<{ id: number; name: string }>(),
  ]);
  const pwos = await db.prepare("SELECT id, name FROM users WHERE role='PWO' ORDER BY name").all<{ id: number; name: string }>();
  return { wards, floors, departments, pwos };
}
