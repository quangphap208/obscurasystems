// source-stats.mjs — đếm signup theo nguồn (users.ref_source, set từ deep-link ?start=s_<label>).
//   node scripts/source-stats.mjs
import { connect, close, col } from "../shared/mongo.mjs";

await connect();
const rows = await col("users").aggregate([
  { $group: { _id: "$ref_source", n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
const total = rows.reduce((a, r) => a + r.n, 0);
console.log(`Signup theo nguồn (tổng ${total} user):`);
for (const r of rows) console.log(`  ${(r._id || "(direct / no source)").padEnd(24)} ${r.n}`);
await close();
