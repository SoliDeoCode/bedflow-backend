import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
export function authRequired(req, res, next) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token)
        return res.status(401).json({ error: "No token" });
    try {
        req.user = jwt.verify(token, env.JWT_SECRET);
        next();
    }
    catch {
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}
export function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role))
            return res.status(403).json({ error: `Requires role: ${roles.join(" or ")}` });
        next();
    };
}
