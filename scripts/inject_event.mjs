// inject_event.mjs — TEST LOCAL: bơm 1 event GIẢ qua dispatcher thật -> gửi DM (bot test).
// Test render + lọc settings + dedup + Truth/IG mà KHÔNG cần Bloom/j7. Dùng với DB test + bot test.
//
//   MONGODB_DB=obscura_test BOT_TOKEN=<test> node scripts/inject_event.mjs tweet elonmusk "Hello world"
//   ... node scripts/inject_event.mjs reply elonmusk kane "@kane hi"
//   ... node scripts/inject_event.mjs platform truth realdonaldtrump "Big news today"
//   ... node scripts/inject_event.mjs platform ig cristiano "Match day"
//   ... node scripts/inject_event.mjs seed-platlist          # nạp j7_platform (Truth/IG) cho picker
//   ... node scripts/inject_event.mjs seed-user 12345 elonmusk,cz_binance   # tạo user + watch nhanh
//
// AN TOÀN: từ chối chạy nếu MONGODB_DB là prod (redacted_clone) trừ khi ALLOW_PROD=1.
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";
import { Telegram } from "../be-core/telegram.mjs";
import { makeDispatcher } from "../be-core/dispatch.mjs";

if (cfg.mongoDb === "redacted_clone" && process.env.ALLOW_PROD !== "1") {
  console.error("❌ MONGODB_DB=redacted_clone là PROD. Test phải đặt MONGODB_DB=obscura_test (ALLOW_PROD=1 nếu cố ý).");
  process.exit(1);
}

const [, , sub, ...rest] = process.argv;
const SRC = process.env.SRC || "test";              // nguồn giả: bloom | j7 | test (để test race/monitor)
const idOf = () => process.env.TID || String(Date.now());   // TID cố định -> 2 nguồn CÙNG key -> test race
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await connect();

// --- tiện ích seed (không cần dispatcher) ---
if (sub === "seed-platlist") {
  await repo.saveJ7Platforms({
    truth: ["realdonaldtrump", "trump", "truthsocial", "whitehouse", "devinnunes", "donaldjtrumpjr"],
    ig: ["a16z", "abtc", "binance", "binance.zh", "changpengzhao", "official_bonk_inu", "phantom", "solana",
      "balltze", "kabosumama", "knowyourmeme", "zoos", "natgeoanimals",
      "chatgpt", "claudeai", "googlegemini", "grok", "meta.ai", "openai", "soraofficial"],
  });
  console.log(`✅ j7_platform seeded (DB=${cfg.mongoDb}). Mở picker Truth/IG trong bot test để chọn.`);
  await close(); process.exit(0);
}
if (sub === "seed-user") {
  const tgId = Number(rest[0]);
  if (!tgId) { console.error("Dùng: seed-user <tg_id> [handle,handle]"); process.exit(1); }
  await repo.ensureUser(tgId, "tester");
  await repo.setUserPlan(tgId, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: Date.now() + cfg.proDays * 86400000 });
  for (const h of (rest[1] || "").split(",").map((s) => s.trim()).filter(Boolean)) await repo.addWatch(tgId, h);
  console.log(`✅ user ${tgId} (Pro) + watch [${rest[1] || ""}] (DB=${cfg.mongoDb}).`);
  await close(); process.exit(0);
}

// --- bơm event qua dispatcher thật -> gửi DM ---
const tg = new Telegram(cfg.botToken);
const me = await tg.getMe();
if (!me) { console.error("❌ BOT_TOKEN không hợp lệ (getMe fail)."); process.exit(1); }
const dispatch = makeDispatcher({ tg, getBotUser: () => me.username, warmupUntil: 0 });

let ev = null;
if (sub === "tweet" || sub === "retweet" || sub === "quote") {
  const [handle, text] = rest;
  ev = { kind: sub, actor: handle, authorId: null, content: text || "(test)", tweetId: idOf(),
    target: sub === "tweet" ? null : "someone", parentId: sub === "tweet" ? null : idOf(), images: [], hasVideo: false, source: SRC };
} else if (sub === "reply") {
  const [handle, target, text] = rest;
  ev = { kind: "reply", actor: handle, authorId: null, content: text || "(test reply)", tweetId: idOf(),
    target: target || "someone", parentId: idOf(), images: [], hasVideo: false, source: SRC };
} else if (sub === "platform") {
  const [platform, handle, text] = rest;
  if (!["truth", "ig"].includes(platform)) { console.error("platform phải là truth|ig"); process.exit(1); }
  ev = { kind: "platform", platform, sub: "post", actor: handle, authorId: null, content: text || "(test post)",
    postId: idOf(), postUrl: platform === "truth" ? `https://truthsocial.com/@${handle}` : `https://instagram.com/${handle}`,
    target: null, images: [], hasVideo: false, thumb: null, source: SRC };
} else {
  console.error("Lệnh: tweet|reply|retweet|quote|platform | seed-platlist | seed-user. Xem đầu file.");
  process.exit(1);
}

console.log(`[inject] DB=${cfg.mongoDb} bot=@${me.username} src=${SRC} id=${ev.tweetId || ev.postId} kind=${ev.kind}${ev.platform ? ":" + ev.platform : ""} @${ev.actor}`);
await dispatch(ev);
await sleep(5000);   // chờ hàng đợi Telegram drain (1.1s/tin)
await close();
process.exit(0);
