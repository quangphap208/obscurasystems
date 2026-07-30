// reset_source.mjs — chuyển tài khoản Bloom sang session mới trong .env và DỌN SẠCH:
// cập nhật shard #1, reset tracked_handles, untrack mọi account ngoài watches, track lại
// đúng danh sách watches + backfill x_user_id. Dùng khi đổi sang tài khoản Bloom RIÊNG.
//   node scripts/reset_source.mjs
import { connect, close, col } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";
import { handshake, fetchState, untrackIds, trackNames, searchUsers } from "../be/lib/tsunami.mjs";

const db = await connect();
const sess = cfg.bloomSessions[0];
if (!sess) { console.error("BLOOM_SESSIONS trống trong .env"); process.exit(1); }

const acc = (await repo.listBloomAccounts(false))[0];
const id = acc?.id || 1;
await repo.upsertBloomAccount({ id, label: acc?.label || `shard-${id}`, session_token: sess, capacity: cfg.bloomCapacity, status: "active" });
await col("tracked_handles").deleteMany({});
console.log(`shard #${id} -> session mới; tracked_handles đã reset.`);

const desired = new Set((await repo.distinctHandles()).map((h) => h.toLowerCase()));
console.log("watches cần giữ:", [...desired].join(", ") || "(rỗng)");

const key = await handshake(sess);
const before = await fetchState(sess, key);
const orphanIds = before.filter((x) => x.twitter_handle && !x.hidden && !desired.has(String(x.twitter_handle).toLowerCase())).map((x) => x.twitter_id).filter(Boolean);
console.log(`ẩn ${orphanIds.length} account thừa (default -> hidden)…`);
for (let i = 0; i < orphanIds.length; i += 100) { await untrackIds(sess, key, orphanIds.slice(i, i + 100)); process.stdout.write("."); }
process.stdout.write("\n");

for (const h of desired) {
  const s = await searchUsers(sess, key, [h]).catch(() => ({ found: [] }));
  const xid = s.found[0]?.id || null;
  await trackNames(sess, key, [h]).catch(() => {});
  await repo.upsertTracked(h, xid, id, await repo.refCount(h));
  if (xid) await col("watches").updateMany({ handle: h }, { $set: { x_user_id: String(xid) } });
  console.log(`  track @${h}${xid ? " (id " + xid + ")" : ""}`);
}

const after = await fetchState(sess, key);
console.log(`\n✅ Xong. Account giờ track ${after.length}: ${after.map((a) => a.twitter_handle).join(", ")}`);
await close();
