// slack.mjs — gửi alert lỗi (Bloom/j7) về Slack Incoming Webhook. Trống SLACK_WEBHOOK = tắt.
// Fire-and-forget: lỗi gửi Slack KHÔNG làm sập engine. Webhook để trong .env (KHÔNG commit).
import { cfg } from "./config.mjs";

export async function slackAlert(text) {
  if (!cfg.slackWebhook) return;
  try {
    await fetch(cfg.slackWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (e) { console.warn("[slack]", e.message); }
}
