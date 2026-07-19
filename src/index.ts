import express from "express";
import { createServer } from "node:http";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { migrate } from "./db/migrate.js";
import { initWebsocket } from "./websocket/io.js";
import { startScheduler } from "./scheduler/index.js";
import { errorHandler } from "./middleware/error.js";
import authRoutes from "./routes/auth.js";
import preRoutes from "./routes/pre.js";
import managerRoutes from "./routes/manager.js";
import cooRoutes from "./routes/coo.js";
import metaRoutes from "./routes/meta.js";
import nurseRoutes from "./routes/nurse.js";
import doctorRoutes from "./routes/doctor.js";
import dischargeRoutes from "./routes/discharge.js";
import patientRoutes from "./routes/patient.js";
import consultantRoutes from "./routes/consultant.js";

// Serialize BigInt as Number in all JSON responses (timestamps are epoch-ms BigInt in Postgres)
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

migrate(); // ensure schema exists (no-op with Prisma — run: npx prisma migrate deploy)

const app = express();
// Render sits one reverse-proxy hop in front of the app and passes the real client IP
// via X-Forwarded-For. Trusting exactly 1 hop makes req.ip the visitor's IP — without
// this, express-rate-limit sees every user as the proxy's IP (one shared bucket) and
// logs ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every rate-limited request.
app.set("trust proxy", 1);
app.use(helmet({
  // SPA needs inline styles (vite-injected) and connection to its own origin.
  // Tighten further if you fingerprint inline assets.
  contentSecurityPolicy: env.isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      frameAncestors: ["'none'"],
    },
  } : false,
  hsts: env.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(cors({ origin: env.CORS_ORIGIN, credentials: false }));
app.use(express.json({ limit: "100kb" })); // Prevent huge-body DoS

// Brute-force protection: tighter cap than before, hides the count
app.use("/api/auth", rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
}));

// Cap push subscription churn — authenticated, per-IP
const pushLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: "Too many push registrations. Try again later." },
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/pre", preRoutes);
app.use("/api/nurse", nurseRoutes);
app.use("/api/doctor", doctorRoutes);
app.use("/api/discharge", dischargeRoutes);
app.use("/api/patient", patientRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/coo", cooRoutes);
app.use("/api/consultant", consultantRoutes);
app.use("/api/push", pushLimiter);
app.use("/api", metaRoutes);

app.use((_req, res) => res.status(404).json({ error: "The requested endpoint was not found." }));
app.use(errorHandler);

const server = createServer(app);
initWebsocket(server);

server.listen(env.PORT, () => {
  console.log(`BedFlow backend on :${env.PORT} (${env.NODE_ENV})`);
  startScheduler();
});
