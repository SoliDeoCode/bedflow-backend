/**
 * DEV-ONLY test-data script — never run against production.
 *
 * 1. Sets every operational, non-lounge bed to VACANT (clears any existing
 *    occupancy/admission state via the same code path a real status change uses).
 * 2. Occupies 50 of them with a fresh admission (random payer/admission type).
 * 3. Marks 8 of those 50 as Occupied+Reserved (destination: OT).
 * 4. Puts 10 of the remaining occupied beds into various discharge-process
 *    states: planned, initiated, and a couple of steps completed (in progress).
 *
 * Run: npx tsx scripts/seed_test_occupancy.ts   (defaults to NODE_ENV=development)
 */
import { db } from "../src/db/index.js";
import { updateBedStatus } from "../src/services/bedDetailService.js";
import { planDischarge, initiateDischarge, updateStep, cancelPlan, cancelAfterInitiation } from "../src/services/dischargeService.js";

if ((process.env.NODE_ENV || "development") === "production") {
  console.error("Refusing to run against production. Aborting.");
  process.exit(1);
}

const PAYER_TYPES = ["Cash", "Insurance / TPA", "Corporate", "Arogyasri / EHS / AB"];
const ADMISSION_TYPES = ["IP", "DAYCARE", "OPD"];

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function randIp(): string { return String(Math.floor(100000 + Math.random() * 900000)); }
function todayStr(): string {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function run() {
  const userRow = await db.prepare("SELECT id FROM users WHERE role='PRE' LIMIT 1").get<{ id: number }>();
  if (!userRow) throw new Error("No PRE user found to attribute changes to");
  const userId = userRow.id;

  // Admissions require a real (doctor_id, department_id) pair — pull the
  // actual valid combinations rather than randomizing each independently.
  const doctorDepts = await db.prepare("SELECT doctor_id, department_id FROM doctor_departments").all<{ doctor_id: number; department_id: number }>();
  if (doctorDepts.length === 0) throw new Error("No doctor/department pairs found — required on every admission");

  const beds = await db.prepare(`
    SELECT bd.id, bd.physical_status, bd.reservation_status
    FROM bed_details bd
    JOIN wards w ON w.id = bd.ward_id
    WHERE w.operational = true AND bd.operational_status = true AND NOT w.is_discharge_lounge
  `).all<{ id: number; physical_status: string; reservation_status: string }>();
  console.log(`Found ${beds.length} operational non-lounge beds.`);

  console.log("Step 1/4 — vacating every bed...");
  let vacated = 0;
  for (const b of beds) {
    if (b.physical_status === "VACANT" && b.reservation_status === "NONE") continue;

    // A bed with an in-flight discharge (from earlier real testing) can't be
    // manually vacated until that discharge is resolved — cancel it first.
    const admission = await db.prepare(
      "SELECT id FROM patient_admissions WHERE bed_id=? AND status='ACTIVE'"
    ).get<{ id: number }>(b.id);
    if (admission) {
      const tracking = await db.prepare(
        "SELECT status FROM discharge_tracking WHERE admission_id=?"
      ).get<{ status: string }>(admission.id);
      if (tracking && tracking.status !== "CANCELLED" && tracking.status !== "COMPLETED") {
        if (tracking.status === "PLANNED") await cancelPlan({ admissionId: admission.id, userId, role: "PRE", reason: "Test data reset" });
        else await cancelAfterInitiation({ admissionId: admission.id, userId, role: "PRE", reason: "Test data reset" });
      }
    }

    await updateBedStatus({
      bedId: b.id, physicalStatus: "VACANT", reservationStatus: "NONE", userId, changeReason: "MANUAL",
    });
    vacated++;
  }
  console.log(`  vacated ${vacated} beds.`);

  const pool = shuffle(beds).slice(0, 50);
  console.log(`Step 2/4 — occupying ${pool.length} beds with fresh admissions...`);
  for (const b of pool) {
    const dd = pick(doctorDepts);
    await updateBedStatus({
      bedId: b.id, physicalStatus: "OCCUPIED", reservationStatus: "NONE",
      payerType: pick(PAYER_TYPES), ipLast6: randIp(), admissionType: pick(ADMISSION_TYPES),
      doctorId: dd.doctor_id, departmentId: dd.department_id,
      userId, changeReason: "MANUAL",
    });
  }

  const occResPool = pool.slice(0, 8);
  console.log(`Step 3/4 — marking ${occResPool.length} of those Occupied+Reserved...`);
  for (const b of occResPool) {
    await updateBedStatus({
      bedId: b.id, physicalStatus: "OCCUPIED", reservationStatus: "RESERVED",
      destination: "OT", userId, changeReason: "MANUAL",
    });
  }

  const dischargePool = pool.slice(8, 18); // 10 beds, disjoint from the occ+res set
  console.log(`Step 4/4 — putting ${dischargePool.length} beds through the discharge process...`);
  const today = todayStr();
  for (let i = 0; i < dischargePool.length; i++) {
    const b = dischargePool[i];
    const admission = await db.prepare(
      "SELECT id FROM patient_admissions WHERE bed_id=? AND status='ACTIVE'"
    ).get<{ id: number }>(b.id);
    if (!admission) continue;

    await planDischarge({ bedId: b.id, plannedDate: today, userId, role: "PRE" });
    if (i < 3) continue; // 3 beds: PLANNED only

    await initiateDischarge({ admissionId: admission.id, userId, role: "PRE" });
    if (i < 6) continue; // 3 beds: DISCHARGE_INITIATED only

    // remaining 4 beds: a couple of PRE-permitted steps completed (in progress)
    await updateStep({ admissionId: admission.id, step: "DRUG_RETURN", status: "COMPLETED", userId, role: "PRE" });
    await updateStep({ admissionId: admission.id, step: "PHARMACY_CLEARANCE", status: "COMPLETED", userId, role: "PRE" });
  }

  console.log("\nDone. Summary:");
  console.log(`  50 occupied beds (8 of them Occupied+Reserved)`);
  console.log(`  10 of the occupied beds are mid discharge-process (3 planned, 3 initiated, 4 in progress)`);
  console.log(`  ${beds.length - 50} beds left vacant`);
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
