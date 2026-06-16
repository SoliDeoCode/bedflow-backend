import dotenv from "dotenv";
dotenv.config({ path: new URL(`../../.env.${process.env.NODE_ENV || "development"}`, import.meta.url) });

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const NODE_ENV = process.env.NODE_ENV || "development";
const isProd = NODE_ENV === "production";

const JWT_SECRET = required("JWT_SECRET");
// Reject known-weak / placeholder secrets in production
const WEAK_SECRETS = new Set([
  "change-this-to-a-long-random-string",
  "secret", "changeme", "dev", "development", "test",
]);
if (isProd && (WEAK_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET is too weak for production (must be ≥32 chars and not a known placeholder)");
}

// Parse a comma-separated allowlist. In production, refuse "*" — it negates auth security.
const rawOrigin = process.env.CORS_ORIGIN || (isProd ? "" : "*");
if (isProd && (rawOrigin === "*" || !rawOrigin))
  throw new Error("CORS_ORIGIN must be set to specific origin(s) in production");
const CORS_ORIGIN = rawOrigin === "*"
  ? "*"
  : rawOrigin.split(",").map(s => s.trim()).filter(Boolean);

export const env = {
  PORT: Number(process.env.PORT || 4000),
  JWT_SECRET,
  CORS_ORIGIN,
  VAPID_PUBLIC: process.env.VAPID_PUBLIC || "",
  VAPID_PRIVATE: process.env.VAPID_PRIVATE || "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:admin@hospital.local",
  NODE_ENV,
  isProd,
};

export const pushEnabled = !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE);
