import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { env } from "../config/env.js";
import { HttpError } from "../middleware/error.js";
export function login(username, password, role) {
    const user = db.prepare("SELECT * FROM users WHERE username = ?")
        .get(String(username || "").toLowerCase());
    if (!user || !bcrypt.compareSync(password || "", user.password_hash))
        throw new HttpError(401, "Invalid credentials");
    if (role && user.role !== role)
        throw new HttpError(403, `This is a ${user.role} account. Use the ${user.role} tab.`);
    const assign = db.prepare("SELECT pre_code FROM pre_assignments WHERE user_id = ?")
        .get(user.id);
    const payload = {
        id: user.id, username: user.username, role: user.role, name: user.name,
        pre: assign?.pre_code ?? null,
    };
    const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "12h" });
    return { token, user: { ...payload, shift: user.shift } };
}
