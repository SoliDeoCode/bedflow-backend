import type { Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

// Wrap async route handlers so thrown errors hit the error middleware.
export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
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
