import webpush from "web-push";
import { db } from "../db/index.js";
import { env, pushEnabled } from "../config/env.js";
if (pushEnabled) {
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC, env.VAPID_PRIVATE);
}
export function saveSubscription(userId, sub) {
    db.prepare("INSERT OR IGNORE INTO push_subscriptions (user_id, endpoint, sub_json, created_at) VALUES (?,?,?,?)")
        .run(userId, sub.endpoint, JSON.stringify(sub), Date.now());
}
export async function pushToUser(userId, payload) {
    if (!pushEnabled)
        return;
    const subs = db.prepare("SELECT id, sub_json FROM push_subscriptions WHERE user_id = ?")
        .all(userId);
    for (const s of subs) {
        try {
            await webpush.sendNotification(JSON.parse(s.sub_json), JSON.stringify(payload));
        }
        catch (e) {
            const code = e.statusCode;
            if (code === 404 || code === 410)
                db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
        }
    }
}
