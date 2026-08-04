// clone_db.mjs — copy collection STATE từ prod (redacted_clone) sang DB test (MONGODB_DB).
// CHỈ ĐỌC prod, GHI test. Additive upsert theo _id (giữ data test-only, prod thắng khi trùng).
// BỎ: deliveries / monitor_seen / tweet_cache (transient/dedup — muốn test noti tươi, không kế thừa).
//   MONGODB_DB=obscura_test node scripts/clone_db.mjs
//   CLONE_FROM=<db> để đổi nguồn.
import { MongoClient } from "mongodb";
import { cfg } from "../shared/config.mjs";

const SRC = process.env.CLONE_FROM || "redacted_clone";
const DST = cfg.mongoDb;
if (DST === SRC) { console.error(`❌ Target = source (${DST}). Đặt MONGODB_DB khác (vd obscura_test).`); process.exit(1); }
if (DST === "redacted_clone" && process.env.ALLOW_PROD !== "1") { console.error("❌ Target là prod — không clone ngược."); process.exit(1); }

const COLLECTIONS = ["bloom_accounts", "tracked_handles", "watches", "users", "profile_snap", "j7_list", "referrals"];

const client = new MongoClient(cfg.mongoUri, { maxPoolSize: 10 });
await client.connect();
const src = client.db(SRC), dst = client.db(DST);
console.log(`clone ${SRC} -> ${DST} (additive) …`);
for (const name of COLLECTIONS) {
  const docs = await src.collection(name).find({}).toArray();
  if (!docs.length) { console.log(`  ${name}: 0 (bỏ)`); continue; }
  const ops = docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } }));
  const r = await dst.collection(name).bulkWrite(ops, { ordered: false });
  console.log(`  ${name}: ${docs.length} doc (upserted ${r.upsertedCount}, replaced ${r.modifiedCount})`);
}
console.log(`✅ Xong. BỎ deliveries/monitor_seen/tweet_cache. Giờ chạy được: MONGODB_DB=${DST} npm run be`);
await client.close();
