import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
export async function login(username, password, role) {
    const user = await db.prepare("SELECT * FROM users WHERE username=?")
        .get(String(username || "").toLowerCase());
    if (!user || !bcrypt.compareSync(password || "", user.password_hash))
        throw new HttpError(401, "Invalid credentials");
    if (role && user.role !== role)
        throw new HttpError(403, `This is a ${user.role} account. Use the ${user.role} tab.`);
    const blockName = user.block_id
        ? (await db.prepare("SELECT name FROM blocks WHERE id=?")
            .get(user.block_id))?.name ?? null
        : null;
    const payload = {
        id: user.id, username: user.username, role: user.role,
        name: user.name, block: blockName, pre: blockName,
        nursing_station: user.nursing_station ?? null,
    };
    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
    return { token, user: { ...payload, shift: user.shift } };
}
