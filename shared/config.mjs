// config.mjs — nạp .env (không cần dependency) + expose cấu hình dùng chung FE/BE.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

function loadEnv() {
  let raw = "";
  try { raw = readFileSync(join(ROOT, ".env"), "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m || m[1] in process.env) continue;
    let v = m[2];
    // cắt inline comment " #..." (chỉ khi giá trị KHÔNG bọc trong dấu nháy)
    if (!/^\s*["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    v = v.trim().replace(/^["']|["']$/g, "");
    process.env[m[1]] = v;
  }
}
loadEnv();

const intList = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => !Number.isNaN(n));

export const ROOT_DIR = ROOT;
export const cfg = {
  botToken: process.env.BOT_TOKEN || "",
  mongoUri: process.env.MONGODB_URI || "",       // Atlas connection string
  mongoDb: process.env.MONGODB_DB || "redacted_clone",
  adminIds: intList(process.env.ADMIN_IDS),
  // pool: session Bloom seed lúc chạy scripts/seed.mjs (sau đó nguồn thật là bảng bloom_accounts)
  bloomSessions: (process.env.BLOOM_SESSIONS || "")
    .split(",").map((s) => s.trim()).filter(Boolean),
  bloomCapacity: Number(process.env.BLOOM_CAPACITY || 200),
  // exclusive: reconciler untrack MỌI account không nằm trong watches (giữ tài khoản Bloom sạch).
  // CHỈ bật khi tài khoản Bloom DÙNG RIÊNG cho Obscura — bật nhầm trên account chung sẽ xoá hết list bên kia.
  sourceExclusive: process.env.SOURCE_EXCLUSIVE === "1",
  // thanh toán: Telegram Stars (XTR). providerToken rỗng = Stars; hoặc token nhà cung cấp khác.
  starsProviderToken: process.env.STARS_PROVIDER_TOKEN || "",
  // giá / gói (override qua env). Chi tiết + lý do: docs/PAYMENT_RESEARCH.md §2.
  freeLimit: Number(process.env.FREE_LIMIT || 3),                 // Free: vĩnh viễn, không hết hạn
  proLimit: Number(process.env.PRO_LIMIT || 30),
  proPriceStars: Number(process.env.PRO_PRICE_STARS || 1000),     // ~$20 (USD×1.3)
  proPriceUsd: Number(process.env.PRO_PRICE_USD || 15),           // giá crypto
  proDays: Number(process.env.PRO_DAYS || 30),
  whaleLimit: Number(process.env.WHALE_LIMIT || 100),
  whalePriceStars: Number(process.env.WHALE_PRICE_STARS || 2600), // ~$52
  whalePriceUsd: Number(process.env.WHALE_PRICE_USD || 40),
  whaleDays: Number(process.env.WHALE_DAYS || 30),
  packSize: Number(process.env.PACK_SIZE || 10),                  // add-on: +N acc, one-time đến hết hạn tier
  packPriceStars: Number(process.env.PACK_PRICE_STARS || 400),    // ~$8
  packPriceUsd: Number(process.env.PACK_PRICE_USD || 6),
  // --- Crypto payment (Phase 2): CHỈ Solana — USDC/USDT-SPL + SOL. docs/PAYMENT_RESEARCH.md §3-5 ---
  // NHIỀU ví + NHIỀU RPC (CSV): spread invoice qua các ví, round-robin/failover RPC. Trống = TẮT crypto.
  receiveSolAddresses: (process.env.RECEIVE_SOL_ADDRESS || "").split(",").map((s) => s.trim()).filter(Boolean),
  solanaRpcUrls: (process.env.SOLANA_RPC_URL || "").split(",").map((s) => s.trim()).filter(Boolean),
  usdcMint: process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  usdtMint: process.env.USDT_MINT || "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  cryptoWindowMin: Number(process.env.CRYPTO_WINDOW_MIN || 30),   // thời hạn hiển thị invoice (phút)
  cryptoLateGraceH: Number(process.env.CRYPTO_LATE_GRACE_H || 24),// vẫn khớp tx trễ trong N giờ
  cryptoPollSec: Number(process.env.CRYPTO_POLL_SEC || 25),       // chu kỳ dò chain (giây)
  // Sweep hạ gói hết hạn -> Free + pause watch vượt Free (expiry-downgrade). docs/PAYMENT_RESEARCH.md §9.
  expirySweepMin: Number(process.env.EXPIRY_SWEEP_MIN || 60),     // chu kỳ quét (phút). 0 vẫn chạy 60' (an toàn)
  // --- Referral: GHI NHẬN points (quy đổi thưởng định sau). Cộng ở 2 mốc: join + convert(payment). ---
  refJoinPoints: Number(process.env.REF_JOIN_POINTS || 10),         // điểm khi 1 người MỚI join qua link
  refPointsPerStar: Number(process.env.REF_POINTS_PER_STAR || 0.1), // điểm / 1 Star referred chi (Telegram XTR)
  refPointsPerUsd: Number(process.env.REF_POINTS_PER_USD || 5),     // điểm / 1 USD referred chi qua crypto (USDT/SOL/ERC20)
  botLabel: process.env.BOT_LABEL || "🕶️ Obscura",
  supportContact: process.env.SUPPORT_CONTACT || "",   // vd @obscura_support (dùng cho /support)
  warmupMs: Number(process.env.WARMUP_MS || 12000),
  headless: process.env.HEADLESS !== "0",
  // profile-poller: tự dò đổi avatar/name/verified qua search (tracker-state Bloom quá chậm).
  profilePoll: process.env.PROFILE_POLL !== "0",
  profilePollMs: Number(process.env.PROFILE_POLL_MS || 120000),   // fallback 2 phút (feed-driven lo real-time)
  // /subscribe: MẶC ĐỊNH TẮT (giai đoạn test). Đặt SUBS_ENABLED=1 khi mở bán Pro.
  subsEnabled: process.env.SUBS_ENABLED === "1",
  // --- BE j7 (nguồn thứ 2, chạy song song Bloom) — auth JWT socket, KHÁC Bloom hoàn toàn (xem be-j7/). ---
  j7Host: process.env.J7_HOST || "https://nyc.j7tracker.io",   // host socket + /api/session-check
  j7Session: process.env.J7_SESSION_TOKEN || "",               // JWT gốc = localStorage.sessionId trên j7tracker.io
  j7KeepaliveHours: Number(process.env.J7_KEEPALIVE_HOURS || 6), // chu kỳ validate + rotate token
  // Monitor firehose (TEST/QC): copy MỌI event (cả 2 nguồn) + race-outcome vào 1 channel. Trống = TẮT
  // (prod không đụng). Đặt = chat_id channel test để soi merge 2 BE ở local. buildMessage FULL render.
  monitorChat: process.env.MONITOR_CHAT || "",
  // MONITOR_ONLY (TEST): chỉ gửi monitor channel, BỎ vòng DM user (test DB clone watches prod nhưng
  // user chưa /start bot test -> 400 chat-not-found). Mặc định tắt -> prod DM bình thường.
  monitorOnly: process.env.MONITOR_ONLY === "1",
  // OBSERVE_ONLY (TEST): tắt tracker-sync cả 2 BE -> CHỈ tap feed read-only, KHÔNG track/untrack ->
  // account Bloom/j7 chung KHÔNG đổi -> prod không ảnh hưởng. Chạy local nghe ké feed prod đang track.
  observeOnly: process.env.OBSERVE_ONLY === "1",
  // Slack Incoming Webhook: alert lỗi Bloom/j7 (session expired / auth / FATAL). Trống = tắt. Để trong .env.
  slackWebhook: process.env.SLACK_WEBHOOK || "",
  // Feed watchdog: báo Slack khi feed IM LẶNG > N phút (WS treo/rớt ngầm, không expired/FATAL). 0 = tắt.
  feedSilenceMin: Number(process.env.FEED_SILENCE_MIN || 10),
};

export function assertFE() {
  if (!cfg.botToken) throw new Error("Thiếu BOT_TOKEN trong .env");
  if (!cfg.mongoUri) throw new Error("Thiếu MONGODB_URI trong .env (Atlas connection string)");
}
export function assertBE() {
  if (!cfg.botToken) throw new Error("Thiếu BOT_TOKEN trong .env (BE cần để gửi DM)");
  if (!cfg.mongoUri) throw new Error("Thiếu MONGODB_URI trong .env (Atlas connection string)");
}
export const isAdmin = (tgId) => cfg.adminIds.includes(Number(tgId));
