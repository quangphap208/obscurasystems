// mongo.mjs — kết nối MongoDB Atlas (driver chính thức), tạo index, expose collections.
// Cả FE (bot) và BE (engine) đều gọi connect() một lần lúc khởi động trước khi dùng repo.
import { MongoClient } from "mongodb";
import { cfg } from "./config.mjs";

let client = null;
let database = null;

export async function connect() {
  if (database) return database;
  client = new MongoClient(cfg.mongoUri, { maxPoolSize: 10 });
  await client.connect();
  database = client.db(cfg.mongoDb);
  await ensureIndexes(database);
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
  await db.collection("tracked_handles").createIndex({ x_user_id: 1 });
  await db.collection("tracked_handles").createIndex({ bloom_account_id: 1 });
  // TTL auto-prune: Mongo tự xoá theo trường Date.
  await db.collection("tweet_cache").createIndex({ seen_at: 1 }, { expireAfterSeconds: 3 * 24 * 3600 });
  await db.collection("deliveries").createIndex({ sent_at: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });
  await db.collection("monitor_seen").createIndex({ at: 1 }, { expireAfterSeconds: 24 * 3600 });   // firehose race-mark
}
