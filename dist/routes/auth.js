import { Router } from "express";
import { z } from "zod";
import { login } from "../services/authService.js";
import { asyncH } from "../middleware/error.js";
import { audit } from "../services/auditService.js";
const router = Router();
const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    role: z.enum(["PRE", "MANAGER", "COO"]).optional(),
});
router.post("/login", asyncH(async (req, res) => {
    const { username, password, role } = loginSchema.parse(req.body);
    try {
        const result = login(username, password, role);
        audit(result.user.id, "login", "user", { username });
        res.json(result);
    }
    catch (e) {
        // Audit failed attempts so brute-force is visible; do NOT log the password.
        audit(null, "login_failed", "user", { username, reason: e.message });
        throw e;
    }
}));
export default router;
