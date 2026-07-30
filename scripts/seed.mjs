// seed.mjs — nạp pool Bloom vào DB từ .env, tạo user test (tuỳ chọn). `npm run seed`.
//   BLOOM_SESSIONS=token1,token2   (mỗi token = 1 shard)
//   BLOOM_CAPACITY=200             (cap mỗi shard)
//   SEED_USER=<tg_id>              (tuỳ chọn: tạo user Pro để test)
//   SEED_WATCH=elonmusk,cz_binance (tuỳ chọn: handle cho SEED_USER)
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";

await connect();

// 1) pool Bloom
if (cfg.bloomSessions.length) {
  let id = 1;
  for (const token of cfg.bloomSessions) {
    await repo.upsertBloomAccount({ id, label: `shard-${id}`, session_token: token, capacity: cfg.bloomCapacity, status: "active" });
    console.log(`✅ bloom_account #${id} (cap ${cfg.bloomCapacity})`);
    id++;
  }
} else {
  console.log("⚠️ BLOOM_SESSIONS trống — chưa nạp shard nào.");
}

// 2) user test (tuỳ chọn)
const seedUser = Number(process.env.SEED_USER || 0);
if (seedUser) {
  await repo.ensureUser(seedUser, process.env.SEED_USERNAME || "tester");
  await repo.setUserPlan(seedUser, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: Date.now() + cfg.proDays * 86400000 });
  for (const h of (process.env.SEED_WATCH || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    await repo.addWatch(seedUser, h);
    console.log(`   watch @${h}`);
  }
  console.log(`✅ user ${seedUser} = Pro, limit ${cfg.proLimit}`);
}

console.log("Pool hiện tại:", (await repo.listBloomAccounts(false)).map((a) => `#${a.id}:${a.status}`).join(" ") || "(trống)");
await close();
