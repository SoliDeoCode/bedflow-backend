import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";

// Wrap async route handlers so thrown errors hit the error middleware.
export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Raw Postgres unique-violation (SQLSTATE 23505) → friendly message, keyed by
// the constraint name. Both of these are partial unique indexes meant as a
// DB-level backstop for a check-then-act race (two concurrent requests both
// pass the app-level duplicate check before either commits) — the app-level
// check normally catches the common case with a more specific message
// (e.g. "IP 234234 is already admitted on bed 1..."), so by the time a raw
// 23505 reaches here it's genuinely the rare race, not the everyday path.
// Without this, the pg driver's raw "duplicate key value violates unique
// constraint ..." text would otherwise leak straight to the frontend (in dev)
// or collapse to a generic "Server error" (in prod) — neither is useful to a
// real user.
const PG_UNIQUE_VIOLATION_MESSAGES: Record<string, string> = {
  uq_patient_admissions_active_ip: "That IP number was just admitted to another bed by someone else. Please refresh and try again.",
  uq_patient_admissions_active_bed: "This bed just received another active admission. Please refresh and try again.",
  // discharge_tracking.admission_id UNIQUE — same check-then-act race, hit when
  // two actions that can each create a patient's discharge record (Bed Transfer
  // to the Discharge Lounge, Discharge Plan, Discharge Immediate) land on the
  // same admission close together. See planDischarge/autoCompleteDischargeForLoungeTransfer/
  // dischargeImmediate in dischargeService.ts.
  discharge_tracking_admission_id_key: "A discharge was already started for this patient by someone else. Please refresh and try again.",
};

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const msg = err.errors[0]?.message ?? "Invalid request data.";
    return res.status(400).json({ error: msg });
  }
  const pgErr = err as { code?: string; constraint?: string };
  if (pgErr.code === "23505" && pgErr.constraint && PG_UNIQUE_VIOLATION_MESSAGES[pgErr.constraint]) {
    return res.status(409).json({ error: PG_UNIQUE_VIOLATION_MESSAGES[pgErr.constraint] });
  }
  const status = (err as { status?: number }).status || 500;
  if (status >= 500) console.error("[error]", err);
  // Only HttpError (our own) and non-500s expose their message. Raw 5xx errors
  // (e.g. SQLite, JSON parse) get a generic message so internals don't leak.
  const safeMessage = (err instanceof HttpError || status < 500)
    ? err.message
    : (env.isProd ? "Server error" : err.message);
  res.status(status).json({ error: safeMessage || "Server error" });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
