import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import type { User, JwtPayload } from "../types/index.js";

export async function login(username: string, password: string, role?: string) {
  const user = await db.prepare("SELECT * FROM users WHERE username=?")
    .get<User>(String(username || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    throw new HttpError(401, "Incorrect username or password.");
  if (role && user.role !== role) {
    const tabLabel: Record<string, string> = { PRE: "PRE", NURSE: "Nurse", MANAGER: "Manager", COO: "Admin" };
    const label = tabLabel[user.role] || user.role;
    throw new HttpError(403, `This account belongs to the ${label} role. Please select the ${label} tab and try again.`);
  }

  const payload: JwtPayload = {
    id: user.id, username: user.username, role: user.role, name: user.name,
    floor_id: null,                  // legacy — no longer used for PRE
    block: null, pre: null,
    nursing_station: user.nursing_station ?? null,
    station_id: user.station_id ?? null,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "24h" });
  return { token, user: { ...payload, shift: user.shift } };
}
