import { db } from "../db/index.js";
const MAX_DETAIL_BYTES = 2048;
export function audit(userId, action, entity, detail) {
    // Truncate detail so a single bad caller can't bloat audit_logs unboundedly.
    let json = JSON.stringify(detail ?? {});
    if (json.length > MAX_DETAIL_BYTES)
        json = json.slice(0, MAX_DETAIL_BYTES) + '..."[truncated]"';
    db.prepare("INSERT INTO audit_logs (ts, user_id, action, entity, detail) VALUES (?,?,?,?,?)")
        .run(Date.now(), userId, action, entity, json);
}
export function recentAudit(limit = 100) {
    return db.prepare(`SELECT a.id, a.ts, a.action, a.entity, a.detail, u.username, u.name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     ORDER BY a.ts DESC LIMIT ?`).all(limit);
}
