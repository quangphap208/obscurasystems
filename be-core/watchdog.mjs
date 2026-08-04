// watchdog.mjs — cảnh báo khi FEED IM LẶNG quá lâu: WS còn kết nối (không expired, không FATAL)
// nhưng KHÔNG có event nào chảy về -> thường là socket treo/rớt ngầm hoặc tracking hỏng. Engine gọi
// touch() mỗi frame/event; nếu quá silenceMinutes không touch -> onSilent (BÁO 1 LẦN). Có event lại
// -> onRecover (báo hồi phục, reset). silenceMinutes=0 -> tắt. Dùng chung Bloom + j7 (source khác nhau).
import { slackAlert } from "../shared/slack.mjs";

export function makeFeedWatchdog({ source, silenceMinutes, tg = null, adminIds = [] }) {
  const silenceMs = Math.max(0, Number(silenceMinutes) || 0) * 60000;
  let lastAt = Date.now();
  let alerted = false;
  let timer = null;

  const push = (html, slack) => {
    slackAlert(slack);
    for (const id of adminIds) tg?.notify(id, html);
  };

  const touch = () => {
    lastAt = Date.now();
    if (alerted) {
      alerted = false;
      push(`✅ <b>${source} feed hồi phục</b> — có event trở lại.`,
        `✅ *${source}* feed HỒI PHỤC — có event trở lại.`);
    }
  };

  const check = () => {
    if (alerted) return;
    const gap = Date.now() - lastAt;
    if (gap < silenceMs) return;
    alerted = true;
    const mins = Math.round(gap / 60000);
    push(`🔕 <b>${source} feed IM LẶNG</b> ~${mins} phút — WS có thể đã rớt/treo (không expired). Kiểm tra ${source}.`,
      `🔕 *${source}* feed IM LẶNG ~${mins} phút — WS có thể rớt/treo ngầm (không expired/FATAL). Kiểm tra ${source}.`);
  };

  return {
    touch,
    // intervalMs = nhịp kiểm tra (mặc định 60s). silenceMinutes=0 -> không chạy timer (tắt watchdog).
    start(intervalMs = 60000) {
      if (!silenceMs) return null;
      lastAt = Date.now();
      timer = setInterval(check, intervalMs);
      return timer;
    },
    stop() { clearInterval(timer); },
  };
}
