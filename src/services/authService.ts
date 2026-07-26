import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import type { User, JwtPayload } from "../types/index.js";

export async function login(username: string, password: string) {
  const user = await db.prepare("SELECT * FROM users WHERE username=?")
    .get<User>(String(username || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    throw new HttpError(401, "Incorrect username or password.");
  // Block inactive accounts (any role). Existing accounts default to 'active'.
  if (user.status === "inactive")
    throw new HttpError(403, "Your account is inactive. Contact administrator.");

  const payload: JwtPayload = {
    id: user.id, username: user.username, role: user.role, name: user.name,
    floor_id: null,                  // legacy — no longer used for PRE
    block: null, pre: null,
    nursing_station: user.nursing_station ?? null,
    station_id: user.station_id ?? null,
    doctor_master_id: user.doctor_master_id ?? null,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "24h" });
  return { token, user: { ...payload } };
}
