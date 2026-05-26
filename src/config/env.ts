import "dotenv/config";

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const env = {
  PORT: Number(process.env.PORT || 4000),
  JWT_SECRET: required("JWT_SECRET"),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
  VAPID_PUBLIC: process.env.VAPID_PUBLIC || "",
  VAPID_PRIVATE: process.env.VAPID_PRIVATE || "",
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || "mailto:admin@hospital.local",
  NODE_ENV: process.env.NODE_ENV || "development",
};

export const pushEnabled = !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE);
