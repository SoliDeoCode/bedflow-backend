import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { JwtPayload } from "../types/index.js";
import { db } from "../db/index.js";

let io: SocketServer | null = null;
let patientNs: ReturnType<SocketServer["of"]> | null = null;

export function initWebsocket(server: HttpServer) {
  io = new SocketServer(server, { cors: { origin: env.CORS_ORIGIN } });

  // authenticate every socket via JWT
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("No token"));
    try {
      const user = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      (socket.data as { user: JwtPayload }).user = user;
      next();
    } catch { next(new Error("Invalid token")); }
  });

  io.on("connection", async (socket) => {
    const user = (socket.data as { user: JwtPayload }).user;
    // FC is hospital-wide for the discharge module (billing isn't ward-scoped),
    // same as COO — reuses the existing broadcast room rather than adding a new one.
    //
    // PRE joins it too: its Home dashboard is now the hospital-wide Admin view,
    // so it has to refresh on any bed change, not just its own blocks'. This
    // replaces the per-block `pre:<id>` joins rather than adding to them —
    // emitUpdate() always emits to "overview", so it is a strict superset and
    // keeping both would just refresh the client twice per event.
    if (["COO", "FC", "MASTER_FC", "PRE", "PHARMACY", "MASTER_PHARMACY", "CONSULTANT"].includes(user.role)) socket.join("overview");
    if (user.role === "NURSE") {
      const rows = await db.prepare("SELECT station_id FROM nurse_stations WHERE nurse_id=?")
        .all<{ station_id: number }>(user.id);
      for (const r of rows) socket.join(`station:${r.station_id}`);
    }
    if (user.role === "DOCTOR") {
      // Join a room per ward the doctor can currently reach (active blocks only).
      // This makes a bed change from ANY role (nurse/PRE/admin/doctor) land on
      // the doctor's live view, since every bed:update payload carries wardId.
      const rooms = await db.prepare(
        `SELECT DISTINCT dbw.ward_id
         FROM doctor_block_users dbu
         JOIN doctor_blocks db        ON db.id = dbu.doctor_block_id AND db.status = 'active'
         JOIN doctor_block_wards dbw  ON dbw.doctor_block_id = db.id
         WHERE dbu.user_id = ?`
      ).all<{ ward_id: number }>(user.id);
      for (const r of rooms) socket.join(`ward:${r.ward_id}`);
    }
  });

  // Public namespace for patient portal — no JWT required.
  patientNs = io.of("/patient");
  patientNs.on("connection", (socket) => {
    socket.on("subscribe", (admissionId: number) => {
      if (typeof admissionId === "number" && admissionId > 0) {
        socket.join(`patient:${admissionId}`);
      }
    });
  });

  return io;
}

// Broadcast a bed/round change so dashboards refresh live.
// opts.pre       → emit to one or more PRE block rooms `pre:<id>`
// opts.stationId → emit to one or more nurse station rooms `station:<id>`
export function emitUpdate(
  event: string,
  data: unknown,
  opts?: { pre?: string | string[]; stationId?: number | number[]; wardId?: number | number[] },
) {
  if (!io) return;
  io.to("overview").emit(event, data);
  if (opts?.pre) {
    const rooms = Array.isArray(opts.pre) ? opts.pre : [opts.pre];
    for (const r of rooms) io.to(`pre:${r}`).emit(event, data);
  }
  if (opts?.stationId) {
    const stations = Array.isArray(opts.stationId) ? opts.stationId : [opts.stationId];
    for (const s of stations) io.to(`station:${s}`).emit(event, data);
  }
  // Ward rooms power the Doctor live view. Prefer an explicit opts.wardId, but
  // fall back to the wardId carried in the payload so existing bed:update call
  // sites (nurse/PRE/admin) reach watching doctors without needing changes.
  const wardIds = opts?.wardId !== undefined
    ? (Array.isArray(opts.wardId) ? opts.wardId : [opts.wardId])
    : (() => {
        const w = (data as { wardId?: unknown })?.wardId;
        return typeof w === "number" ? [w] : [];
      })();
  for (const w of wardIds) io.to(`ward:${w}`).emit(event, data);

  // Mirror discharge updates to the patient namespace so the patient portal
  // refreshes live without polling.
  if (event === "discharge:update" && patientNs) {
    const aid = (data as { admissionId?: number })?.admissionId;
    if (typeof aid === "number") {
      patientNs.to(`patient:${aid}`).emit("discharge:refresh", { admissionId: aid });
    }
  }
}
