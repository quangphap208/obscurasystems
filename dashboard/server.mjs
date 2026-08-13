// server.mjs — admin dashboard (mô hình docs/DASHBOARD.md: bot ghi event, dashboard CHỈ aggregate đọc
// + quản PRO). node:http thuần, không dependency. Chạy: npm run dash / pm2 kol-dash.
//
// Bảo mật (docs/DASHBOARD.md §7, làm ngay từ đầu thay vì nợ như bản gốc):
//   - DASH_PASSWORD từ env (trống = từ chối chạy) · session cookie HttpOnly 24h (in-memory)
//   - rate-limit login 5 lần / 5 phút / IP · CSRF token cho POST mutation
//   - bind 127.0.0.1 mặc định — expose qua SSH tunnel hoặc nginx+TLS+allowlist
//   - mutation ghi audit `admin_actions`
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cfg } from "../shared/config.mjs";
import { connect, col, now } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
if (!cfg.dashPassword) { console.error("Thiếu DASH_PASSWORD trong .env — dashboard không chạy."); process.exit(1); }
await connect();

const DAY = 86400000;
const SESS = new Map();       // token -> { exp, csrf }
const ATTEMPTS = new Map();   // ip -> { n, resetAt }  (rate-limit login)

// ---------- helpers ----------
const json = (res, code, data) => { const b = JSON.stringify(data); res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(b) }); res.end(b); };
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length === 2));
const readBody = (req) => new Promise((ok, no) => { let b = ""; req.on("data", (c) => { b += c; if (b.length > 65536) { no(new Error("body too large")); req.destroy(); } }); req.on("end", () => ok(b)); req.on("error", no); });
const dayStartUTC = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);

function session(req) {
  const t = cookies(req).dash;
  const s = t && SESS.get(t);
  if (!s) return null;
  if (s.exp < Date.now()) { SESS.delete(t); return null; }
  return s;
}

// ---------- API (đều cần session, trừ login) ----------
const api = {
  async overview() {
    const day0 = dayStartUTC();
    const [total, byTier, activeToday, newToday, watches, handles, evToday, del, pay] = await Promise.all([
      col("users").countDocuments(),
      col("users").aggregate([{ $group: { _id: "$tier", n: { $sum: 1 } } }]).toArray(),
      col("users").countDocuments({ last_active_at: { $gte: day0 } }),
      col("users").countDocuments({ created_at: { $gte: day0 } }),
      col("watches").countDocuments({ paused: { $ne: true } }),
      col("watches").distinct("handle"),
      col("user_actions").countDocuments({ at: { $gte: new Date(day0) } }),
      col("delivery_stats").findOne({ _id: dstr(Date.now()) }),
      col("payments").aggregate([{ $group: { _id: "$method", n: { $sum: 1 }, usd: { $sum: "$usd" }, stars: { $sum: { $cond: [{ $eq: ["$method", "stars"] }, "$amount", 0] } } } }]).toArray(),
    ]);
    const paidActive = await col("users").countDocuments({ tier: { $in: ["Pro", "Whale"] }, expires_at: { $gt: now() } });
    return {
      total, byTier: Object.fromEntries(byTier.map((t) => [t._id || "?", t.n])), paidActive,
      activeToday, newToday, watches, handles: handles.length, eventsToday: evToday,
      notisToday: del?.n || 0,
      revenue: { usd: pay.reduce((a, p) => a + (p.usd || 0), 0), stars: pay.reduce((a, p) => a + (p.stars || 0), 0), count: pay.reduce((a, p) => a + p.n, 0) },
    };
  },
  async activity(q) {
    const days = Math.min(Number(q.get("days")) || 14, 90);
    const from = new Date(dayStartUTC() - (days - 1) * DAY);
    const rows = await col("user_actions").aggregate([
      { $match: { at: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$at" } }, n: { $sum: 1 }, users: { $addToSet: "$tg_id" } } },
      { $project: { n: 1, uniq: { $size: "$users" } } }, { $sort: { _id: 1 } },
    ]).toArray();
    return { days, rows };
  },
  async deliveries(q) {
    const days = Math.min(Number(q.get("days")) || 14, 90);
    const from = dstr(dayStartUTC() - (days - 1) * DAY);
    const rows = await col("delivery_stats").find({ _id: { $gte: from } }).sort({ _id: 1 }).toArray();
    return { days, rows };
  },
  async hourly() {
    const from = new Date(Date.now() - DAY);
    const rows = await col("user_actions").aggregate([
      { $match: { at: { $gte: from } } },
      { $group: { _id: { $hour: "$at" }, n: { $sum: 1 } } }, { $sort: { _id: 1 } },
    ]).toArray();
    return { rows };
  },
  async actions(q) {
    const days = Math.min(Number(q.get("days")) || 7, 90);
    const rows = await col("user_actions").aggregate([
      { $match: { at: { $gte: new Date(Date.now() - days * DAY) } } },
      { $group: { _id: "$action", n: { $sum: 1 }, users: { $addToSet: "$tg_id" } } },
      { $project: { n: 1, uniq: { $size: "$users" } } }, { $sort: { n: -1 } },
    ]).toArray();
    return { days, rows };
  },
  async recent() {
    return { rows: await col("user_actions").find().sort({ at: -1 }).limit(50).toArray() };
  },
  async topHandles() {
    return { rows: await col("watches").aggregate([
      { $match: { paused: { $ne: true } } },
      // watch cũ platform=null, mới ="x" -> $ifNull gộp chung, không ra 2 dòng trùng handle
      { $group: { _id: { h: "$handle", p: { $ifNull: ["$platform", "x"] } }, n: { $sum: 1 } } },
      { $project: { _id: 0, handle: "$_id.h", platform: "$_id.p", n: 1 } },
      { $sort: { n: -1 } }, { $limit: 20 },
    ]).toArray() };
  },
  async sources() {
    const [bySource, referred, refRows, topRef] = await Promise.all([
      col("users").aggregate([{ $group: { _id: "$ref_source", n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
      col("users").countDocuments({ referred_by: { $ne: null } }),
      col("referrals").countDocuments(),
      col("users").find({ points: { $gt: 0 } }).project({ username: 1, points: 1 }).sort({ points: -1 }).limit(10).toArray(),
    ]);
    return { bySource, referred, refRows, topRef };
  },
  async payments() {
    const [rows, totals] = await Promise.all([
      col("payments").find().sort({ at: -1 }).limit(30).toArray(),
      col("payments").aggregate([{ $group: { _id: { m: "$method", k: "$kind" }, n: { $sum: 1 }, usd: { $sum: "$usd" }, stars: { $sum: { $cond: [{ $eq: ["$method", "stars"] }, "$amount", 0] } } } }]).toArray(),
    ]);
    return { rows, totals };
  },
  async proUsers() {
    const users = await col("users").find({ $or: [{ tier: { $ne: "Free" } }, { expires_at: { $ne: null } }] })
      .project({ username: 1, tier: 1, account_limit: 1, expires_at: 1, last_active_at: 1, created_at: 1 }).sort({ tier: 1, expires_at: 1 }).toArray();
    const wc = await col("watches").aggregate([{ $match: { tg_id: { $in: users.map((u) => u._id) } } }, { $group: { _id: "$tg_id", n: { $sum: 1 } } }]).toArray();
    const wmap = Object.fromEntries(wc.map((w) => [w._id, w.n]));
    return { rows: users.map((u) => ({ ...u, watches: wmap[u._id] || 0, days_left: u.expires_at ? Math.ceil((u.expires_at - now()) / DAY) : null, expired: !!u.expires_at && u.expires_at < now() })) };
  },
};

// Mutation quản PRO — mirror lệnh bot /grant /whitelist /unwhitelist + audit admin_actions.
async function proAction(body) {
  const { action, tg_id, days, limit } = body;
  const tg = Number(tg_id);
  if (!tg) return { error: "tg_id không hợp lệ" };
  await repo.ensureUser(tg);
  let result;
  if (action === "grant") {
    const d = Number(days) || cfg.proDays;
    await repo.setUserPlan(tg, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: now() + d * DAY });
    result = `Pro ${d} ngày (limit ${cfg.proLimit})`;
  } else if (action === "whitelist") {
    const lim = Number(limit);
    if (!Number.isFinite(lim) || lim <= 0) return { error: "limit phải > 0 (hạ Free thì dùng action free)" };
    await repo.setUserPlan(tg, { tier: "Whitelist", accountLimit: lim, expiresAt: days ? now() + Number(days) * DAY : null });
    result = `Whitelist limit ${lim}${days ? ` · ${days} ngày` : " · không hạn"}`;
  } else if (action === "free") {
    await repo.setUserPlan(tg, { tier: "Free", accountLimit: cfg.freeLimit, expiresAt: null });
    result = `Về Free (limit ${cfg.freeLimit})`;
  } else return { error: "action không hợp lệ" };
  await col("admin_actions").insertOne({ via: "dash", action, target: tg, days: Number(days) || null, limit: Number(limit) || null, at: now() });
  return { ok: true, result };
}

// ---------- HTTP ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = req.socket.remoteAddress || "?";
  try {
    // login (không cần session) — rate-limit theo IP
    if (req.method === "POST" && url.pathname === "/api/login") {
      const a = ATTEMPTS.get(ip) || { n: 0, resetAt: Date.now() + 300000 };
      if (Date.now() > a.resetAt) { a.n = 0; a.resetAt = Date.now() + 300000; }
      if (a.n >= 5) return json(res, 429, { error: "Quá 5 lần — thử lại sau 5 phút" });
      const body = JSON.parse(await readBody(req) || "{}");
      if (body.password !== cfg.dashPassword) { a.n++; ATTEMPTS.set(ip, a); return json(res, 401, { error: "Sai mật khẩu" }); }
      ATTEMPTS.delete(ip);
      const token = randomBytes(24).toString("hex"), csrf = randomBytes(16).toString("hex");
      SESS.set(token, { exp: Date.now() + DAY, csrf });
      res.setHeader("set-cookie", `dash=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return json(res, 200, { ok: true, csrf });
    }
    // trang chính — HTML tự fetch /api/session để biết đã login chưa
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const page = readFileSync(join(__dir, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    const sess = session(req);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return sess ? json(res, 200, { ok: true, csrf: sess.csrf }) : json(res, 401, { error: "unauth" });
      if (!sess) return json(res, 401, { error: "unauth" });
      if (req.method === "POST" && url.pathname === "/api/logout") { SESS.delete(cookies(req).dash); res.setHeader("set-cookie", "dash=; Path=/; Max-Age=0"); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && url.pathname === "/api/pro-action") {
        if (req.headers["x-csrf"] !== sess.csrf) return json(res, 403, { error: "CSRF" });   // cookie-only request (cross-site) không có token
        return json(res, 200, await proAction(JSON.parse(await readBody(req) || "{}")));
      }
      const name = { "/api/overview": "overview", "/api/activity": "activity", "/api/deliveries": "deliveries", "/api/hourly": "hourly", "/api/actions": "actions", "/api/recent": "recent", "/api/top-handles": "topHandles", "/api/sources": "sources", "/api/payments": "payments", "/api/pro-users": "proUsers" }[url.pathname];
      if (name && req.method === "GET") return json(res, 200, await api[name](url.searchParams));
      return json(res, 404, { error: "not found" });
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    console.warn("[dash]", req.method, url.pathname, e.message);
    json(res, 500, { error: "server error" });
  }
});

server.listen(cfg.dashPort, cfg.dashBind, () =>
  console.log(`Dashboard http://${cfg.dashBind}:${cfg.dashPort} (bind ${cfg.dashBind} — expose qua SSH tunnel/nginx TLS)`));
