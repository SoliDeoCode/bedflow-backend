import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "node:http";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { JwtPayload } from "../types/index.js";

let io: SocketServer | null = null;

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

  io.on("connection", (socket) => {
    const user = (socket.data as { user: JwtPayload }).user;
    // COO + manager get all updates; PRE joins their own room
    if (user.role === "COO" || user.role === "MANAGER") socket.join("overview");
    if (user.pre) socket.join(`pre:${user.pre}`);
  });

  return io;
}

// Broadcast a bed/round change so dashboards refresh live.
export function emitUpdate(event: string, data: unknown, preCode?: string) {
  if (!io) return;
  io.to("overview").emit(event, data);
  if (preCode) io.to(`pre:${preCode}`).emit(event, data);
}
