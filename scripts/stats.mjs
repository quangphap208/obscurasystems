// stats.mjs — refresh + in bảng: mỗi bot-user đã add bao nhiêu account X (ngoài default),
// và tổng account custom đang track so với capacity pool.
//   node scripts/stats.mjs
import { connect, close, col } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";

await connect();
await repo.refreshUserStats();

const totals = await col("user_stats").findOne({ _id: "__totals__" });
const rows = await col("user_stats").find({ _id: { $ne: "__totals__" } }).sort({ added: -1 }).toArray();

const cap = totals?.capacity ? ` / ${totals.capacity}` : "";
console.log(`\n📊 Account custom (ngoài default): ${totals?.custom_accounts ?? 0}${cap}   ·   ${totals?.users ?? 0} user\n`);
console.log(`  ${"user".padEnd(22)} ${"add".padStart(3)}  tier    handles`);
console.log("  " + "─".repeat(70));
for (const r of rows) {
  const who = r.username ? "@" + r.username : String(r._id);
  const hs = r.handles.slice(0, 8).join(", ") + (r.handles.length > 8 ? ` …(+${r.handles.length - 8})` : "");
  console.log(`  ${who.padEnd(22)} ${String(r.added).padStart(3)}  ${String(r.tier || "Free").padEnd(6)}  ${hs}`);
}
if (!rows.length) console.log("  (chưa user nào add account)");
console.log();
await close();
