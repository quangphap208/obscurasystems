// engine-j7.mjs — entry BE j7 (nguồn thứ 2). Socket j7 (JWT auth) -> normalize-j7 -> be-core dispatch.
//   node be-j7/engine-j7.mjs   (pm2: kol-be-j7)
// Chạy SONG SONG với be/engine.mjs (Bloom). Dedup CHÉO NGUỒN qua collection `deliveries` chung:
// event nào (cùng dedupKey) được nguồn kia gửi trước thì markDelivered ở đây trả false -> tự bỏ.
// Auth j7 KHÁC Bloom: JWT ~15d tự rotate qua /api/session-check (be-j7/session.mjs).
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cfg, assertBE } from "../shared/config.mjs";
import { connect, close } from "../shared/mongo.mjs";
import { Telegram } from "../be-core/telegram.mjs";
import { makeDispatcher } from "../be-core/dispatch.mjs";
import { J7Feed } from "./j7feed.mjs";
import { normalizeJ7 } from "./normalize-j7.mjs";
import { TrackerSyncJ7 } from "./tracker-sync-j7.mjs";
import { loadToken, saveToken, sessionCheck, daysLeft } from "./session.mjs";
import { slackAlert } from "../shared/slack.mjs";
import { makeFeedWatchdog } from "../be-core/watchdog.mjs";
import { makeExpandBuffer } from "./expand-buffer.mjs";

assertBE();
if (!cfg.j7Session) { console.error("❌ Thiếu J7_SESSION_TOKEN trong .env — BE j7 không chạy."); await slackAlert("❌ *j7* BE: thiếu J7_SESSION_TOKEN — không chạy."); process.exit(1); }

const __dir = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(__dir, "state", "j7_token.txt");
const WARMUP_MS = cfg.warmupMs;

const tg = new Telegram(cfg.botToken);
let botUser = null;
let token = loadToken(TOKEN_FILE, cfg.j7Session);
// warmupUntil cố định lúc start: nuốt backlog initialTweets đầu tiên. Reconnect replay được
// deliveries dedup lo (đã gửi -> bỏ; chưa gửi -> catch-up), nên không cần reset per-connect.
const dispatch = makeDispatcher({ tg, getBotUser: () => botUser, warmupUntil: Date.now() + WARMUP_MS });
// watchdog: mỗi event feed j7 -> touch(); im lặng > feedSilenceMin phút -> Slack (socket treo ngầm).
const watchdog = makeFeedWatchdog({ source: "j7", silenceMinutes: cfg.feedSilenceMin, tg, adminIds: cfg.adminIds });
// buffer 2 pha: tweet `tweet` (snapshot cắt) -> đợi `tweet_update` isExpandedUpdate (đầy đủ) thay thế.
const buf = makeExpandBuffer({ dispatch });
const TWEET_KINDS = new Set(["tweet", "retweet", "quote", "reply"]);

function onEvent(raw, kind) {
  watchdog.touch();
  try {
    if (kind === "update") {
      if (!raw?.isExpandedUpdate) return;              // update chỉ metric/edit -> bỏ; chỉ nhận bản mở rộng
      const ev = normalizeJ7(raw, "tweet");            // isExpandedUpdate = tweet ĐẦY ĐỦ (full text/media/type)
      if (ev) { ev.source = "j7"; buf.expanded(ev); }
      return;
    }
    const out = normalizeJ7(raw, kind);
    if (!out) return;                                  // profile trả MẢNG (1 event / field); còn lại 1 event
    for (const e of (Array.isArray(out) ? out : [out])) {
      e.source = "j7";
      // tweet-like -> qua buffer (đợi expansion nếu cắt); follow/pin/profile/platform -> gửi thẳng.
      if (TWEET_KINDS.has(e.kind)) buf.tweet(e, raw); else dispatch(e);
    }
  } catch (err) { console.warn("[j7 normalize]", err.message); }
}

let sessionAlerted = false;
async function alertSession(msg) {
  if (sessionAlerted) return;
  sessionAlerted = true;
  for (const id of cfg.adminIds)
    tg.notify(id, `⚠️ <b>BE j7 session lỗi</b> — ${msg}. Cập nhật <code>J7_SESSION_TOKEN</code> trong .env (đăng nhập lại lấy localStorage.sessionId) rồi restart be-j7.`);
  await slackAlert(`⚠️ *j7* session lỗi — ${msg}. Cập nhật J7_SESSION_TOKEN + restart be-j7.`);
  console.error("[j7 session]", msg);
}

async function main() {
  await connect();
  const me = await tg.getMe();
  botUser = me?.username || null;
  const dl = daysLeft(token);
  console.log("Obscura BE-j7 | bot:", botUser ? "@" + botUser : "(no buttons)",
    "| token còn:", Number.isFinite(dl) ? dl.toFixed(1) + "d" : "?", "| warmup", WARMUP_MS / 1000 + "s");

  const feed = new J7Feed({
    host: cfg.j7Host, token,
    onEvent,
    onLog: (m) => console.log(m),
    onAuthError: (m) => alertSession(m),
  });
  feed.start();
  if (cfg.feedSilenceMin > 0) { watchdog.start(); console.log(`Watchdog: alert nếu feed im lặng > ${cfg.feedSilenceMin} phút.`); }
  console.log(`✅ BE-j7 chạy (socket ${cfg.j7Host}). Nuốt backlog initialTweets + ${WARMUP_MS / 1000}s warmup.`);

  // tracker-sync: add pool account (watched ∩ pool) vào feed + lưu j7_list (cover main ∪ pool).
  let sync = null;
  if (cfg.observeOnly) {
    console.log("👁  OBSERVE_ONLY: KHÔNG add/remove pool j7 — chỉ nghe feed (j7 account chung không đổi).");
  } else {
    sync = new TrackerSyncJ7({ feed, adminIds: cfg.adminIds });
    sync.start(300000);
    console.log("j7 tracker-sync: reconcile watched ∩ j7-list mỗi 5 phút (add/remove pool + lưu j7_list).");
  }

  // keepalive: định kỳ validate token; server rotate (X-New-Token) -> lưu đè + áp reconnect.
  let keepaliveTimer = null;
  if (cfg.j7KeepaliveHours > 0) {
    const tick = async () => {
      try {
        const r = await sessionCheck(cfg.j7Host, token);
        if (r.rotated) { token = r.rotated; saveToken(TOKEN_FILE, token); feed.updateToken(token); console.log("🔄 j7 token rotated -> state/j7_token.txt"); }
        else if (!r.valid) await alertSession("session-check trả valid=false");
        else console.log(`[j7 keepalive] ok, token còn ${daysLeft(token).toFixed(1)}d`);
      } catch (e) { console.warn("[j7 keepalive]", e.message); }
    };
    keepaliveTimer = setInterval(tick, cfg.j7KeepaliveHours * 3600000);
  }

  const shutdown = async () => { sync?.stop(); watchdog.stop(); buf.stop(); clearInterval(keepaliveTimer); feed.stop(); await close().catch(() => {}); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (e) => { console.error("FATAL", e); await slackAlert(`❌ *j7* engine FATAL: ${e.message}`); process.exit(1); });
