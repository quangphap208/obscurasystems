// announce.mjs — broadcast 1 tin thông báo tính năng mới tới TẤT CẢ user trong DB.
// AN TOÀN: mặc định DRY-RUN (chỉ đếm + xem trước tin, KHÔNG gửi). Gửi thật phải có SEND=1.
//   node scripts/announce.mjs                        # dry-run: đếm user + in tin
//   ONLY=<tg_id> SEND=1 node scripts/announce.mjs    # gửi THỬ 1 mình bạn trước
//   SEND=1 node scripts/announce.mjs                 # GỬI THẬT tới tất cả
// Log TỪNG user (✓ gửi / ⊘ blocked / ✗ lỗi) + ghi kết quả ra scripts/announce_result.json.
// Rate-limit ~25 msg/s + xử lý 429 (retry_after); 403 (user block/chưa /start) -> ⊘ bỏ qua, không lỗi.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
const RESULT = join(dirname(fileURLToPath(import.meta.url)), "announce_result.json");

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
  let docs;
  if (process.env.ONLY) docs = [{ id: Number(process.env.ONLY), username: null }];
  else {
    const us = await col("users").find({}).project({ _id: 1, tg_id: 1, username: 1 }).toArray();
    docs = us.map((u) => ({ id: Number(u.tg_id ?? u._id), username: u.username || null }));
  }
  const seen = new Set();
  docs = docs.filter((d) => Number.isFinite(d.id) && !seen.has(d.id) && (seen.add(d.id), true));

  const SEND = process.env.SEND === "1";
  console.log(`Users: ${docs.length} | mode: ${SEND ? "GỬI THẬT" : "DRY-RUN (không gửi)"}${process.env.ONLY ? " | ONLY " + process.env.ONLY : ""}`);
  if (!SEND) {
    console.log("→ Chạy lại với SEND=1 để gửi. Xem trước tin:\n----------\n" + MSG + "\n----------");
    return close();
  }

  const sent = [], blocked = [], failed = [];
  for (let i = 0; i < docs.length; i++) {
    const { id, username } = docs[i];
    const tag = username ? `@${username}` : "";
    let r = await send(id);
    if (!r.ok && r.code === 429 && r.retry) { console.log(`  ⏳ 429, chờ ${r.retry}s...`); await sleep((r.retry + 1) * 1000); r = await send(id); }
    if (r.ok) { sent.push(id); console.log(`✓ ${id} ${tag}`); }
    else if (r.code === 403) { blocked.push(id); console.log(`⊘ ${id} ${tag} — blocked/chưa start`); }
    else { failed.push({ id, code: r.code, desc: r.desc }); console.log(`✗ ${id} ${tag} — ${r.code} ${r.desc || ""}`); }
    await sleep(40);   // ~25 msg/s (dưới giới hạn Telegram)
  }

  const result = { at: new Date().toISOString(), total: docs.length, sent, blocked, failed };
  try { writeFileSync(RESULT, JSON.stringify(result, null, 2)); } catch (e) { console.warn("ghi file lỗi:", e.message); }
  console.log(`\n==== XONG ====`);
  console.log(`✓ sent    : ${sent.length}`);
  console.log(`⊘ blocked : ${blocked.length}  (user block bot / chưa /start)`);
  console.log(`✗ failed  : ${failed.length}${failed.length ? " -> " + failed.map((f) => f.id).join(",") : ""}`);
  console.log(`Chi tiết đã ghi: ${RESULT}`);
  await close();
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
