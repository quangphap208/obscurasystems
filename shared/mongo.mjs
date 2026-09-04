// mongo.mjs — kết nối MongoDB Atlas (driver chính thức), tạo index, expose collections.
// Cả FE (bot) và BE (engine) đều gọi connect() một lần lúc khởi động trước khi dùng repo.
import { MongoClient } from "mongodb";
import { cfg } from "./config.mjs";

let client = null;
let database = null;

export async function connect() {
  if (database) return database;
  // Retry-backoff lúc boot (4/9: máy reboot, DNS chưa sẵn sàng -> connect throw FATAL -> pm2 cạn
  // max_restarts -> app nằm `errored` 26 phút chờ restart tay). Kiên nhẫn chờ TRONG process:
  // 3s -> gấp đôi -> trần 60s, tối đa 10 phút rồi mới chịu chết (không che lỗi cấu hình thật —
  // sai URI/password thì vẫn thấy sau 10 phút, còn mạng chậm vài phút thì tự lành).
  let delay = 3000;
  const deadline = Date.now() + 10 * 60000;
  for (let attempt = 1; ; attempt++) {
    try {
      client = new MongoClient(cfg.mongoUri, { maxPoolSize: 10 });
      await client.connect();
      break;
    } catch (e) {
      await client?.close().catch(() => {});
      client = null;
      if (Date.now() + delay > deadline) throw e;
      console.warn(`[mongo] connect lỗi (lần ${attempt}): ${e.message} — thử lại sau ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }
  database = client.db(cfg.mongoDb);
  // Index idempotent (prod đã có sẵn) — mạng chập chờn ngay sau connect không đáng để chết boot.
  await ensureIndexes(database).catch((e) => console.warn("[mongo] ensureIndexes lỗi (bỏ qua):", e.message));
  return database;
}

export function col(name) {
  if (!database) throw new Error("Mongo chưa connect() — gọi await connect() lúc khởi động.");
  return database.collection(name);
}

export async function close() { if (client) await client.close(); client = null; database = null; }

export const now = () => Date.now();

async function ensureIndexes(db) {
  await db.collection("watches").createIndex({ handle: 1 });
  // unique theo (tg_id, handle, PLATFORM) — cho phép cùng handle trên nhiều nền tảng (X + Truth + IG).
  await db.collection("watches").createIndex({ tg_id: 1, handle: 1, platform: 1 }, { unique: true });
  await db.collection("watches").dropIndex("tg_id_1_handle_1").catch(() => {});   // migrate: bỏ index cũ (thiếu platform -> chặn cross-platform gây E11000)
  await db.collection("referrals").createIndex({ referrer: 1 });
  await db.collection("referrals").createIndex({ referred: 1 });
  // ref_ledger: sổ cái điểm ref (nguồn sự thật để đối soát/đổi thưởng). _id = khoá idempotent
  // (j:<referred> cho join, c:<charge_id> cho convert) -> không double-count kể cả gọi đồng thời.
  await db.collection("ref_ledger").createIndex({ referrer: 1 });
  await db.collection("ref_ledger").createIndex({ referred: 1 });
  await db.collection("tracked_handles").createIndex({ x_user_id: 1 });
  await db.collection("tracked_handles").createIndex({ bloom_account_id: 1 });
  // TTL auto-prune: Mongo tự xoá theo trường Date.
  await db.collection("tweet_cache").createIndex({ seen_at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });
  await db.collection("deliveries").createIndex({ sent_at: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });
  await db.collection("monitor_seen").createIndex({ at: 1 }, { expireAfterSeconds: 24 * 3600 });   // firehose race-mark
  // crypto payment (Phase 2): invoice pending + sig đã xử lý (chống re-parse)
  await db.collection("crypto_invoices").createIndex({ coin: 1, status: 1 });
  await db.collection("crypto_invoices").createIndex({ status: 1, dead_at: 1 });
  await db.collection("crypto_seen").createIndex({ at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });   // sig đã dò (perf)
  // analytics (shared/track.mjs): event log TTL 90 ngày + query theo user/action
  await db.collection("user_actions").createIndex({ at: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
  await db.collection("user_actions").createIndex({ tg_id: 1, at: -1 });
  await db.collection("user_actions").createIndex({ action: 1, at: -1 });
  // payments: audit vĩnh viễn (không TTL) — đối soát doanh thu
  await db.collection("payments").createIndex({ tg_id: 1, at: -1 });
  await db.collection("payments").createIndex({ at: -1 });
}
