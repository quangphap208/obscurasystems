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
  // giá / gói (có thể override qua env)
  proPriceStars: Number(process.env.PRO_PRICE_STARS || 500),
  proDays: Number(process.env.PRO_DAYS || 30),
  proLimit: Number(process.env.PRO_LIMIT || 25),
  freeLimit: Number(process.env.FREE_LIMIT || 3),
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
