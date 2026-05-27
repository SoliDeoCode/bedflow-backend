import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
import type { User, JwtPayload } from "../types/index.js";

export function login(username: string, password: string, role?: string) {
  const user = db.prepare("SELECT * FROM users WHERE username=?")
    .get<User>(String(username || "").toLowerCase());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash))
    throw new HttpError(401, "Invalid credentials");
  if (role && user.role !== role)
    throw new HttpError(403, `This is a ${user.role} account. Use the ${user.role} tab.`);

  // Resolve block name from users.block_id
  const blockName = user.block_id
    ? db.prepare("SELECT name FROM blocks WHERE id=?")
        .get<{ name: string }>(user.block_id)?.name ?? null
    : null;

  const payload: JwtPayload = {
    id:       user.id,
    username: user.username,
    role:     user.role,
    name:     user.name,
    block:    blockName,
    pre:      blockName,   // legacy alias for old tokens / frontend that reads user.pre
  };
  const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
  return { token, user: { ...payload, shift: user.shift } };
}
