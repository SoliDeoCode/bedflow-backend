import { Server as SocketServer } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { db } from "../db/index.js";
let io = null;
export function initWebsocket(server) {
    io = new SocketServer(server, { cors: { origin: env.CORS_ORIGIN } });
    // authenticate every socket via JWT
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!token)
            return next(new Error("No token"));
        try {
            const user = jwt.verify(token, env.JWT_SECRET);
            socket.data.user = user;
            next();
        }
        catch {
            next(new Error("Invalid token"));
        }
    });
    io.on("connection", async (socket) => {
        const user = socket.data.user;
        if (user.role === "COO" || user.role === "MANAGER")
            socket.join("overview");
        if (user.role === "PRE") {
            const row = await db.prepare("SELECT pre_block_id FROM users WHERE id=?")
                .get(user.id);
            if (row?.pre_block_id)
                socket.join(`pre:${row.pre_block_id}`);
        }
        if (user.role === "NURSE" && user.station_id)
            socket.join(`station:${user.station_id}`);
    });
    return io;
}
// Broadcast a bed/round change so dashboards refresh live.
// opts.pre  → also emit to PRE block room `pre:<code>`
// opts.stationId → also emit to nurse station room `station:<id>`
export function emitUpdate(event, data, opts) {
    if (!io)
        return;
    io.to("overview").emit(event, data);
    if (opts?.pre)
        io.to(`pre:${opts.pre}`).emit(event, data);
    if (opts?.stationId)
        io.to(`station:${opts.stationId}`).emit(event, data);
}
