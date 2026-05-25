import { Server as SocketServer } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
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
    io.on("connection", (socket) => {
        const user = socket.data.user;
        // COO + manager get all updates; PRE joins their own room
        if (user.role === "COO" || user.role === "MANAGER")
            socket.join("overview");
        if (user.pre)
            socket.join(`pre:${user.pre}`);
    });
    return io;
}
// Broadcast a bed/round change so dashboards refresh live.
export function emitUpdate(event, data, preCode) {
    if (!io)
        return;
    io.to("overview").emit(event, data);
    if (preCode)
        io.to(`pre:${preCode}`).emit(event, data);
}
