import type { Request, Response, NextFunction } from "express";

// Wrap async route handlers so thrown errors hit the error middleware.
export const asyncH =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  const status = (err as { status?: number }).status || 500;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: err.message || "Internal server error" });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
