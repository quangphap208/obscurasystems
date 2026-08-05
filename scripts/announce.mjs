// announce.mjs — broadcast 1 tin thông báo tính năng mới tới TẤT CẢ user trong DB.
// AN TOÀN: mặc định DRY-RUN (chỉ đếm + xem trước tin, KHÔNG gửi). Gửi thật phải có SEND=1.
//   node scripts/announce.mjs                        # dry-run: đếm user + in tin
//   ONLY=<tg_id> SEND=1 node scripts/announce.mjs    # gửi THỬ 1 mình bạn trước
//   SEND=1 node scripts/announce.mjs                 # GỬI THẬT tới tất cả user
// Rate-limit ~25 msg/s + xử lý 429 (retry_after); 403 (user block/chưa /start) -> bỏ qua, không lỗi.
import { cfg, assertFE } from "../shared/config.mjs";
import { connect, close, col } from "../shared/mongo.mjs";

assertFE();

const MSG = `🕶️ Obscura Systems — your all-in-one X tracker, right in Telegram.

One bot, every signal — the moment it happens:
⚡ Tweets, replies, quotes, retweets — full text + media, never cut off
🗑 Deleted tweets — with the original content
📌 Pins/unpins · 👤 follows, profile / avatar / bio / banner changes · 🤝 affiliations · ⛔ suspensions
🟣 Truth Social & 📸 Instagram too — not just X

📩 Straight to your DM · 🎛 per-account settings · ➕ add by @username or link
🛰 Fast & reliable — alerts in seconds, nothing slips through.

🧪 Private beta — 100% free while testing. At launch: 1/2–1/3 the price of other trackers.

👉 @obscurasystemsbot → /start → /add elonmusk

What's missing, too noisy, or would make you switch? Early testers get priority support + a launch discount. 🙌`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = `https://api.telegram.org/bot${cfg.botToken}`;

async function send(chatId) {
  const r = await fetch(`${API}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: MSG, disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: !!j.ok, code: j.error_code, desc: j.description, retry: j.parameters?.retry_after };
}

async function main() {
  await connect();
  const only = process.env.ONLY ? [Number(process.env.ONLY)] : null;
  const rows = only || (await col("users").find({}).project({ _id: 1, tg_id: 1 }).toArray()).map((u) => Number(u.tg_id ?? u._id));
  const ids = [...new Set(rows.filter((n) => Number.isFinite(n)))];
  const SEND = process.env.SEND === "1";
  console.log(`Users: ${ids.length} | mode: ${SEND ? "GỬI THẬT" : "DRY-RUN (không gửi)"}${only ? " | ONLY " + only[0] : ""}`);
  if (!SEND) {
    console.log("→ Chạy lại với SEND=1 để gửi. Xem trước tin:\n----------\n" + MSG + "\n----------");
    return close();
  }
  let sent = 0, blocked = 0, failed = 0;
  for (let i = 0; i < ids.length; i++) {
    let r = await send(ids[i]);
    if (!r.ok && r.code === 429 && r.retry) { await sleep((r.retry + 1) * 1000); r = await send(ids[i]); }
    if (r.ok) sent++;
    else if (r.code === 403) blocked++;                        // user block bot / chưa /start -> bỏ qua
    else { failed++; console.warn("  fail", ids[i], r.code, r.desc); }
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${ids.length} (sent ${sent})`);
    await sleep(40);                                           // ~25 msg/s (dưới giới hạn Telegram)
  }
  console.log(`XONG. sent=${sent} blocked=${blocked} failed=${failed} / total=${ids.length}`);
  await close();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
