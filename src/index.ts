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

migrate(); // ensure schema exists

const app = express();
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGIN }));
app.use(express.json());

// rate limit auth endpoints against brute force
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, max: 50 }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
app.use("/api/pre", preRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/coo", cooRoutes);
app.use("/api", metaRoutes);

app.use(errorHandler);

const server = createServer(app);
initWebsocket(server);

server.listen(env.PORT, () => {
  console.log(`BedFlow backend on :${env.PORT} (${env.NODE_ENV})`);
  startScheduler();
});
