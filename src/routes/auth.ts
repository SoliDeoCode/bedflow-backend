import { Router } from "express";
import { z, ZodError } from "zod";
import { login } from "../services/authService.js";
import { asyncH, HttpError } from "../middleware/error.js";
import { audit } from "../services/auditService.js";

const router = Router();
const loginSchema = z.object({
  username: z.string().min(1, "Please enter your username."),
  password: z.string().min(1, "Please enter your password."),
});

router.post("/login", asyncH(async (req, res) => {
  let body: z.infer<typeof loginSchema>;
  try {
    body = loginSchema.parse(req.body);
  } catch (e) {
    if (e instanceof ZodError) {
      const msg = e.errors[0]?.message ?? "Please fill in all fields.";
      throw new HttpError(400, msg);
    }
    throw e;
  }
  const { username, password } = body;
  try {
    const result = await login(username, password);
    await audit(result.user.id, "login", "user", { username });
    res.json(result);
  } catch (e) {
    // Audit failed attempts so brute-force is visible; do NOT log the password.
    await audit(null, "login_failed", "user", { username, reason: (e as Error).message });
    throw e;
  }
}));

export default router;
