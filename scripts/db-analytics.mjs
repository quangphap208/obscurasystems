// db-analytics.mjs — tổng quan DB (user growth, tier/trial, source, referral, watches, payment).
//   node scripts/db-analytics.mjs
import { connect, close, col } from "../shared/mongo.mjs";

await connect();
const now = Date.now();
const users = col("users"), watches = col("watches"), invoices = col("crypto_invoices"), referrals = col("referrals");
const grp = (c, field) => c.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
const line = (a) => a.map((x) => `${x._id ?? "(none)"}=${x.n}`).join(" · ");

const total = await users.countDocuments();
const byTier = await grp(users, "tier");
const trialActive = await users.countDocuments({ tier: "Free", expires_at: { $gt: now } });
const trialExpired = await users.countDocuments({ tier: "Free", expires_at: { $lte: now } });
const paidActive = await users.countDocuments({ tier: { $in: ["Pro", "Whale"] }, expires_at: { $gt: now } });
const paidExpired = await users.countDocuments({ tier: { $in: ["Pro", "Whale"] }, expires_at: { $lte: now } });
const whitelist = await users.countDocuments({ tier: "Whitelist" });
const byDay = await users.aggregate([
  { $group: { _id: { $dateToString: { format: "%m-%d", date: { $toDate: "$created_at" } } }, n: { $sum: 1 } } },
  { $sort: { _id: 1 } },
]).toArray();

const bySource = await grp(users, "ref_source");
const refRows = await referrals.countDocuments();
const referred = await users.countDocuments({ referred_by: { $ne: null } });
const withPoints = await users.countDocuments({ points: { $gt: 0 } });

const totalW = await watches.countDocuments();
const byPlat = await grp(watches, "platform");
const paused = await watches.countDocuments({ paused: true });
const distinct = (await watches.distinct("handle")).length;
const withWatch = (await watches.distinct("tg_id")).length;
const top = await watches.aggregate([{ $group: { _id: "$handle", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 15 }]).toArray();

const invStatus = await invoices.aggregate([{ $group: { _id: "$status", n: { $sum: 1 }, usd: { $sum: "$price_usd" } } }]).toArray();
const revenue = invStatus.filter((i) => i._id === "paid").reduce((a, i) => a + (i.usd || 0), 0);

console.log("════════════ DB ANALYTICS ════════════");
console.log(`USERS: ${total} total`);
console.log(`  tier: ${line(byTier)}`);
console.log(`  trial active=${trialActive} · trial expired=${trialExpired} · paid active=${paidActive} · paid expired=${paidExpired} · whitelist=${whitelist}`);
console.log(`  new/day: ${byDay.map((d) => `${d._id}:${d.n}`).join("  ")}`);
console.log(`SOURCE: ${line(bySource) || "(none)"}`);
console.log(`REFERRAL: rows=${refRows} · referred users=${referred} · users w/ points>0=${withPoints}`);
console.log(`WATCHES: ${totalW} total · ${distinct} distinct handles · ${paused} paused · ${withWatch}/${total} users tracking`);
console.log(`  by platform: ${line(byPlat)}`);
console.log(`  top handles: ${top.map((h) => `${h._id}(${h.n})`).join(" · ")}`);
console.log(`PAYMENTS (crypto invoices): ${line(invStatus) || "(none)"}`);
console.log(`  crypto revenue (paid): $${revenue}`);
console.log(`  paid conversions (tier Pro/Whale, Stars+crypto): ${paidActive + paidExpired}`);
await close();
