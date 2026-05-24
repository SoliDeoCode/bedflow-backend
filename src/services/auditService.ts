import { db } from "../db/index.js";

export function audit(userId: number | null, action: string, entity: string | null, detail: unknown) {
  db.prepare("INSERT INTO audit_logs (ts, user_id, action, entity, detail) VALUES (?,?,?,?,?)")
    .run(Date.now(), userId, action, entity, JSON.stringify(detail ?? {}));
}

export function recentAudit(limit = 100) {
  return db.prepare(
    `SELECT a.id, a.ts, a.action, a.entity, a.detail, u.username, u.name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.ts DESC LIMIT ?`
  ).all(limit);
}
