// chat_id.mjs — in ra chat_id từ getUpdates (để lấy id channel monitor).
// Cách dùng: add bot vào channel + post 1 tin (hoặc /start ở group), rồi:
//   BOT_TOKEN=<test> node scripts/chat_id.mjs
import { cfg } from "../shared/config.mjs";

if (!cfg.botToken) { console.error("Thiếu BOT_TOKEN."); process.exit(1); }
const r = await (await fetch(`https://api.telegram.org/bot${cfg.botToken}/getUpdates`)).json();
if (!r.ok) { console.error("getUpdates lỗi:", r.description); process.exit(1); }

const chats = new Map();
for (const u of (r.result || [])) {
  const c = (u.message || u.channel_post || u.my_chat_member || u.edited_channel_post)?.chat;
  if (c) chats.set(c.id, `${c.type}${c.title ? " · " + c.title : c.username ? " · @" + c.username : ""}`);
}
if (!chats.size) {
  console.log("Chưa thấy chat nào. Add bot vào channel làm admin + POST 1 tin trong channel, rồi chạy lại.");
} else {
  console.log("chat_id\t\tloại · tên");
  for (const [id, label] of chats) console.log(`${id}\t${label}`);
}
process.exit(0);
