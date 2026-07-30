// engine.mjs — entry BE. Khởi động pool Bloom + dispatcher + tracker-sync.
//   node be/engine.mjs
import { cfg, assertBE } from "../shared/config.mjs";
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { Telegram } from "./lib/telegram.mjs";
import { normalize } from "./lib/format.mjs";
import { makeDispatcher } from "./dispatcher.mjs";
import { BloomPool } from "./pool.mjs";
import { TrackerSync } from "./tracker-sync.mjs";

assertBE();

const tg = new Telegram(cfg.botToken);
let botUser = null;
const warmupUntil = Date.now() + cfg.warmupMs;
const dispatch = makeDispatcher({ tg, getBotUser: () => botUser, warmupUntil });

async function main() {
  await connect();
  const me = await tg.getMe();
  botUser = me?.username || null;
  console.log("Obscura Engine | bot:", botUser ? "@" + botUser : "(no buttons)", "| warmup", cfg.warmupMs / 1000 + "s");

  const accounts = await repo.listBloomAccounts(true);
  if (!accounts.length) {
    console.error("❌ Chưa có tài khoản Bloom nào trong pool. Chạy: npm run seed (BLOOM_SESSIONS trong .env).");
    process.exit(1);
  }
  console.log(`Pool: ${accounts.length} tài khoản Bloom`, accounts.map((a) => `#${a.id}(${a.label || "bloom"})`).join(" "));

  const pool = new BloomPool({
    headless: cfg.headless,
    onFrame: (frame) => dispatch(normalize(frame)),
    onExpired: async (acc) => {
      await repo.setBloomStatus(acc.id, "expired");
      for (const id of cfg.adminIds) tg.notify(id, `⚠️ <b>Shard #${acc.id}</b> (${acc.label || "bloom"}) session hết hạn. Cập nhật token rồi restart BE.`);
    },
  });
  const alive = await pool.startAll(accounts);
  console.log(`✅ ${alive}/${accounts.length} shard sống.`);
  if (!alive) { console.error("Không shard nào kết nối được — kiểm tra session Bloom."); process.exit(1); }

  const sync = new TrackerSync({ pool, tg, adminIds: cfg.adminIds });
  sync.start(20000);
  // prune do Mongo TTL index tự lo (tweet_cache, deliveries).

  console.log(`Engine chạy. Bỏ qua backlog ${cfg.warmupMs / 1000}s rồi bắt đầu gửi.`);

  const shutdown = async () => { sync.stop(); await pool.stopAll(); await close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
