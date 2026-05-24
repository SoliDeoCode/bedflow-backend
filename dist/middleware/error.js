// Wrap async route handlers so thrown errors hit the error middleware.
export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
export function errorHandler(err, _req, res, _next) {
    const status = err.status || 500;
    if (status >= 500)
        console.error("[error]", err);
    res.status(status).json({ error: err.message || "Internal server error" });
}
export class HttpError extends Error {
    status;
    constructor(status, message) { super(message); this.status = status; }
}
