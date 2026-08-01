// repo.mjs — data access layer (MongoDB Atlas) dùng chung FE (bot) và BE (engine).
// Mọi hàm async. Gọi await connect() (shared/mongo.mjs) một lần lúc khởi động trước khi dùng.
//
// Model:
//   users{_id=tg_id, tg_id, username, tier, account_limit, expires_at, referred_by, points, created_at, settings{20 khoá}}
//   watches{_id=`tg:handle`, tg_id, handle, x_user_id, settings{}|null, created_at}
//   referrals{_id=`a:b`, referrer, referred, subscribed, created_at}
//   bloom_accounts{_id=id, label, session_token, capacity, status, expires_at}
//   tracked_handles{_id=handle, x_user_id, bloom_account_id, ref_count, last_event_at}
//   tweet_cache{_id=tweet_id, author_handle, text, media, is_retweet, rt_source, seen_at:Date}
//   deliveries{_id=`key:tg`, dedup_key, tg_id, sent_at:Date}
import { col, now } from "./mongo.mjs";
import { DEFAULTS, byCol } from "./settings.mjs";
import { cfg } from "./config.mjs";

const SET_COLS = Object.keys(DEFAULTS);
const wid = (tgId, handle) => `${tgId}:${handle.toLowerCase()}`;
const settingsOf = (obj) => Object.fromEntries(SET_COLS.map((c) => [c, obj?.[c] ?? DEFAULTS[c]]));

// ---------- users ----------
export async function getUser(tgId) { return col("users").findOne({ _id: Number(tgId) }); }

export async function ensureUser(tgId, username, referredBy = null) {
  tgId = Number(tgId);
  const existing = await getUser(tgId);
  if (existing) {
    const set = {};
    if (username && username !== existing.username) set.username = username;
    // Free-tier: account_limit bám cfg.freeLimit hiện tại (Pro giữ limit cố định lúc nâng gói).
    if (existing.tier === "Free" && existing.account_limit !== cfg.freeLimit) set.account_limit = cfg.freeLimit;
    if (Object.keys(set).length) await col("users").updateOne({ _id: tgId }, { $set: set });
    return getUser(tgId);
  }
  const ref = referredBy && Number(referredBy) !== tgId ? Number(referredBy) : null;
  await col("users").insertOne({
    _id: tgId, tg_id: tgId, username: username || null, tier: "Free",
    account_limit: cfg.freeLimit, expires_at: null, referred_by: ref, points: 0,
    created_at: now(), settings: { ...DEFAULTS },
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
export async function listWatches(tgId) { return col("watches").find({ tg_id: Number(tgId) }).sort({ created_at: 1 }).toArray(); }
export async function getWatch(tgId, handle) { return col("watches").findOne({ _id: wid(tgId, handle) }); }
export async function countWatches(tgId) { return col("watches").countDocuments({ tg_id: Number(tgId) }); }

// Thêm watch. settings=null => KẾ THỪA global; chỉ tạo override khi user chỉnh riêng
// account (setWatchSetting). Nhờ vậy bật/tắt ở Global Settings áp cho mọi account chưa customize.
export async function addWatch(tgId, handle, xUserId = null) {
  tgId = Number(tgId);
  const h = handle.toLowerCase().replace(/^@/, "");
  await col("watches").updateOne(
    { _id: wid(tgId, h) },
    { $setOnInsert: { tg_id: tgId, handle: h, x_user_id: xUserId, settings: null, created_at: now() } },
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
export async function watchersOfHandle(handle) {
  const rows = await col("watches").find({ handle: handle.toLowerCase() }).project({ tg_id: 1, settings: 1 }).toArray();
  const needUser = rows.filter((r) => !r.settings).map((r) => r.tg_id);
  let userSettings = {};
  if (needUser.length) {
    const us = await col("users").find({ _id: { $in: needUser } }).project({ settings: 1 }).toArray();
    userSettings = Object.fromEntries(us.map((u) => [u._id, settingsOf(u.settings)]));
  }
  return rows.map((r) => ({ tgId: r.tg_id, settings: r.settings ? settingsOf(r.settings) : (userSettings[r.tg_id] || { ...DEFAULTS }) }));
}

export async function distinctHandles() { return col("watches").distinct("handle"); }
export async function refCount(handle) { return col("watches").countDocuments({ handle: handle.toLowerCase() }); }
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
export async function markDelivered(dedupKey, tgId) {
  try {
    await col("deliveries").insertOne({ _id: `${dedupKey}:${tgId}`, dedup_key: dedupKey, tg_id: Number(tgId), sent_at: new Date() });
    return true;
  } catch (e) {
    if (e.code === 11000) return false;   // đã gửi cho user này
    throw e;
  }
}

// ---------- tiện ích migrate ----------
export async function collectionsInfo() {
  const names = ["users", "watches", "referrals", "bloom_accounts", "tracked_handles", "tweet_cache", "deliveries"];
  const out = {};
  for (const n of names) out[n] = await col(n).countDocuments();
  return out;
}
