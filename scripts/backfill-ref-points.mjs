// backfill-ref-points.mjs — cộng điểm JOIN cho các referral đã ghi TRƯỚC khi có cơ chế points.
// AN TOÀN idempotent: mỗi (referred) chỉ được thưởng join 1 lần (ledger _id=j:<referred>) -> chạy lại
// KHÔNG cộng trùng. Chỉ thưởng khi users.referred_by === referrer (đúng nguồn first-touch).
// Convert (payment) KHÔNG backfill được (không có lịch sử charge_id) -> chỉ từ nay về sau.
//   node scripts/backfill-ref-points.mjs
import { connect, close, col } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";

await connect();
const rows = await col("referrals").find({}).project({ referrer: 1, referred: 1 }).toArray();
let awarded = 0, points = 0, skipped = 0;
for (const r of rows) {
  const pts = await repo.recordReferralOnStart(r.referrer, r.referred);
  if (pts > 0) { awarded++; points += pts; console.log(`✓ +${pts} -> referrer ${r.referrer} (join ${r.referred})`); }
  else skipped++;
}
console.log(`\n==== XONG ====`);
console.log(`referrals quét : ${rows.length}`);
console.log(`✓ cộng mới     : ${awarded} referral (+${points} điểm)`);
console.log(`⊘ bỏ qua       : ${skipped} (đã cộng trước / sai nguồn)`);
await close();
