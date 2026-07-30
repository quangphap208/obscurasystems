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
