// engine.mjs — entry BE. Khởi động pool Bloom + dispatcher + tracker-sync.
//   node be/engine.mjs
import { cfg, assertBE } from "../shared/config.mjs";
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { Telegram } from "../be-core/telegram.mjs";
import { normalize } from "./normalize.mjs";
import { makeDispatcher } from "../be-core/dispatch.mjs";
import { BloomPool } from "./pool.mjs";
import { TrackerSync } from "./tracker-sync.mjs";
import { ProfilePoller } from "./profile-poller.mjs";
import { slackAlert } from "../shared/slack.mjs";
import { makeFeedWatchdog } from "../be-core/watchdog.mjs";

assertBE();

const tg = new Telegram(cfg.botToken);
let botUser = null;
const warmupUntil = Date.now() + cfg.warmupMs;
const dispatch = makeDispatcher({ tg, getBotUser: () => botUser, warmupUntil });
// Tag nguồn=bloom cho mọi event Bloom (gate source-preference profile + metric race ở dispatch).
const dispatchBloom = (e) => { if (e) e.source = "bloom"; return dispatch(e); };

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

  // watchdog: mỗi frame Bloom -> touch(); im lặng > feedSilenceMin phút -> Slack (WS treo ngầm).
  const watchdog = makeFeedWatchdog({ source: "Bloom", silenceMinutes: cfg.feedSilenceMin, tg, adminIds: cfg.adminIds });

  let poller = null;   // gán bên dưới; onFrame tham chiếu qua closure (chạy sau khi đã gán).
  const pool = new BloomPool({
    headless: cfg.headless,
    onFrame: (frame) => { watchdog.touch(); poller?.observeFrame(frame); dispatchBloom(normalize(frame)); },
    onExpired: async (acc) => {
      await repo.setBloomStatus(acc.id, "expired");
      for (const id of cfg.adminIds) tg.notify(id, `⚠️ <b>Shard #${acc.id}</b> (${acc.label || "source"}) session expired. Update the token and restart the engine.`);
      await slackAlert(`⚠️ *Bloom* shard #${acc.id} (${acc.label || "source"}) session EXPIRED — cập nhật token + restart engine.`);
    },
  });
  const alive = await pool.startAll(accounts);
  console.log(`✅ ${alive}/${accounts.length} shard sống.`);
  if (!alive) { console.error("Không shard nào kết nối được — kiểm tra session Bloom."); await slackAlert("❌ *Bloom* engine: không shard nào kết nối được — kiểm tra session Bloom."); process.exit(1); }
  if (cfg.feedSilenceMin > 0) { watchdog.start(); console.log(`Watchdog: alert nếu feed im lặng > ${cfg.feedSilenceMin} phút.`); }

  let sync = null;
  if (cfg.observeOnly) {
    console.log("👁  OBSERVE_ONLY: KHÔNG track/untrack — chỉ tap feed read-only (tracked-set Bloom prod không đổi).");
  } else {
    sync = new TrackerSync({ pool, tg, adminIds: cfg.adminIds });
    sync.start(20000);
  }
  // prune do Mongo TTL index tự lo (tweet_cache, deliveries).

  // profile-poller: feed-driven (real-time cho account có tweet) + poll fallback cho account im lặng.
  if (cfg.profilePoll) {
    poller = new ProfilePoller({ pool, dispatch: dispatchBloom, adminIds: cfg.adminIds });
    poller.start(cfg.profilePollMs);
    console.log(`Profile: feed-driven real-time + poll fallback mỗi ${cfg.profilePollMs / 1000}s (avatar/name/verified).`);
  }

  // user_stats: rollup định kỳ (xem trong Atlas / scripts/stats.mjs) — ai add bao nhiêu account.
  repo.refreshUserStats().catch(() => {});
  const statsTimer = setInterval(() => repo.refreshUserStats().catch(() => {}), 60000);

  console.log(`Engine chạy. Bỏ qua backlog ${cfg.warmupMs / 1000}s rồi bắt đầu gửi.`);

  const shutdown = async () => { sync?.stop(); poller?.stop(); watchdog.stop(); clearInterval(statsTimer); await pool.stopAll(); await close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (e) => { console.error("FATAL", e); await slackAlert(`❌ *Bloom* engine FATAL: ${e.message}`); process.exit(1); });
