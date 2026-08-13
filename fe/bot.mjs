// bot.mjs — entry FE. Telegram bot (grammy) clone @redactedsystemsbot.
// Delivery = DM: thông báo do BE gửi thẳng vào chat user (tg_id). FE lo UI + quản lý watch/settings/gói.
import { Bot, GrammyError } from "grammy";
import { cfg, assertFE, isAdmin } from "../shared/config.mjs";
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { track, touch } from "../shared/track.mjs";
import { paymentHook } from "../shared/slack.mjs";
import { byKey, GATE_TEXT } from "../shared/settings.mjs";
import { resolveHandle, resolveHandles, parseHandle } from "./xsearch.mjs";
import { startPoller as startCryptoPoller, makeInvoice, verifyManual, cryptoEnabled } from "./crypto-pay.mjs";
import {
  welcomeScreen, referralScreen, globalSettingsScreen, accountSettingsScreen,
  accountsScreen, subscribeScreen, platformScreen, platformDisplayList, esc,
  paymentMethodScreen, cryptoCoinScreen, cryptoInvoiceScreen,
} from "./screens.mjs";

const PLATFORMS = new Set(["truth", "ig"]);
// Màn picker Truth/IG: master enable + list global (BE capture) + đánh dấu account user đang follow.
async function showPlatform(ctx, platform, edit = false) {
  if (!PLATFORMS.has(platform)) return;
  const uid = ctx.from.id;
  const enabled = !!(await repo.getGlobalSettings(uid))[platform];
  const pl = await repo.getJ7Platforms();
  const globalList = (platform === "truth" ? pl?.truth : pl?.ig) || [];
  const followed = await repo.platformWatchSet(uid, platform);
  await show(ctx, platformScreen(platform, enabled, globalList, followed), edit);
}

assertFE();
await connect();

const bot = new Bot(cfg.botToken);
let BOT_USER = null;

// Analytics (shared/track.mjs): bump last_active_at cho MỌI tương tác; event có nghĩa thì handler tự track().
bot.use((ctx, next) => { if (ctx.from) touch(ctx.from.id); return next(); });

const NOPREVIEW = { link_preview_options: { is_disabled: true } };
const HTML = (extra = {}) => ({ parse_mode: "HTML", ...NOPREVIEW, ...extra });

// /subscribe đang tắt trong giai đoạn test (cfg.subsEnabled=false). Thông báo chung.
const SUBS_OFF_MSG = "🚧 <b>Subscriptions aren't open yet.</b>\nYou're in the early test group — enjoy the bot! Paid plans are coming soon.";

// Gửi màn mới (reply) hoặc sửa tại chỗ (edit) tuỳ context.
async function show(ctx, { text, keyboard }, edit = false) {
  const opts = HTML({ reply_markup: keyboard });
  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text, opts);
    else await ctx.reply(text, opts);
  } catch (e) {
    if (e instanceof GrammyError && /message is not modified/.test(e.description)) return;
    if (edit) { try { await ctx.reply(text, opts); } catch {} } else throw e;
  }
}

// Báo referrer khi họ được cộng điểm ref (join / convert). try/catch: referrer có thể đã block bot.
async function notifyReferrer(referrer, pts, kind) {
  const what = kind === "join" ? "joined via your link" : "upgraded to Pro";
  try { await bot.api.sendMessage(referrer, `🎉 A friend ${what}! <b>+${pts}</b> referral points.\nTap 👥 Referrals to see your total.`, HTML()); } catch {}
}

async function welcome(ctx, edit = false) {
  const u = await repo.getUser(ctx.from.id);
  const n = await repo.countWatches(ctx.from.id);
  await show(ctx, welcomeScreen(u, n, BOT_USER), edit);
}

// ---------- /start (+ deep-link) ----------
bot.command("start", async (ctx) => {
  const p = (ctx.match || "").trim();
  let referredBy = null, qa = null, source = null;
  const ms = p.match(/s[_-](\w{1,32})/i);          // nguồn/campaign: ?start=s_botX / s_ad_july (label có thể có _)
  if (ms) source = ms[1].toLowerCase();
  const mr = p.match(/^(\d{4,})/);                 // referral: tg_id ở ĐẦU payload (kết hợp được: 123_s_botX)
  if (mr) referredBy = Number(mr[1]);
  else if (/^qa[\s_+]?/i.test(p)) qa = p.replace(/^qa[\s_+]?/i, "").replace(/^@/, "");
  await repo.ensureUser(ctx.from.id, ctx.from.username || ctx.from.first_name, referredBy, source);
  if (referredBy) {
    const pts = await repo.recordReferralOnStart(referredBy, ctx.from.id);   // idempotent + chỉ nguồn first-touch
    if (pts > 0) notifyReferrer(referredBy, pts, "join");
  }
  track(ctx.from.id, "start", { ...(source && { source }), ...(referredBy && { ref: referredBy }), ...(qa && { qa }) });
  if (qa) return qaReply(ctx, qa);
  await welcome(ctx);
});

async function qaReply(ctx, handle) {
  await ctx.reply(`🔎 <b>QA: @${esc(handle)}</b>\n\nLooking it up…`, HTML());
  const r = await resolveHandle(handle);
  if (r.found) await ctx.reply(`✅ <b>@${esc(r.handle)}</b> exists on X (id ${esc(r.xid || "?")}).\nUse <b>/add ${esc(r.handle)}</b> to track it.`, HTML());
  else if (r.found === false) await ctx.reply(`❌ <b>@${esc(handle)}</b> not found on X.`, HTML());
  else await ctx.reply(`⚠️ Couldn't look it up, please try again in a few minutes.`, HTML());
}

// ---------- /add /remove ----------
bot.command("add", async (ctx) => {
  const handle = parseHandle(ctx.match);
  if (!handle) return ctx.reply("Usage: <b>/add &lt;username or link&gt;</b>\ne.g. <code>/add elonmusk</code> or <code>/add https://x.com/elonmusk</code>", HTML());
  const u = await repo.ensureUser(ctx.from.id, ctx.from.username);
  if (!repo.hasAccess(u)) { track(ctx.from.id, "add", { handle, result: "no_access" }); return ctx.reply(`⌛ Your ${u.tier === "Free" ? "free trial" : "plan"} has ended.${cfg.subsEnabled ? "\nUse <b>/subscribe</b> to keep tracking accounts." : ""}`, HTML()); }
  if (await repo.getWatch(ctx.from.id, handle)) return ctx.reply(`Already watching <b>@${esc(handle)}</b>.`, HTML());
  const n = await repo.countWatches(ctx.from.id);
  if (n >= (u.account_limit ?? 0)) { track(ctx.from.id, "add", { handle, result: "limit" }); return ctx.reply(`⚠️ You've reached the <b>${u.account_limit}</b>-account limit of your <b>${esc(u.tier)}</b> plan.${cfg.subsEnabled ? `\nUse <b>/subscribe</b> to add a <b>+${cfg.packSize} pack</b> or upgrade to <b>Whale</b>.` : ""}`, HTML()); }
  const r = await resolveHandle(handle);
  if (r.found === false) { track(ctx.from.id, "add", { handle, result: "not_found" }); return ctx.reply(`❌ <b>@${esc(handle)}</b> not found on X.`, HTML()); }
  await repo.addWatch(ctx.from.id, r.found ? r.handle : handle, r.xid || null);
  track(ctx.from.id, "add", { handle: r.found ? r.handle : handle, result: "ok" });
  await ctx.reply(`✅ Added <b>@${esc(r.found ? r.handle : handle)}</b>. Notifications will arrive shortly.\nCustomize it: 👀 X accounts.`, HTML());
});

// ---------- /bulkadd /bulkremove — dán list từ tracker khác ----------
// Token cách nhau bởi khoảng trắng / xuống dòng / phẩy; nhận @handle lẫn link x.com. Cap 100/lần.
// Validate cả batch qua 1-2 request Bloom search (không N request); tracker-sync tự nhặt watch mới (≤20s).
const BULK_CAP = 100;
const listNames = (a, cap = 20) => a.slice(0, cap).map((h) => `@${esc(h)}`).join(", ") + (a.length > cap ? ` +${a.length - cap}` : "");
function parseBulk(raw) {
  const seen = new Set(); const handles = []; let invalid = 0;
  for (const t of raw.split(/[\s,;]+/).filter(Boolean)) {
    const h = parseHandle(t);
    if (!h) { invalid++; continue; }
    if (!seen.has(h)) { seen.add(h); handles.push(h); }
  }
  return { handles, invalid };
}
bot.command("bulkadd", async (ctx) => {
  const raw = (ctx.match || "").trim();
  if (!raw) return ctx.reply(
    "📦 <b>Bulk add</b> — paste a list of usernames (from any tracker), separated by spaces, commas or new lines:\n" +
    "<code>/bulkadd elonmusk @cz_binance https://x.com/vitalikbuterin …</code>", HTML());
  const u = await repo.ensureUser(ctx.from.id, ctx.from.username);
  if (!repo.hasAccess(u)) return ctx.reply(`⌛ Your ${u.tier === "Free" ? "free trial" : "plan"} has ended.${cfg.subsEnabled ? "\nUse <b>/subscribe</b> to keep tracking accounts." : ""}`, HTML());
  const { handles, invalid } = parseBulk(raw);
  if (!handles.length) return ctx.reply("❌ No valid usernames found in that list.", HTML());
  const over = Math.max(0, handles.length - BULK_CAP);
  const list = handles.slice(0, BULK_CAP);
  if (list.length > 10) await ctx.reply(`⏳ Checking <b>${list.length}</b> accounts…`, HTML());

  const resolved = await resolveHandles(list);   // Map rỗng = Bloom search unavailable -> thêm không validate
  const added = [], already = [], notFound = [], overLimit = [];
  let n = await repo.countWatches(ctx.from.id);
  for (const h of list) {
    const r = resolved.get(h);
    if (r?.found === false) { notFound.push(h); continue; }
    const handle = r?.handle || h;
    if (await repo.getWatch(ctx.from.id, handle)) { already.push(handle); continue; }
    if (n >= (u.account_limit ?? 0)) { overLimit.push(handle); continue; }
    await repo.addWatch(ctx.from.id, handle, r?.xid || null);
    added.push(handle); n++;
  }
  track(ctx.from.id, "bulkadd", { n: list.length, ok: added.length, dup: already.length, nf: notFound.length, lim: overLimit.length, inv: invalid });

  let out = `📦 <b>Bulk add: ${added.length}/${list.length}</b>\n`;
  if (added.length) out += `\n✅ Added (${added.length}): ${listNames(added)}`;
  if (already.length) out += `\n↩️ Already watching (${already.length}): ${listNames(already)}`;
  if (notFound.length) out += `\n❌ Not found on X (${notFound.length}): ${listNames(notFound)}`;
  if (overLimit.length) out += `\n⚠️ Over your <b>${u.account_limit}</b>-account limit — skipped (${overLimit.length}): ${listNames(overLimit)}` +
    (cfg.subsEnabled ? `\nUse <b>/subscribe</b> to raise the limit.` : "");
  if (invalid) out += `\n🚮 Ignored ${invalid} invalid token(s).`;
  if (over) out += `\n✂️ List capped at ${BULK_CAP} — resend the remaining ${over}.`;
  if (added.length) out += `\n\nNotifications will start shortly. Customize: 👀 X accounts.`;
  await ctx.reply(out, HTML());
});
bot.command("bulkremove", async (ctx) => {
  const raw = (ctx.match || "").trim();
  if (!raw) return ctx.reply("🗑 <b>Bulk remove</b>:\n<code>/bulkremove user1 user2 …</code>", HTML());
  const { handles } = parseBulk(raw);
  if (!handles.length) return ctx.reply("❌ No valid usernames found.", HTML());
  const removed = [], missing = [];
  for (const h of handles.slice(0, BULK_CAP)) (await repo.removeWatch(ctx.from.id, h)) ? removed.push(h) : missing.push(h);
  track(ctx.from.id, "bulkremove", { n: handles.length, ok: removed.length });
  let out = `🗑 <b>Bulk remove: ${removed.length}/${Math.min(handles.length, BULK_CAP)}</b>`;
  if (removed.length) out += `\n✅ Unfollowed (${removed.length}): ${listNames(removed)}`;
  if (missing.length) out += `\n❔ Not in your list (${missing.length}): ${listNames(missing)}`;
  await ctx.reply(out, HTML());
});

bot.command("remove", async (ctx) => {
  const handle = parseHandle(ctx.match);
  if (!handle) return ctx.reply("Usage: <b>/remove &lt;username or link&gt;</b>", HTML());
  const ok = await repo.removeWatch(ctx.from.id, handle);
  track(ctx.from.id, "remove", { handle, ok: !!ok });
  await ctx.reply(ok ? `✅ Unfollowed <b>@${esc(handle)}</b>.` : `<b>@${esc(handle)}</b> is not in your list.`, HTML());
});

// ---------- /accounts /settings /support ----------
bot.command("accounts", async (ctx) => {
  await repo.ensureUser(ctx.from.id, ctx.from.username);
  await show(ctx, accountsScreen(await repo.listWatches(ctx.from.id)));
});
bot.command("settings", async (ctx) => {
  await repo.ensureUser(ctx.from.id, ctx.from.username);
  await show(ctx, globalSettingsScreen(await repo.getGlobalSettings(ctx.from.id)));
});
bot.command("ref", async (ctx) => {
  await repo.ensureUser(ctx.from.id, ctx.from.username);
  await show(ctx, referralScreen(BOT_USER, ctx.from.id, await repo.referralStats(ctx.from.id)));
});
// /support <message> -> forward thẳng tới DM admin (không lưu DB). Rate-limit 60s/user + cap 1000 ký tự.
const supportCooldown = new Map();   // tgId -> last ts (in-memory; reset khi restart)
bot.command("support", async (ctx) => {
  const msg = (ctx.match || "").trim().slice(0, 1000);
  if (!msg) {
    return ctx.reply(
      `💬 <b>Support</b>\n\nDescribe your issue in one message, e.g.\n` +
      `<code>/support Paid for Pro with Stars but it isn't active</code>` +
      (cfg.supportContact ? `\n\nOr contact <b>${esc(cfg.supportContact)}</b> directly.` : ``),
      HTML());
  }
  const now = Date.now();
  if (now - (supportCooldown.get(ctx.from.id) || 0) < 60000)
    return ctx.reply(`⏳ Please wait a moment before sending another support message.`, HTML());
  if (!cfg.adminIds.length)
    return ctx.reply(`⚠️ Support isn't configured yet.${cfg.supportContact ? ` Contact <b>${esc(cfg.supportContact)}</b>.` : ""}`, HTML());

  const who = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || "user");
  const report =
    `🆘 <b>Support request</b>\n` +
    `👤 <b>${esc(who)}</b> (<code>${ctx.from.id}</code>)\n\n` +
    `📝 ${esc(msg)}`;
  let delivered = 0;
  for (const adminId of cfg.adminIds) {
    try { await ctx.api.sendMessage(adminId, report, HTML()); delivered++; }
    catch (e) { console.warn("[support] admin", adminId, e.message); }
  }
  if (!delivered)
    return ctx.reply(`❌ Couldn't reach support right now.${cfg.supportContact ? ` Please contact <b>${esc(cfg.supportContact)}</b>.` : " Please try again later."}`, HTML());
  supportCooldown.set(ctx.from.id, now);
  track(ctx.from.id, "support", { len: msg.length });
  await ctx.reply(`✅ <b>Report sent!</b> The team will get back to you as soon as possible.`, HTML());
});

// ---------- /subscribe + thanh toán Telegram Stars ----------
bot.command("subscribe", async (ctx) => {
  track(ctx.from.id, "subscribe_view", { enabled: cfg.subsEnabled ? 1 : 0 });
  if (!cfg.subsEnabled) return ctx.reply(SUBS_OFF_MSG, HTML());
  const u = await repo.ensureUser(ctx.from.id, ctx.from.username);
  await show(ctx, subscribeScreen(u, cfg));
});

// Bảng gói Stars — payload = kind (pro/whale/pack) → successful_payment route qua repo.applyPurchase.
const PLANS = {
  pro:   { title: "Pro Subscription",   stars: () => cfg.proPriceStars,   desc: () => `Watch up to ${cfg.proLimit} accounts for ${cfg.proDays} days.`,   label: () => `Pro ${cfg.proDays}d` },
  whale: { title: "Whale Subscription", stars: () => cfg.whalePriceStars, desc: () => `Watch up to ${cfg.whaleLimit} accounts for ${cfg.whaleDays} days.`, label: () => `Whale ${cfg.whaleDays}d` },
  pack:  { title: "Account Pack",       stars: () => cfg.packPriceStars,  desc: () => `+${cfg.packSize} accounts, valid until your current plan expires.`,  label: () => `+${cfg.packSize} accounts` },
};
async function sendPlanInvoice(ctx, kind) {
  if (!cfg.subsEnabled) { await ctx.reply(SUBS_OFF_MSG, HTML()); return; }
  const p = PLANS[kind]; if (!p) return;
  if (kind === "pack" && !repo.isActive(await repo.getUser(ctx.from.id)))
    return void ctx.reply("➕ Packs add accounts to a paid plan. Get <b>Pro</b> or <b>Whale</b> first.", HTML());
  const other = cfg.starsProviderToken ? { provider_token: cfg.starsProviderToken } : {};
  await ctx.replyWithInvoice(p.title, p.desc(), kind, "XTR", [{ label: p.label(), amount: p.stars() }], other);
  track(ctx.from.id, "invoice_stars", { kind });
}
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => {}));
bot.on("message:successful_payment", async (ctx) => {
  const pay = ctx.message.successful_payment;   // XTR: currency "XTR", total_amount=Stars, invoice_payload=kind, telegram_payment_charge_id
  const kind = pay.invoice_payload || "pro";
  const res = await repo.applyPurchase(ctx.from.id, kind);
  track(ctx.from.id, "paid_stars", { kind, stars: pay.total_amount });
  await repo.recordPayment({ tgId: ctx.from.id, method: "stars", kind, amount: pay.total_amount, currency: "XTR", ref: pay.telegram_payment_charge_id });
  paymentHook(`✅ Stars PAID · ${ctx.from.username ? "@" + ctx.from.username : ""} (${ctx.from.id}) · ${kind} · ${pay.total_amount}⭐ · limit ${res?.account_limit ?? "?"}`);
  await repo.markReferralSubscribed(ctx.from.id);
  const ref = await repo.awardRefConvert(ctx.from.id, { amount: pay.total_amount, currency: pay.currency, chargeId: pay.telegram_payment_charge_id });
  if (ref) notifyReferrer(ref.referrer, ref.points, "convert");
  const msg = kind === "pack"
    ? `✅ Payment received! <b>+${cfg.packSize}</b> accounts added — new limit <b>${res?.account_limit ?? "updated"}</b>.`
    : `✅ Payment successful! <b>${res?.tier ?? kind}</b> plan for ${res?.days ?? cfg.proDays} days, limit <b>${res?.account_limit ?? ""}</b> accounts.`;
  await ctx.reply(msg, HTML());
});

// /pay <sig> — fallback: tự khớp 1 giao dịch crypto nếu auto-credit chưa tới. docs §9 Phase 3.
bot.command("pay", async (ctx) => {
  if (!cfg.subsEnabled) return ctx.reply(SUBS_OFF_MSG, HTML());
  const sig = (ctx.match || "").trim();
  if (!sig) return ctx.reply("Usage: <b>/pay &lt;transaction signature&gt;</b>\nUse this only if an auto-credit didn't arrive.", HTML());
  await ctx.reply("🔎 Checking your transaction…", HTML());
  const r = await verifyManual(bot, sig);
  track(ctx.from.id, "pay_manual", { ok: r.ok ? 1 : 0 });
  if (r.ok) return ctx.reply("✅ Payment found and credited. Thanks!", HTML());
  if (r.error === "no_match") paymentHook(`⚠️ /pay NO MATCH · ${ctx.from.username ? "@" + ctx.from.username : ""} (${ctx.from.id}) · sig ${sig.slice(0, 12)}… — kiểm tra thủ công`);
  const m = r.error === "no_match" ? "No matching pending invoice (wrong amount/coin, or already credited)."
    : r.error === "tx_not_found" ? "Transaction not found yet — wait for confirmation and retry."
    : r.error === "crypto_disabled" ? "Crypto payments aren't enabled."
    : "Couldn't verify — please contact support.";
  await ctx.reply("⚠️ " + m, HTML());
});
// map lỗi makeInvoice -> toast ngắn
function cryptoErr(e) {
  return e === "price_unavailable" ? "SOL price unavailable — try USDC/USDT."
    : e === "too_many_pending" ? "Busy, try again in a moment."
    : e === "crypto_disabled" ? "Crypto isn't available right now."
    : "Couldn't create invoice, try again.";
}

// ---------- /grant (admin cấp Pro tay để test) ----------
bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [target, days] = (ctx.match || "").trim().split(/\s+/);
  const tg = Number(target); if (!tg) return ctx.reply("Usage: /grant <tg_id> [days]");
  await repo.ensureUser(tg);
  await repo.setUserPlan(tg, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: Date.now() + (Number(days) || cfg.proDays) * 86400000 });
  track(ctx.from.id, "admin", { cmd: "grant", target: tg, days: Number(days) || cfg.proDays });
  await ctx.reply(`✅ Granted Pro to ${tg} (${Number(days) || cfg.proDays} days).`);
});

// ---------- /whitelist (admin nâng user lên hạn mức TUỲ CHỈNH; limit 0 = hạ về Free) ----------
bot.command("whitelist", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [target, limitStr, days] = (ctx.match || "").trim().split(/\s+/);
  const tg = Number(target), limit = Number(limitStr);
  if (!tg || !Number.isFinite(limit)) return ctx.reply("Usage: <b>/whitelist &lt;tg_id&gt; &lt;limit&gt; [days]</b>\nlimit 0 = hạ về Free", HTML());
  await repo.ensureUser(tg);
  if (limit <= 0) {
    await repo.setUserPlan(tg, { tier: "Free", accountLimit: cfg.freeLimit, expiresAt: null });
    return ctx.reply(`✅ <b>${tg}</b> về <b>Free</b> (limit ${cfg.freeLimit}).`, HTML());
  }
  const expiresAt = days ? Date.now() + Number(days) * 86400000 : null;
  await repo.setUserPlan(tg, { tier: "Whitelist", accountLimit: limit, expiresAt });
  track(ctx.from.id, "admin", { cmd: "whitelist", target: tg, limit, ...(days && { days: Number(days) }) });
  await ctx.reply(`✅ Whitelisted <b>${tg}</b>: limit <b>${limit}</b>${days ? `, ${Number(days)} days` : " (no expiry)"}.`, HTML());
});

// ---------- /unwhitelist (admin: gỡ whitelist/Pro -> về Free) ----------
bot.command("unwhitelist", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const tg = Number((ctx.match || "").trim().split(/\s+/)[0]);
  if (!tg) return ctx.reply("Usage: <b>/unwhitelist &lt;tg_id&gt;</b>", HTML());
  const u = await repo.getUser(tg);
  if (!u) return ctx.reply(`⚠️ User <code>${tg}</code> chưa tồn tại.`, HTML());
  const prev = u.tier || "Free";
  await repo.setUserPlan(tg, { tier: "Free", accountLimit: cfg.freeLimit, expiresAt: null });
  track(ctx.from.id, "admin", { cmd: "unwhitelist", target: tg });
  await ctx.reply(`✅ <b>${tg}</b>: <b>${esc(prev)}</b> → <b>Free</b> (limit ${cfg.freeLimit}).`, HTML());
});

// ---------- /reply (admin trả lời user gửi /support) ----------
// 2 cách: `/reply <tg_id> <text>` — hoặc swipe-REPLY vào tin report 🆘 trong DM rồi gõ `/reply <text>`
// (bot tự móc tg_id từ "(<id>)" trong report). Gửi qua bot nên admin không lộ account cá nhân.
bot.command("reply", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  let msg = (ctx.match || "").trim();
  let target = null;
  // Ưu tiên tg_id từ tin được swipe-reply (nội dung giữ nguyên vẹn, kể cả khi bắt đầu bằng số);
  // không có thì mới parse "<tg_id> <text>" từ argument.
  const rm = (ctx.message?.reply_to_message?.text || "").match(/\((\d{4,})\)/);
  if (rm) target = Number(rm[1]);
  else {
    const m = msg.match(/^(\d{4,})\s+([\s\S]+)$/);
    if (m) { target = Number(m[1]); msg = m[2].trim(); }
  }
  if (!target || !msg) return ctx.reply(
    "Usage: <b>/reply &lt;tg_id&gt; &lt;message&gt;</b>\n" +
    "Hoặc <b>swipe-reply</b> vào tin report 🆘 rồi gõ <code>/reply nội dung trả lời</code>.", HTML());
  try {
    await ctx.api.sendMessage(target,
      `💬 <b>Reply from the Obscura team</b>\n\n${esc(msg)}\n\n<i>Need more help? Use /support &lt;message&gt;</i>`, HTML());
    track(ctx.from.id, "admin", { cmd: "reply", target });
    await ctx.reply(`✅ Đã gửi cho <code>${target}</code>.`, HTML());
  } catch (e) {
    await ctx.reply(`❌ Không gửi được cho <code>${target}</code>: ${esc(e.description || e.message)}\n<i>(thường do user chưa /start bot hoặc đã block)</i>`, HTML());
  }
});

// ---------- /admin (chỉ admin thấy — liệt kê lệnh admin + ví dụ) ----------
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;                 // user khác: im lặng (không lộ)
  const t =
    `🔐 <b>Admin commands</b>\n\n` +
    `<b>/grant</b> <code>&lt;tg_id&gt; [days]</code>\n` +
    `Cấp Pro (limit ${cfg.proLimit}, mặc định ${cfg.proDays} ngày).\n` +
    `<i>vd</i> <code>/grant 1034016594 30</code>\n\n` +
    `<b>/whitelist</b> <code>&lt;tg_id&gt; &lt;limit&gt; [days]</code>\n` +
    `Nâng hạn mức tuỳ chỉnh. Không có days = vô thời hạn.\n` +
    `<i>vd</i> <code>/whitelist 1034016594 100</code>\n` +
    `<i>vd</i> <code>/whitelist 1034016594 200 90</code>\n\n` +
    `<b>/unwhitelist</b> <code>&lt;tg_id&gt;</code>\n` +
    `Gỡ whitelist/Pro → về Free.\n` +
    `<i>vd</i> <code>/unwhitelist 1034016594</code>\n\n` +
    `<b>/reply</b> <code>&lt;tg_id&gt; &lt;message&gt;</code>\n` +
    `Trả lời user qua bot (từ report /support). Tiện nhất: <b>swipe-reply</b> vào tin 🆘 rồi gõ <code>/reply nội dung</code>.\n` +
    `<i>vd</i> <code>/reply 1034016594 Đã kích hoạt Pro cho bạn nhé!</code>\n\n` +
    `<b>/admin</b> — menu này.\n\n` +
    `<b>Tiers:</b> Free (${cfg.freeLimit}) · Pro (${cfg.proLimit}) · Whitelist (tuỳ admin)\n` +
    `💡 Lấy <code>tg_id</code>: user mở <b>/start</b> — dòng <b>ID</b> (tap to copy) — hoặc từ report <b>/support</b> / collection <code>user_stats</code>.`;
  await ctx.reply(t, HTML());
});

// ---------- callback router ----------
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const uid = ctx.from.id;
  try {
    if (data === "none") return ctx.answerCallbackQuery();
    if (data === "close") { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery(); }
    if (data === "del") { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery("Deleted"); }  // xoá tin noti
    if (data === "home") { track(uid, "nav", { to: "home" }); await welcome(ctx, true); return ctx.answerCallbackQuery(); }
    if (data === "viewAccounts") { track(uid, "nav", { to: "accounts" }); await show(ctx, accountsScreen(await repo.listWatches(uid)), true); return ctx.answerCallbackQuery("Viewing accounts"); }
    if (data === "referrals") { track(uid, "nav", { to: "referrals" }); await show(ctx, referralScreen(BOT_USER, uid, await repo.referralStats(uid)), true); return ctx.answerCallbackQuery("Viewing Referrals..."); }
    if (data === "globalsettings") { track(uid, "nav", { to: "settings" }); await show(ctx, globalSettingsScreen(await repo.getGlobalSettings(uid)), true); return ctx.answerCallbackQuery("Viewing global settings"); }
    if (data === "subscribe") {
      track(uid, "subscribe_view", { enabled: cfg.subsEnabled ? 1 : 0 });
      if (!cfg.subsEnabled) { await ctx.reply(SUBS_OFF_MSG, HTML()); return ctx.answerCallbackQuery(); }
      await show(ctx, subscribeScreen(await repo.getUser(uid), cfg), true); return ctx.answerCallbackQuery();
    }
    if (data.startsWith("plan:")) {
      const kind = data.slice(5);
      track(uid, "plan_view", { kind });
      if (cryptoEnabled()) { await show(ctx, paymentMethodScreen(kind, cfg), true); return ctx.answerCallbackQuery(); }
      await sendPlanInvoice(ctx, kind); return ctx.answerCallbackQuery();          // crypto off -> Stars thẳng
    }
    if (data.startsWith("stars:")) { await sendPlanInvoice(ctx, data.slice(6)); return ctx.answerCallbackQuery(); }
    if (data.startsWith("crypto:")) {
      const kind = data.slice(7);
      if (kind === "pack" && !repo.isActive(await repo.getUser(uid)))
        { await ctx.reply("➕ Packs add accounts to a paid plan. Get <b>Pro</b> or <b>Whale</b> first.", HTML()); return ctx.answerCallbackQuery(); }
      await show(ctx, cryptoCoinScreen(kind, cfg), true); return ctx.answerCallbackQuery();
    }
    if (data.startsWith("pc:")) {
      const [, kind, coin] = data.split(":");
      const r = await makeInvoice(uid, kind, coin);
      if (!r.ok) return ctx.answerCallbackQuery(cryptoErr(r.error));
      track(uid, "invoice_crypto", { kind, coin: r.coin });
      await show(ctx, cryptoInvoiceScreen(kind, r.coin, r.amount, r.address, cfg.cryptoWindowMin), true);
      return ctx.answerCallbackQuery();
    }

    if (data.startsWith("acct:")) {
      const h = data.slice(5);
      await show(ctx, accountSettingsScreen(h, await repo.effectiveSettings(uid, h)), true);
      return ctx.answerCallbackQuery();
    }
    if (data.startsWith("rm:")) {
      const h = data.slice(3);
      await repo.removeWatch(uid, h);
      track(uid, "remove", { handle: h, ok: 1 });
      await show(ctx, accountsScreen(await repo.listWatches(uid)), true);
      return ctx.answerCallbackQuery(`Removed @${h}`);
    }
    if (data.startsWith("tg:")) return toggle(ctx, byKey[data.slice(3)], { type: "g" });
    if (data.startsWith("tw:")) {
      const rest = data.slice(3); const i = rest.indexOf(":");
      const handle = rest.slice(0, i), key = rest.slice(i + 1);
      return toggle(ctx, byKey[key], { type: "w", handle });
    }
    if (data.startsWith("platmenu:")) { await showPlatform(ctx, data.slice(9), true); return ctx.answerCallbackQuery(); }
    if (data.startsWith("plat:en:")) {                 // master enable Truth/IG
      const p = data.slice(8);
      if (PLATFORMS.has(p)) {
        const cur = (await repo.getGlobalSettings(uid))[p];
        await repo.setGlobalSetting(uid, p, cur ? 0 : 1);
        track(uid, "platform", { p, act: cur ? "off" : "on" });
        await showPlatform(ctx, p, true);
        return ctx.answerCallbackQuery(cur ? "Disabled" : "Enabled");
      }
      return ctx.answerCallbackQuery();
    }
    if (data.startsWith("plat:all:") || data.startsWith("plat:none:")) {   // Select All / Clear All
      const selectAll = data.startsWith("plat:all:");
      const p = data.slice(selectAll ? 9 : 10);
      if (PLATFORMS.has(p)) {
        if (selectAll && !repo.hasAccess(await repo.getUser(uid))) return ctx.answerCallbackQuery("Trial ended — /subscribe to add");
        const pl = await repo.getJ7Platforms();
        const list = platformDisplayList(p, (p === "truth" ? pl?.truth : pl?.ig) || []);
        for (const h of list) {
          try {
            if (selectAll) await repo.addPlatformWatch(uid, h, p);
            else await repo.removePlatformWatch(uid, h, p);
          } catch (e) { console.warn("[plat-all]", p, h, e.message); }   // 1 handle lỗi không chặn cả list
        }
        track(uid, "platform", { p, act: selectAll ? "all" : "none", n: list.length });
        await showPlatform(ctx, p, true);
        return ctx.answerCallbackQuery(selectAll ? `Followed all (${list.length})` : "Cleared all");
      }
      return ctx.answerCallbackQuery();
    }
    if (data.startsWith("plat:pk:")) {                 // follow/unfollow 1 account platform
      const rest = data.slice(8); const i = rest.indexOf(":");
      const p = rest.slice(0, i), h = rest.slice(i + 1);
      if (PLATFORMS.has(p) && h) {
        const set = await repo.platformWatchSet(uid, p);
        const had = set.has(h.toLowerCase());
        if (had) await repo.removePlatformWatch(uid, h, p);   // gỡ luôn cho phép
        else if (!repo.hasAccess(await repo.getUser(uid))) return ctx.answerCallbackQuery("Trial ended — /subscribe to add");
        else await repo.addPlatformWatch(uid, h, p);
        track(uid, "platform", { p, act: had ? "unfollow" : "follow", h });
        await showPlatform(ctx, p, true);
      }
      return ctx.answerCallbackQuery();
    }
    return ctx.answerCallbackQuery();
  } catch (e) {
    console.warn("[cb]", data, e.message);
    return ctx.answerCallbackQuery({ text: "Something went wrong, try again.", show_alert: false }).catch(() => {});
  }
});

// Toggle 1 khoá: đọc trạng thái từ DB rồi đảo (không tin callback) — tránh race, tốt hơn bot gốc.
async function toggle(ctx, s, scope) {
  if (!s) return ctx.answerCallbackQuery();
  if (s.gate) return ctx.answerCallbackQuery({ text: GATE_TEXT[s.gate], show_alert: true });
  // Khoá đã gỡ khỏi UI (vd deleteButton) nhưng nút còn trên màn settings CŨ trong chat -> no-op,
  // không cho toggle ngầm (deleteButton bật lại = keyboard dính callback = mất nút khi forward).
  if (s.hidden) return ctx.answerCallbackQuery();
  const uid = ctx.from.id;
  if (scope.type === "g") {
    const cur = (await repo.getGlobalSettings(uid))[s.col];
    await repo.setGlobalSetting(uid, s.col, cur ? 0 : 1);
    track(uid, "toggle", { key: s.key, scope: "g", on: cur ? 0 : 1 });
    await show(ctx, globalSettingsScreen(await repo.getGlobalSettings(uid)), true);
  } else {
    const cur = (await repo.effectiveSettings(uid, scope.handle))[s.col];
    await repo.setWatchSetting(uid, scope.handle, s.col, cur ? 0 : 1);
    track(uid, "toggle", { key: s.key, scope: "w", h: scope.handle, on: cur ? 0 : 1 });
    await show(ctx, accountSettingsScreen(scope.handle, await repo.effectiveSettings(uid, scope.handle)), true);
  }
  return ctx.answerCallbackQuery();
}

// ---------- boot ----------
bot.catch((err) => console.error("[bot error]", err.error?.message || err.message));

const me = await bot.api.getMe();
BOT_USER = me.username;
// Menu chung (mọi user). subscribe ẩn khi SUBS_ENABLED != 1 (giai đoạn test).
const userCommands = [
  { command: "start", description: "main menu" },
  { command: "add", description: "/add username or link | track a new X account" },
  { command: "remove", description: "/remove username | stop tracking an account" },
  { command: "bulkadd", description: "/bulkadd user1 user2 … | track a whole list at once" },
  { command: "bulkremove", description: "/bulkremove user1 user2 … | untrack many at once" },
  { command: "accounts", description: "view tracked accounts" },
  { command: "settings", description: "notification settings per account" },
  { command: "ref", description: "your referral link & points" },
  ...(cfg.subsEnabled ? [{ command: "subscribe", description: "upgrade your plan" }] : []),
  { command: "support", description: "/support <message> | report an issue to the team" },
  // ẩn tạm cho tới khi có handler: mute, ca
];
await bot.api.setMyCommands(userCommands);
// Lệnh admin — CHỈ hiện trong menu của admin (scope theo chat), user khác không thấy.
const adminCommands = [
  { command: "admin", description: "admin help — all admin commands" },
  { command: "grant", description: "/grant <tg_id> [days] | grant Pro" },
  { command: "whitelist", description: "/whitelist <tg_id> <limit> [days] | custom limit" },
  { command: "unwhitelist", description: "/unwhitelist <tg_id> | back to Free" },
  { command: "reply", description: "/reply <tg_id> <msg> | reply to a /support report" },
];
for (const id of cfg.adminIds)
  await bot.api.setMyCommands([...userCommands, ...adminCommands], { scope: { type: "chat", chat_id: id } }).catch((e) => console.warn("[admin menu]", id, e.message));
console.log(`FE bot @${BOT_USER} running.`);

// Sweep hạ gói hết hạn -> Free + pause watch vượt Free + báo user. Chạy ngay + mỗi expirySweepMin phút.
function startExpirySweep() {
  const run = async () => {
    try {
      const list = await repo.sweepExpired();
      for (const d of list) {
        const msg = d.tier === "Free"
          ? `⌛ Your <b>${cfg.trialDays}-day free trial</b> has ended. Your accounts are <b>paused</b> (no alerts).\nUse <b>/subscribe</b> to continue — they reactivate instantly.`
          : `⌛ Your <b>${esc(d.tier)}</b> plan has expired. Your accounts are <b>paused</b>.\nUse <b>/subscribe</b> to renew — everything reactivates instantly.`;
        try { await bot.api.sendMessage(d.tgId, msg, { parse_mode: "HTML" }); } catch {}
      }
      if (list.length) console.log(`[expiry] paused ${list.length} expired user(s)`);
    } catch (e) { console.warn("[expiry]", e.message); }
  };
  run();
  setInterval(run, cfg.expirySweepMin * 60000);
}

process.once("SIGINT", async () => { await bot.stop(); await close(); process.exit(0); });
process.once("SIGTERM", async () => { await bot.stop(); await close(); process.exit(0); });
startExpirySweep();       // expiry-downgrade: hạ gói hết hạn + pause watch vượt Free
startCryptoPoller(bot);   // Phase 2: dò thanh toán crypto (no-op nếu chưa cấu hình ví/RPC)
await bot.start({ onStart: () => console.log("polling…") });
