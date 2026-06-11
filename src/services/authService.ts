import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import type { User, JwtPayload } from "../types/index.js";

export async function login(username: string, password: string, role?: string) {
  const user = await db.prepare("SELECT * FROM users WHERE username=?")
    .get<User>(String(username || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    throw new HttpError(401, "Invalid credentials");
  if (role && user.role !== role)
    throw new HttpError(403, `This is a ${user.role} account. Use the ${user.role} tab.`);

  const payload: JwtPayload = {
    id: user.id, username: user.username, role: user.role, name: user.name,
    pre_block_id: user.pre_block_id ?? null,
    floor_id: null,                  // legacy — no longer used for PRE
    block: null, pre: null,
    nursing_station: user.nursing_station ?? null,
    station_id: user.station_id ?? null,
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
  return { token, user: { ...payload, shift: user.shift } };
}
