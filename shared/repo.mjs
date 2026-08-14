// repo.mjs — data access layer (MongoDB Atlas) dùng chung FE (bot) và BE (engine).
// Mọi hàm async. Gọi await connect() (shared/mongo.mjs) một lần lúc khởi động trước khi dùng.
//
// Model:
//   users{_id=tg_id, tg_id, username, tier, account_limit, expires_at, referred_by, points, created_at, settings{20 khoá}}
//   watches{_id=`tg:handle`, tg_id, handle, x_user_id, settings{}|null, created_at}
//   referrals{_id=`a:b`, referrer, referred, subscribed, created_at}
//   ref_ledger{_id=`j:<referred>`|`c:<charge_id>`, referrer, referred, kind:join|convert, points, amount?, currency?, charge_id?, at}
//   bloom_accounts{_id=id, label, session_token, capacity, status, expires_at}
//   tracked_handles{_id=handle, x_user_id, bloom_account_id, ref_count, last_event_at}
//   tweet_cache{_id=tweet_id, author_handle, text, media, is_retweet, rt_source, seen_at:Date}
//   deliveries{_id=`key:tg`, dedup_key, tg_id, sent_at:Date}
import { col, now } from "./mongo.mjs";
import { DEFAULTS, byCol } from "./settings.mjs";
import { cfg } from "./config.mjs";

const SET_COLS = Object.keys(DEFAULTS);
// _id watch: X giữ `tg:handle` (khỏi migrate); platform khác (truth/ig) dùng `tg:platform:handle`.
const wid = (tgId, handle, platform = "x") =>
  platform === "x" ? `${tgId}:${handle.toLowerCase()}` : `${tgId}:${platform}:${handle.toLowerCase()}`;
// Lọc watch X (doc cũ không có field platform -> coi là "x"). Để platform watch KHÔNG lọt vào flow X.
const X_ONLY = { $or: [{ platform: "x" }, { platform: { $exists: false } }] };
const settingsOf = (obj) => Object.fromEntries(SET_COLS.map((c) => [c, obj?.[c] ?? DEFAULTS[c]]));

// ---------- users ----------
export async function getUser(tgId) { return col("users").findOne({ _id: Number(tgId) }); }

export async function ensureUser(tgId, username, referredBy = null, source = null) {
  tgId = Number(tgId);
  const existing = await getUser(tgId);
  if (existing) {
    const set = {};
    if (username && username !== existing.username) set.username = username;
    // Free-tier: account_limit bám cfg.freeLimit hiện tại (Pro giữ limit cố định lúc nâng gói).
    if (existing.tier === "Free" && existing.account_limit !== cfg.freeLimit) set.account_limit = cfg.freeLimit;
    // Free-forever cũ (expires_at=null) -> BẬT TRIAL: hạn tính từ /start này (migrate 1 lần).
    if (existing.tier === "Free" && existing.expires_at == null) set.expires_at = now() + cfg.trialDays * 86400000;
    if (Object.keys(set).length) await col("users").updateOne({ _id: tgId }, { $set: set });
    return getUser(tgId);
  }
  const ref = referredBy && Number(referredBy) !== tgId ? Number(referredBy) : null;
  await col("users").insertOne({
    _id: tgId, tg_id: tgId, username: username || null, tier: "Free",
    account_limit: cfg.freeLimit, expires_at: now() + cfg.trialDays * 86400000, referred_by: ref, points: 0,
    ref_source: source || null,   // nguồn/campaign (first-touch) từ deep-link ?start=s_<label>
    addon_packs: 0, expired_notified: false, created_at: now(), settings: { ...DEFAULTS },
  });
  if (ref && (await getUser(ref))) await addReferral(ref, tgId);
  return getUser(tgId);
}

export async function setUserPlan(tgId, { tier, accountLimit, expiresAt } = {}) {
  const set = {};
  if (tier != null) set.tier = tier;
  if (accountLimit != null) set.account_limit = accountLimit;
  if (expiresAt !== undefined) set.expires_at = expiresAt;   // null = xoá hạn (Whitelist/Free), số = đặt hạn
  if (Object.keys(set).length) await col("users").updateOne({ _id: Number(tgId) }, { $set: set });
  return getUser(tgId);
}

export const isExpired = (u) => !u || !u.expires_at || u.expires_at < now();
export const isActive = (u) => !!u && !!u.expires_at && u.expires_at >= now();
// Có quyền dùng dịch vụ = đang trong trial/gói còn hạn HOẶC Whitelist vĩnh viễn (admin cấp không đặt hạn).
export const hasAccess = (u) => !!u && (isActive(u) || (u.tier === "Whitelist" && !u.expires_at));

// ---------- plans / purchase (Phase 1: Stars) — đồng hồ tính từ NGÀY MUA. docs/PAYMENT_RESEARCH.md §2/§9 ----------
export function baseLimit(tier) {
  if (tier === "Whale") return cfg.whaleLimit;
  if (tier === "Pro") return cfg.proLimit;
  return cfg.freeLimit;
}
// kind ∈ {pro, whale, pack}. Trả kết quả để bot báo user; null nếu user không tồn tại;
// {error:"no_active_plan"} nếu mua pack khi KHÔNG có gói trả phí còn hạn.
export async function applyPurchase(tgId, kind) {
  tgId = Number(tgId);
  const u = await getUser(tgId);
  if (!u) return null;
  if (kind === "pack") {
    if (!isActive(u)) return { error: "no_active_plan" };               // pack chỉ cộng lên tier có phí còn hạn
    const packs = (u.addon_packs || 0) + 1;
    const limit = baseLimit(u.tier) + packs * cfg.packSize;
    await col("users").updateOne({ _id: tgId }, { $set: { addon_packs: packs, account_limit: limit } });
    return { kind, tier: u.tier, packs, account_limit: limit };
  }
  const tier = kind === "whale" ? "Whale" : "Pro";
  const days = kind === "whale" ? cfg.whaleDays : cfg.proDays;
  const limit = baseLimit(tier);
  // GIA HẠN STACK: cộng dồn thời gian CÒN LẠI (gia hạn sớm không mất ngày). Mua mới/hết hạn = từ NGÀY MUA.
  const from = u.expires_at && u.expires_at > now() ? u.expires_at : now();
  const expiresAt = from + days * 86400000;
  // reset packs (one-time đến hết hạn tier).
  await col("users").updateOne({ _id: tgId }, { $set: { tier, account_limit: limit, expires_at: expiresAt, addon_packs: 0, expired_notified: false } });
  await col("watches").updateMany({ tg_id: tgId, paused: true }, { $set: { paused: false } });   // gia hạn/nâng cấp -> BỎ pause
  return { kind, tier, account_limit: limit, expires_at: expiresAt, days };
}

// ---------- payments (audit trail thống nhất Stars + crypto — gap docs/DASHBOARD.md §2) ----------
// _id idempotent theo ref (charge_id Stars / tx sig crypto) -> retry/re-parse không double-record.
// amount: Stars = số sao (int) · crypto = chuỗi display ("10.000482"). usd: crypto = price_usd, Stars = null.
export async function recordPayment({ tgId, method, kind, amount, currency, usd = null, ref }) {
  try {
    await col("payments").updateOne(
      { _id: `${method}:${ref}` },
      { $setOnInsert: { tg_id: Number(tgId), method, kind, amount, currency, usd, ref, at: now() } },
      { upsert: true });
  } catch (e) { console.warn("[payments]", e.message); }   // audit không được làm hỏng flow credit
}

// delivery_stats: rollup /ngày số DM noti đã gửi. Dispatcher đếm in-memory, flush $inc mỗi 60s
// (_id = "YYYY-MM-DD", inc = {n, kind.<kind>, src.<source>}). Mất tối đa 60s data khi restart — chấp nhận.
export async function bumpDeliveryStats(date, inc) {
  await col("delivery_stats").updateOne({ _id: date }, { $inc: inc, $set: { updated_at: now() } }, { upsert: true });
}

// Sweep HẾT HẠN (trial Free HOẶC gói trả phí) -> PAUSE toàn bộ watch (X + platform), báo 1 lần.
// Không còn free-forever: hết hạn = ngừng dịch vụ tới khi /subscribe. Gia hạn (applyPurchase) un-pause hết.
// Giữ expires_at (quá khứ) + expired_notified=true -> không sweep/notify lại. docs/PAYMENT_RESEARCH.md §9.
export async function sweepExpired() {
  const expired = await col("users")
    .find({ expires_at: { $ne: null, $lt: now() }, expired_notified: { $ne: true } })
    .project({ _id: 1, tier: 1 }).toArray();
  const out = [];
  for (const u of expired) {
    await col("watches").updateMany({ tg_id: u._id }, { $set: { paused: true } });
    await col("users").updateOne({ _id: u._id }, { $set: { expired_notified: true } });
    out.push({ tgId: u._id, tier: u.tier });   // tier="Free" => hết trial; else => gói trả phí hết hạn
  }
  return out;
}

// ---------- crypto invoices (Phase 2) — auto-poll + unique-amount. docs/PAYMENT_RESEARCH.md §4 ----------
export async function createCryptoInvoice({ tgId, kind, coin, mint, decimals, expectBase, display, priceUsd, address, windowMin, graceH }) {
  const created = now();
  const doc = {
    _id: `${Number(tgId)}:${coin}:${created}`, tg_id: Number(tgId), kind, coin, mint: mint || null,
    decimals, expect_base: expectBase, display, price_usd: priceUsd, address, status: "pending",
    created_at: created, expires_at: created + windowMin * 60000, dead_at: created + graceH * 3600000,
    matched_sig: null, paid_at: null,
  };
  await col("crypto_invoices").insertOne(doc);
  return doc;
}
export async function listPendingInvoices(coin) {
  return col("crypto_invoices").find({ coin, status: "pending", dead_at: { $gte: now() } }).toArray();
}
// atomic: chỉ 1 lần pending->paid (chống double-credit; modifiedCount version-independent).
export async function claimInvoice(id, sig) {
  const r = await col("crypto_invoices").updateOne({ _id: id, status: "pending" }, { $set: { status: "paid", matched_sig: sig, paid_at: now() } });
  return r.modifiedCount === 1;
}
export async function expireStaleInvoices() {
  await col("crypto_invoices").updateMany({ status: "pending", dead_at: { $lt: now() } }, { $set: { status: "expired" } });
}
// sig đã dò (tối ưu, tránh re-parse getTransaction). Đúng đắn double-credit do claimInvoice lo.
export async function sigSeen(sig) { return !!(await col("crypto_seen").findOne({ _id: sig })); }
export async function markSigSeen(sig) { try { await col("crypto_seen").insertOne({ _id: sig, at: now() }); } catch {} }

// ---------- global settings (nhúng trong user.settings) ----------
export async function getGlobalSettings(tgId) {
  const u = await getUser(tgId);
  return settingsOf(u?.settings);
}
export async function setGlobalSetting(tgId, colName, val) {
  if (!byCol[colName]) throw new Error("bad setting col " + colName);
  await col("users").updateOne({ _id: Number(tgId) }, { $set: { [`settings.${colName}`]: val ? 1 : 0 } });
}

// ---------- watches ----------
export async function listWatches(tgId) { return col("watches").find({ tg_id: Number(tgId), ...X_ONLY }).sort({ created_at: 1 }).toArray(); }
export async function getWatch(tgId, handle) { return col("watches").findOne({ _id: wid(tgId, handle) }); }
// đếm watch X ĐANG hoạt động (loại paused) -> free-user hạ gói vẫn quản được freeLimit slot.
export async function countWatches(tgId) { return col("watches").countDocuments({ tg_id: Number(tgId), ...X_ONLY, paused: { $ne: true } }); }

// Thêm watch. settings=null => KẾ THỪA global; chỉ tạo override khi user chỉnh riêng
// account (setWatchSetting). Nhờ vậy bật/tắt ở Global Settings áp cho mọi account chưa customize.
export async function addWatch(tgId, handle, xUserId = null) {
  tgId = Number(tgId);
  const h = handle.toLowerCase().replace(/^@/, "");
  await col("watches").updateOne(
    { _id: wid(tgId, h) },
    { $setOnInsert: { tg_id: tgId, handle: h, platform: "x", x_user_id: xUserId, settings: null, created_at: now() } },
    { upsert: true });
  return getWatch(tgId, h);
}
export async function removeWatch(tgId, handle) {
  const r = await col("watches").deleteOne({ _id: wid(tgId, handle) });
  return r.deletedCount > 0;
}
export async function setWatchSetting(tgId, handle, colName, val) {
  if (!byCol[colName]) throw new Error("bad setting col " + colName);
  const w = await getWatch(tgId, handle);
  if (!w) return false;
  const base = w.settings || (await getGlobalSettings(tgId));
  const s = { ...base, [colName]: val ? 1 : 0 };
  await col("watches").updateOne({ _id: wid(tgId, handle) }, { $set: { settings: s } });
  return true;
}

export async function effectiveSettings(tgId, handle) {
  const w = await getWatch(tgId, handle);
  if (w && w.settings) return settingsOf(w.settings);
  return getGlobalSettings(tgId);
}

// Dispatcher: mọi user watch handle + settings hiệu lực (batch fetch settings user thiếu override).
export async function watchersOfHandle(handle, platform = "x") {
  const base = platform === "x" ? { handle: handle.toLowerCase(), ...X_ONLY } : { handle: handle.toLowerCase(), platform };
  const q = { ...base, paused: { $ne: true } };   // watch bị PAUSE (gói hết hạn) không nhận thông báo
  const rows = await col("watches").find(q).project({ tg_id: 1, settings: 1 }).toArray();
  const needUser = rows.filter((r) => !r.settings).map((r) => r.tg_id);
  let userSettings = {};
  if (needUser.length) {
    const us = await col("users").find({ _id: { $in: needUser } }).project({ settings: 1 }).toArray();
    userSettings = Object.fromEntries(us.map((u) => [u._id, settingsOf(u.settings)]));
  }
  return rows.map((r) => ({ tgId: r.tg_id, settings: r.settings ? settingsOf(r.settings) : (userSettings[r.tg_id] || { ...DEFAULTS }) }));
}

export async function distinctHandles() { return col("watches").distinct("handle", X_ONLY); }
export async function refCount(handle) { return col("watches").countDocuments({ handle: handle.toLowerCase(), ...X_ONLY }); }

// ---------- platform watches (Truth/IG — nguồn j7, list global admin-curated) ----------
// User bật master settings.truth/ig + chọn account cụ thể (platform watch). Dispatcher giao post
// platform theo handle CHO user có watch platform đó + đã bật. Tách _id nên KHÔNG lẫn flow X.
export async function addPlatformWatch(tgId, handle, platform) {
  tgId = Number(tgId);
  const h = handle.toLowerCase().replace(/^@/, "");
  await col("watches").updateOne(
    { _id: wid(tgId, h, platform) },
    { $setOnInsert: { tg_id: tgId, handle: h, platform, x_user_id: null, settings: null, created_at: now() } },
    { upsert: true });
}
export async function removePlatformWatch(tgId, handle, platform) {
  const r = await col("watches").deleteOne({ _id: wid(tgId, handle, platform) });
  return r.deletedCount > 0;
}
export async function platformWatchSet(tgId, platform) {
  const rows = await col("watches").find({ tg_id: Number(tgId), platform }).project({ handle: 1 }).toArray();
  return new Set(rows.map((r) => r.handle));
}
export async function xidForHandle(handle) {
  const r = await col("watches").findOne({ handle: handle.toLowerCase(), x_user_id: { $ne: null } }, { projection: { x_user_id: 1 } });
  return r?.x_user_id || null;
}

// ---------- referrals ----------
export async function addReferral(referrer, referred) {
  await col("referrals").updateOne(
    { _id: `${referrer}:${referred}` },
    { $setOnInsert: { referrer: Number(referrer), referred: Number(referred), subscribed: 0, created_at: now() } },
    { upsert: true });
}
export async function markReferralSubscribed(tgId) {
  await col("referrals").updateMany({ referred: Number(tgId) }, { $set: { subscribed: 1 } });
}

// ---------- ref points (ledger idempotent) ----------
// Ghi 1 dòng sổ cái rồi CHỈ $inc users.points khi dòng THỰC SỰ mới tạo (upsertedCount===1).
// _id unique -> replay / gọi đồng thời không bao giờ cộng 2 lần. Trả điểm đã cộng (0 nếu đã ghi trước đó).
async function award(referrer, referred, kind, points, extra = {}) {
  referrer = Number(referrer); referred = Number(referred); points = Math.round(points);
  if (!referrer || points <= 0) return 0;
  const _id = kind === "join" ? `j:${referred}` : `c:${extra.charge_id}`;
  const r = await col("ref_ledger").updateOne(
    { _id },
    { $setOnInsert: { referrer, referred, kind, points, ...extra, at: now() } },
    { upsert: true });
  if (r.upsertedCount !== 1) return 0;                                   // đã ghi trước đó -> bỏ qua
  await col("users").updateOne({ _id: referrer }, { $inc: { points } });
  return points;
}

// JOIN: gọi ở /start khi có ?start=<referrer>. Chỉ thưởng đúng nguồn first-touch (referred_by===referrer),
// idempotent (j:<referred>) -> /start lại không cộng thêm. Trả điểm đã cộng để bot notify referrer.
export async function recordReferralOnStart(referrer, referred) {
  referrer = Number(referrer); referred = Number(referred);
  if (!referrer || referrer === referred) return 0;
  const u = await getUser(referred);
  if (!u || u.referred_by !== referrer) return 0;
  await addReferral(referrer, referred);
  return award(referrer, referred, "join", cfg.refJoinPoints);
}

// CONVERT: gọi khi referred phát sinh payment. Điểm TỈ LỆ theo số tiền, theo đơn vị:
//   currency "XTR" (Telegram Stars) -> amount = số Stars, rate = refPointsPerStar
//   crypto USDT/SOL/ERC20 -> amount = giá trị USD, rate = refPointsPerUsd
// chargeId = telegram_payment_charge_id (Stars) HOẶC tx hash (crypto) -> idempotent (c:<chargeId>).
// Trả {referrer, points} nếu vừa cộng, null nếu không có referrer / đã ghi / điểm 0.
export async function awardRefConvert(referred, { amount, currency, chargeId } = {}) {
  const u = await getUser(referred);
  const referrer = u?.referred_by;
  if (!referrer || !chargeId || !(amount > 0)) return null;
  const rate = String(currency).toUpperCase() === "XTR" ? cfg.refPointsPerStar : cfg.refPointsPerUsd;
  const points = await award(referrer, referred, "convert", amount * rate, { charge_id: chargeId, amount, currency: currency || "USD" });
  return points > 0 ? { referrer, points } : null;
}
export async function referralStats(tgId) {
  tgId = Number(tgId);
  const direct = await col("referrals").countDocuments({ referrer: tgId });
  const subscribed = await col("referrals").countDocuments({ referrer: tgId, subscribed: 1 });
  const mine = (await col("referrals").find({ referrer: tgId }).project({ referred: 1 }).toArray()).map((r) => r.referred);
  const indirect = mine.length ? await col("referrals").countDocuments({ referrer: { $in: mine } }) : 0;
  const points = (await getUser(tgId))?.points ?? 0;
  return { direct, indirect, subscribed, points };
}

// ---------- bloom pool ----------
const mapAcc = (d) => (d ? { id: d._id, label: d.label, session_token: d.session_token, capacity: d.capacity, status: d.status, expires_at: d.expires_at } : null);
export async function listBloomAccounts(onlyActive = true) {
  const q = onlyActive ? { status: "active" } : {};
  return (await col("bloom_accounts").find(q).sort({ _id: 1 }).toArray()).map(mapAcc);
}
export async function getBloomAccount(id) { return mapAcc(await col("bloom_accounts").findOne({ _id: Number(id) })); }
export async function upsertBloomAccount({ id, label, session_token, capacity, status = "active", expires_at = null }) {
  if (id == null) {
    const last = await col("bloom_accounts").find({}).sort({ _id: -1 }).limit(1).toArray();
    id = (last[0]?._id || 0) + 1;
  }
  await col("bloom_accounts").updateOne({ _id: Number(id) }, { $set: { label, session_token, capacity, status, expires_at } }, { upsert: true });
  return getBloomAccount(id);
}
export async function setBloomStatus(id, status) { await col("bloom_accounts").updateOne({ _id: Number(id) }, { $set: { status } }); }
export async function setBloomCapacity(id, capacity) { await col("bloom_accounts").updateOne({ _id: Number(id) }, { $set: { capacity } }); }
export async function shardLoad(id) { return col("tracked_handles").countDocuments({ bloom_account_id: Number(id) }); }

// ---------- tracked_handles ----------
const mapTr = (d) => (d ? { handle: d._id, x_user_id: d.x_user_id, bloom_account_id: d.bloom_account_id, ref_count: d.ref_count, last_event_at: d.last_event_at } : null);
export async function getTracked(handle) { return mapTr(await col("tracked_handles").findOne({ _id: handle.toLowerCase() })); }
export async function getTrackedByXid(xid) { return mapTr(await col("tracked_handles").findOne({ x_user_id: String(xid) })); }
export async function allTracked() { return (await col("tracked_handles").find({}).toArray()).map(mapTr); }
export async function upsertTracked(handle, xUserId, bloomAccountId, ref) {
  const h = handle.toLowerCase();
  await col("tracked_handles").updateOne(
    { _id: h },
    { $set: { x_user_id: xUserId ? String(xUserId) : null, bloom_account_id: bloomAccountId ?? null, ref_count: ref } },
    { upsert: true });
  return getTracked(h);
}
export async function setTrackedRef(handle, ref) { await col("tracked_handles").updateOne({ _id: handle.toLowerCase() }, { $set: { ref_count: ref } }); }
export async function deleteTracked(handle) { await col("tracked_handles").deleteOne({ _id: handle.toLowerCase() }); }
export async function touchTracked(handle) { await col("tracked_handles").updateOne({ _id: handle.toLowerCase() }, { $set: { last_event_at: now() } }); }

// ---------- profile snapshots (profile-poller tự dò đổi avatar/name/verified) ----------
export async function getProfileSnaps(handles) {
  const ids = handles.map((h) => h.toLowerCase());
  const rows = await col("profile_snap").find({ _id: { $in: ids } }).toArray();
  return new Map(rows.map((r) => [r._id, r]));
}
export async function setProfileSnap(handle, snap) {
  await col("profile_snap").updateOne({ _id: handle.toLowerCase() }, { $set: { ...snap, updated_at: now() } }, { upsert: true });
}

// ---------- j7 list (nguồn 2: handle j7 CÓ THỂ cover free = main-feed ∪ available pool) ----------
// 1 doc __j7list__ do tracker-sync-j7 ghi định kỳ. Dùng cho gate isJ7Covered (M4 source-preference:
// profile lấy từ j7 nếu account được j7 cover; ngoài list -> Bloom lo). Process nào đọc/ghi cũng được.
export async function saveJ7List({ main = [], pool = [] } = {}) {
  await col("j7_list").updateOne({ _id: "__j7list__" }, { $set: { main, pool, updated_at: now() } }, { upsert: true });
}
export async function getJ7List() { return col("j7_list").findOne({ _id: "__j7list__" }); }
// Ledger handle MÌNH đã add vào pool j7 — persist để tracker-sync-j7 dọn được sau restart
// (server j7 không trả lại custom.accounts nên RAM là nguồn duy nhất -> phải lưu DB).
export async function getJ7Added() { return (await col("j7_list").findOne({ _id: "__added__" }))?.handles || []; }
export async function saveJ7Added(handles) {
  await col("j7_list").updateOne({ _id: "__added__" }, { $set: { handles, updated_at: now() } }, { upsert: true });
}
// List global Truth/IG (do tracker-sync-j7 capture free từ response) — cho FE hiện picker.
export async function saveJ7Platforms({ truth = [], ig = [] } = {}) {
  await col("j7_list").updateOne({ _id: "__platlist__" }, { $set: { truth, ig, updated_at: now() } }, { upsert: true });
}
export async function getJ7Platforms() { return col("j7_list").findOne({ _id: "__platlist__" }); }

// ---------- user_stats (rollup: mỗi bot-user add bao nhiêu account X — phần "ngoài default") ----------
// 1 doc / user + 1 doc "__totals__". Refresh định kỳ ở BE (engine) và có scripts/stats.mjs xem tay.
// "ngoài default" = chính các handle user tự add (watches); default của Bloom không nằm ở đây.
export async function refreshUserStats() {
  const watches = await col("watches").find({}).project({ tg_id: 1, handle: 1 }).toArray();
  const byUser = new Map();          // tg_id -> [handle]
  const distinct = new Set();        // tổng account custom (ngoài default)
  for (const w of watches) {
    distinct.add(w.handle);
    if (!byUser.has(w.tg_id)) byUser.set(w.tg_id, []);
    byUser.get(w.tg_id).push(w.handle);
  }
  // Gồm cả user ĐÃ NÂNG TIER (Pro/Whitelist) dù chưa add account nào — để admin thấy tier change.
  const elevated = await col("users").find({ tier: { $nin: [null, "Free"] } }).project({ _id: 1 }).toArray();
  for (const e of elevated) if (!byUser.has(e._id)) byUser.set(e._id, []);
  const ids = [...byUser.keys()];
  const users = ids.length ? await col("users").find({ _id: { $in: ids } }).toArray() : [];
  const uMap = new Map(users.map((u) => [u._id, u]));
  const shards = await listBloomAccounts(false);
  const capacity = shards.reduce((s, a) => s + (a.capacity || 0), 0);
  const ts = new Date();

  const ops = [];
  for (const [tgId, handles] of byUser) {
    const u = uMap.get(tgId) || {};
    ops.push({ updateOne: { filter: { _id: tgId }, update: { $set: {
      username: u.username || null, tier: u.tier || "Free", account_limit: u.account_limit ?? null,
      added: handles.length, handles: handles.sort(), updated_at: ts,
    } }, upsert: true } });
  }
  ops.push({ updateOne: { filter: { _id: "__totals__" }, update: { $set: {
    users: byUser.size, custom_accounts: distinct.size, capacity, updated_at: ts,
  } }, upsert: true } });
  await col("user_stats").bulkWrite(ops);
  await col("user_stats").deleteMany({ _id: { $nin: [...ids, "__totals__"] } });   // dọn user đã remove hết
  return { users: byUser.size, custom_accounts: distinct.size, capacity };
}

// ---------- tweet cache (TTL index tự prune) ----------
export async function cacheTweet({ tweet_id, author_handle, text, media, is_retweet, rt_source }) {
  if (!tweet_id) return;
  await col("tweet_cache").updateOne(
    { _id: String(tweet_id) },
    { $setOnInsert: { author_handle: author_handle || null, text: text || "", media: media || {}, is_retweet: is_retweet ? 1 : 0, rt_source: rt_source || null, seen_at: new Date() } },
    { upsert: true });
}
export async function getCachedTweet(tweetId) {
  const r = await col("tweet_cache").findOne({ _id: String(tweetId) });
  if (!r) return null;
  return { tweet_id: r._id, author_handle: r.author_handle, text: r.text, media: r.media || {}, is_retweet: r.is_retweet, rt_source: r.rt_source };
}

// ---------- deliveries (dedup per user; TTL index tự prune) ----------
// source (bloom|j7): trọng tài race + metric "nguồn nào tới trước thắng". Insert unique _id -> nguồn
// thứ 2 (cùng dedupKey) dính 11000 => false => không gửi trùng. Đo win-rate: nhóm deliveries theo source.
export async function markDelivered(dedupKey, tgId, source = null) {
  try {
    const doc = { _id: `${dedupKey}:${tgId}`, dedup_key: dedupKey, tg_id: Number(tgId), sent_at: new Date() };
    if (source) doc.source = source;
    await col("deliveries").insertOne(doc);
    return true;
  } catch (e) {
    if (e.code === 11000) return false;   // đã gửi cho user này (hoặc nguồn kia thắng)
    throw e;
  }
}

// ---------- monitor firehose (TEST/QC: race-outcome giữa 2 nguồn) ----------
// Trả { firstShow, won, firstSource }: firstShow=lần đầu NGUỒN NÀY hiện key (chống re-emit noise);
// won=nguồn này chạm key TRƯỚC (race winner). TTL tự prune (monitor_seen.at).
export async function monitorMark(dedupKey, source) {
  const src = source || "?";
  // per-source: nguồn này đã hiện key này chưa? (Bloom re-emit cùng tweet -> chỉ in 1 lần)
  let firstShow = true;
  try { await col("monitor_seen").insertOne({ _id: `mon:${dedupKey}:${src}`, source: src, at: new Date() }); }
  catch (e) { if (e.code === 11000) firstShow = false; else throw e; }
  // overall: nguồn nào chạm key TRƯỚC = race winner
  let won = true, firstSource = src;
  try { await col("monitor_seen").insertOne({ _id: `mon:${dedupKey}`, source: src, at: new Date() }); }
  catch (e) {
    if (e.code === 11000) { won = false; const d = await col("monitor_seen").findOne({ _id: `mon:${dedupKey}` }); firstSource = d?.source || "?"; }
    else throw e;
  }
  return { firstShow, won, firstSource };
}

// ---------- tiện ích migrate ----------
export async function collectionsInfo() {
  const names = ["users", "watches", "referrals", "bloom_accounts", "tracked_handles", "tweet_cache", "deliveries"];
  const out = {};
  for (const n of names) out[n] = await col(n).countDocuments();
  return out;
}
