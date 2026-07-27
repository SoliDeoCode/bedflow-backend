import { db } from "../db/index.js";
import { HttpError } from "../middleware/error.js";
import { audit } from "./auditService.js";
import { listBeds, updateBedStatus } from "./bedDetailService.js";
import { getActiveAdmissionByBed, moveAdmission } from "./patientAdmissionService.js";
import { getTrackingByAdmission, autoCompleteDischargeForLoungeTransfer, resetPhysicalCheckoutOnReadmit } from "./dischargeService.js";

/** Beds a patient can be transferred into: operational, Vacant, not reserved.
 *  Mirrors bedDetailService.listBeds — reused rather than re-implemented. */
export async function listTransferCandidates(wardId: number) {
  return listBeds(wardId, "VACANT", "NONE", true);
}

interface BedRow {
  id: number; ward_id: number; physical_status: string; reservation_status: string;
  operational_status: boolean; ward_operational: boolean; payer_type: string | null;
  ward_is_discharge_lounge: boolean;
}

async function getBedForTransfer(bedId: number): Promise<BedRow> {
  const bed = await db.prepare(
    `SELECT bd.id, bd.ward_id, bd.physical_status, bd.reservation_status, bd.operational_status,
            bd.payer_type, w.operational AS ward_operational, w.is_discharge_lounge AS ward_is_discharge_lounge
     FROM bed_details bd JOIN wards w ON w.id = bd.ward_id
     WHERE bd.id = ?`
  ).get<BedRow>(bedId);
  if (!bed) throw new HttpError(404, "Bed not found");
  return bed;
}

/** Moves an active admission (and its in-progress discharge, if any) from one bed to another.
 *  Occupied/Occupied+Reserved beds only, and only into an operational, Vacant, non-reserved
 *  destination bed. Order of operations is chosen so that if a later step fails, the active
 *  admission is never lost track of: the new bed is occupied first, the admission is moved
 *  second, and the old bed is vacated last. A failure on the final step leaves both beds
 *  Occupied (visible, recoverable by manually vacating the old bed) rather than losing the
 *  admission's link to a bed entirely.
 *
 *  The Discharge Lounge is a valid manual destination too — moving a bed there is
 *  itself the declaration that the patient is administratively ready to leave.
 *  Regardless of whether a discharge had already been started, every step
 *  through Payment gets auto-completed and Physical Checkout completes too,
 *  leaving only System Checkout pending (see autoCompleteDischargeForLoungeTransfer
 *  below). allowDischargeLounge is kept for moveToDischargeLounge's own call
 *  below but is otherwise a no-op now. */
export async function transferBed(opts: {
  fromBedId: number; toWardId: number; toBedId: number; reason: string; userId: number;
  allowDischargeLounge?: boolean;
}) {
  const reason = opts.reason.trim();
  if (!reason) throw new HttpError(400, "Transfer reason is required");

  const fromBed = await getBedForTransfer(opts.fromBedId);
  if (fromBed.physical_status !== "OCCUPIED")
    throw new HttpError(409, "Only an Occupied (or Occupied + Reserved) bed can be transferred out");

  const admission = await getActiveAdmissionByBed(opts.fromBedId);
  if (!admission) throw new HttpError(404, "No active patient admission on this bed");

  const toBed = await getBedForTransfer(opts.toBedId);
  if (toBed.ward_id !== opts.toWardId) throw new HttpError(400, "Destination bed is not in the selected ward");
  if (!toBed.ward_operational) throw new HttpError(409, "Destination ward is currently non-operational");
  if (!toBed.operational_status) throw new HttpError(409, "Destination bed is non-operational");
  if (toBed.physical_status !== "VACANT") throw new HttpError(409, "Destination bed must be Vacant");
  if (toBed.reservation_status !== "NONE") throw new HttpError(409, "Destination bed must not be reserved");
  if (toBed.id === fromBed.id) throw new HttpError(400, "Destination bed must be different from the current bed");

  await db.transaction(async () => {
    await updateBedStatus({
      bedId: opts.toBedId, physicalStatus: "OCCUPIED", reservationStatus: "NONE",
      payerType: fromBed.payer_type,
      userId: opts.userId, changeReason: "TRANSFER",
      // Guards against two transfers landing on the same empty bed at once — the
      // second one to reach here finds the bed no longer Vacant and fails cleanly
      // instead of silently doubling up on the same bed.
      expectedPhysicalStatus: "VACANT", expectedReservationStatus: "NONE",
      conflictMessage: "Someone just moved another patient into this bed. Please choose a different bed and try again.",
    });

    await moveAdmission({ admissionId: admission.id, newBedId: opts.toBedId, newWardId: opts.toWardId, userId: opts.userId });
    await db.prepare(
      `INSERT INTO bed_transfer_history (admission_id, from_bed_id, to_bed_id, from_ward_id, to_ward_id, reason, transferred_by, transferred_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(admission.id, opts.fromBedId, opts.toBedId, fromBed.ward_id, opts.toWardId, reason, opts.userId, Date.now());

    await updateBedStatus({
      bedId: opts.fromBedId, physicalStatus: "VACANT", reservationStatus: "NONE",
      userId: opts.userId, changeReason: "TRANSFER",
    });
  });

  await audit(opts.userId, "bed_transfer", String(admission.id), {
    fromBedId: opts.fromBedId, toBedId: opts.toBedId, toWardId: opts.toWardId, reason,
  });

  if (toBed.ward_is_discharge_lounge) {
    await autoCompleteDischargeForLoungeTransfer(admission.id, opts.userId);
  } else if (fromBed.ward_is_discharge_lounge) {
    await resetPhysicalCheckoutOnReadmit(admission.id, opts.userId);
  }

  const toBedName = await db.prepare("SELECT bed_name FROM bed_details WHERE id=?").get<{ bed_name: string }>(opts.toBedId);
  const toWardName = await db.prepare("SELECT name FROM wards WHERE id=?").get<{ name: string }>(opts.toWardId);

  return { ok: true, admissionId: admission.id, fromBedId: opts.fromBedId, toBedId: opts.toBedId, toWardId: opts.toWardId, toBedName: toBedName?.bed_name, toWardName: toWardName?.name };
}

/** Discharge Lounge — a real ward/bed in the system with no physical counterpart in the
 *  hospital. Used when Physical Checkout completes (patient has actually left) while System
 *  Checkout is still pending: the real bed can't honestly stay Occupied (nobody's in it) or
 *  go Vacant (paperwork isn't done), so the admission moves here and the real bed frees up
 *  immediately for a new patient. Reuses transferBed — same admission-move + history trail,
 *  just with the destination picked automatically instead of by the caller.
 *  PRE or Nurse (enforced in the route) — matches whoever can complete Physical Checkout. */
export async function moveToDischargeLounge(opts: { admissionId: number; fromBedId: number; userId: number }) {
  const tracking = await getTrackingByAdmission(opts.admissionId);
  if (!tracking) throw new HttpError(404, "No discharge found for this admission");
  if (tracking.physical_checkout_status !== "COMPLETED")
    throw new HttpError(409, "Physical Checkout must be completed (patient has left) before moving to the Discharge Lounge");
  if (tracking.system_checkout_status === "COMPLETED")
    throw new HttpError(409, "System Checkout is already complete — this discharge will finish normally, no lounge move needed");

  const lounge = await db.prepare("SELECT id FROM wards WHERE is_discharge_lounge=true").get<{ id: number }>();
  if (!lounge) throw new HttpError(409, "Discharge Lounge is not configured yet — ask an admin to set it up.");

  const candidates = await listTransferCandidates(lounge.id);
  const toBed = candidates[0];
  if (!toBed) throw new HttpError(409, "No Discharge Lounge beds are free right now.");

  return transferBed({
    fromBedId: opts.fromBedId, toWardId: lounge.id, toBedId: toBed.id,
    reason: "Physical checkout complete — moved to Discharge Lounge pending System Checkout",
    userId: opts.userId,
    allowDischargeLounge: true,
  });
}

/** Moves a patient out of the Discharge Lounge back onto a real bed — the reverse of
 *  a normal transfer, logged distinctly (is_readmit) so it's identifiable in history
 *  separately from an ordinary bed-to-bed transfer.
 *
 *  Blocked while a discharge is still running (DISCHARGE_INITIATED/IN_PROGRESS) —
 *  since the lounge transfer now auto-completes every step through Payment,
 *  readmitting underneath that would leave Billing/Payment/etc. marked COMPLETED
 *  for a patient who isn't actually being discharged. The caller must cancel the
 *  discharge first (existing cancelAfterInitiation flow, which already resets
 *  every step back to PENDING); only then can Readmit proceed. Each cancel is
 *  its own permanent history entry, and a later re-discharge starts a fresh
 *  tracking row (same convention as planDischarge), so a full
 *  cancel → readmit → re-discharge → cancel → readmit cycle stays fully visible
 *  in history, nothing overwritten. */
export async function readmitFromLounge(opts: {
  fromBedId: number; toWardId: number; toBedId: number; reason: string; userId: number;
}) {
  const fromBed = await getBedForTransfer(opts.fromBedId);
  if (!fromBed.ward_is_discharge_lounge)
    throw new HttpError(409, "Readmit is only valid from a Discharge Lounge bed");

  const admission = await getActiveAdmissionByBed(opts.fromBedId);
  if (!admission) throw new HttpError(404, "No active patient admission on this bed");

  const tracking = await getTrackingByAdmission(admission.id);
  if (tracking && ["DISCHARGE_INITIATED", "IN_PROGRESS"].includes(tracking.status)) {
    throw new HttpError(409, "This discharge is still in progress — cancel the discharge process before readmitting this patient.");
  }

  const result = await transferBed({
    fromBedId: opts.fromBedId, toWardId: opts.toWardId, toBedId: opts.toBedId, reason: opts.reason, userId: opts.userId,
  });

  await db.prepare(
    `UPDATE bed_transfer_history SET is_readmit=true WHERE id = (
       SELECT id FROM bed_transfer_history
       WHERE admission_id=? AND to_bed_id=? AND transferred_by=?
       ORDER BY transferred_at DESC LIMIT 1
     )`
  ).run(result.admissionId, opts.toBedId, opts.userId);

  await audit(opts.userId, "bed_readmit", String(result.admissionId), {
    fromBedId: opts.fromBedId, toBedId: opts.toBedId, toWardId: opts.toWardId, reason: opts.reason,
  });

  return result;
}
