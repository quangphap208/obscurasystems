// bot.mjs — entry FE. Telegram bot (grammy) clone @redactedsystemsbot.
// Delivery = DM: thông báo do BE gửi thẳng vào chat user (tg_id). FE lo UI + quản lý watch/settings/gói.
import { Bot, GrammyError } from "grammy";
import { cfg, assertFE, isAdmin } from "../shared/config.mjs";
import { connect, close } from "../shared/mongo.mjs";
import * as repo from "../shared/repo.mjs";
import { byKey, GATE_TEXT } from "../shared/settings.mjs";
import { resolveHandle, parseHandle } from "./xsearch.mjs";
import {
  welcomeScreen, referralScreen, globalSettingsScreen, accountSettingsScreen,
  accountsScreen, subscribeScreen, esc,
} from "./screens.mjs";

assertFE();
await connect();

const bot = new Bot(cfg.botToken);
let BOT_USER = null;

const NOPREVIEW = { link_preview_options: { is_disabled: true } };
const HTML = (extra = {}) => ({ parse_mode: "HTML", ...NOPREVIEW, ...extra });

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

async function welcome(ctx, edit = false) {
  const u = await repo.getUser(ctx.from.id);
  const n = await repo.countWatches(ctx.from.id);
  await show(ctx, welcomeScreen(u, n, BOT_USER), edit);
}

// ---------- /start (+ deep-link) ----------
bot.command("start", async (ctx) => {
  const p = (ctx.match || "").trim();
  let referredBy = null, qa = null;
  if (/^\d+$/.test(p)) referredBy = Number(p);
  else if (/^qa[\s_+]?/i.test(p)) qa = p.replace(/^qa[\s_+]?/i, "").replace(/^@/, "");
  await repo.ensureUser(ctx.from.id, ctx.from.username || ctx.from.first_name, referredBy);
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
  if (await repo.getWatch(ctx.from.id, handle)) return ctx.reply(`Already watching <b>@${esc(handle)}</b>.`, HTML());
  const n = await repo.countWatches(ctx.from.id);
  if (n >= (u.account_limit ?? 0)) return ctx.reply(`⚠️ You've reached the <b>${u.account_limit}</b>-account limit of your <b>${esc(u.tier)}</b> plan.\nUse /subscribe to upgrade.`, HTML());
  const r = await resolveHandle(handle);
  if (r.found === false) return ctx.reply(`❌ <b>@${esc(handle)}</b> not found on X.`, HTML());
  await repo.addWatch(ctx.from.id, r.found ? r.handle : handle, r.xid || null);
  await ctx.reply(`✅ Added <b>@${esc(r.found ? r.handle : handle)}</b>. Notifications will arrive shortly.\nCustomize it: 👀 X accounts.`, HTML());
});

bot.command("remove", async (ctx) => {
  const handle = parseHandle(ctx.match);
  if (!handle) return ctx.reply("Usage: <b>/remove &lt;username or link&gt;</b>", HTML());
  const ok = await repo.removeWatch(ctx.from.id, handle);
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
  await ctx.reply(`✅ <b>Report sent!</b> The team will get back to you as soon as possible.`, HTML());
});

// ---------- /subscribe + thanh toán Telegram Stars ----------
bot.command("subscribe", async (ctx) => {
  const u = await repo.ensureUser(ctx.from.id, ctx.from.username);
  await show(ctx, subscribeScreen(u, cfg.proPriceStars, cfg.proDays, cfg.proLimit));
});

async function sendProInvoice(ctx) {
  const other = cfg.starsProviderToken ? { provider_token: cfg.starsProviderToken } : {};
  await ctx.replyWithInvoice(
    "Pro Subscription", `Watch up to ${cfg.proLimit} accounts for ${cfg.proDays} days.`,
    "pro", "XTR", [{ label: `Pro ${cfg.proDays}d`, amount: cfg.proPriceStars }], other);
}
bot.on("pre_checkout_query", (ctx) => ctx.answerPreCheckoutQuery(true).catch(() => {}));
bot.on("message:successful_payment", async (ctx) => {
  await repo.setUserPlan(ctx.from.id, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: Date.now() + cfg.proDays * 86400000 });
  await repo.markReferralSubscribed(ctx.from.id);
  await ctx.reply(`✅ Payment successful! <b>Pro</b> plan for ${cfg.proDays} days, limit <b>${cfg.proLimit}</b> accounts.`, HTML());
});

// ---------- /grant (admin cấp gói tay để test) ----------
bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const [target, days] = (ctx.match || "").trim().split(/\s+/);
  const tg = Number(target); if (!tg) return ctx.reply("Usage: /grant <tg_id> [days]");
  await repo.ensureUser(tg);
  await repo.setUserPlan(tg, { tier: "Pro", accountLimit: cfg.proLimit, expiresAt: Date.now() + (Number(days) || cfg.proDays) * 86400000 });
  await ctx.reply(`✅ Granted Pro to ${tg} (${Number(days) || cfg.proDays} days).`);
});

// ---------- callback router ----------
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const uid = ctx.from.id;
  try {
    if (data === "none") return ctx.answerCallbackQuery();
    if (data === "close") { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery(); }
    if (data === "del") { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery("Deleted"); }  // xoá tin noti
    if (data === "home") { await welcome(ctx, true); return ctx.answerCallbackQuery(); }
    if (data === "viewAccounts") { await show(ctx, accountsScreen(await repo.listWatches(uid)), true); return ctx.answerCallbackQuery("Viewing accounts"); }
    if (data === "referrals") { await show(ctx, referralScreen(BOT_USER, uid, await repo.referralStats(uid)), true); return ctx.answerCallbackQuery("Viewing Referrals..."); }
    if (data === "globalsettings") { await show(ctx, globalSettingsScreen(await repo.getGlobalSettings(uid)), true); return ctx.answerCallbackQuery("Viewing global settings"); }
    if (data === "subscribe") { await show(ctx, subscribeScreen(await repo.getUser(uid), cfg.proPriceStars, cfg.proDays, cfg.proLimit), true); return ctx.answerCallbackQuery(); }
    if (data === "buy:pro") { await sendProInvoice(ctx); return ctx.answerCallbackQuery(); }

    if (data.startsWith("acct:")) {
      const h = data.slice(5);
      await show(ctx, accountSettingsScreen(h, await repo.effectiveSettings(uid, h)), true);
      return ctx.answerCallbackQuery();
    }
    if (data.startsWith("rm:")) {
      const h = data.slice(3);
      await repo.removeWatch(uid, h);
      await show(ctx, accountsScreen(await repo.listWatches(uid)), true);
      return ctx.answerCallbackQuery(`Removed @${h}`);
    }
    if (data.startsWith("tg:")) return toggle(ctx, byKey[data.slice(3)], { type: "g" });
    if (data.startsWith("tw:")) {
      const rest = data.slice(3); const i = rest.indexOf(":");
      const handle = rest.slice(0, i), key = rest.slice(i + 1);
      return toggle(ctx, byKey[key], { type: "w", handle });
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
  const uid = ctx.from.id;
  if (scope.type === "g") {
    const cur = (await repo.getGlobalSettings(uid))[s.col];
    await repo.setGlobalSetting(uid, s.col, cur ? 0 : 1);
    await show(ctx, globalSettingsScreen(await repo.getGlobalSettings(uid)), true);
  } else {
    const cur = (await repo.effectiveSettings(uid, scope.handle))[s.col];
    await repo.setWatchSetting(uid, scope.handle, s.col, cur ? 0 : 1);
    await show(ctx, accountSettingsScreen(scope.handle, await repo.effectiveSettings(uid, scope.handle)), true);
  }
  return ctx.answerCallbackQuery();
}

// ---------- boot ----------
bot.catch((err) => console.error("[bot error]", err.error?.message || err.message));

const me = await bot.api.getMe();
BOT_USER = me.username;
await bot.api.setMyCommands([
  { command: "start", description: "main menu" },
  { command: "add", description: "/add username or link | track a new X account" },
  { command: "remove", description: "/remove username | stop tracking an account" },
  { command: "accounts", description: "view tracked accounts" },
  { command: "settings", description: "notification settings per account" },
  { command: "subscribe", description: "upgrade your plan" },
  { command: "support", description: "/support <message> | report an issue to the team" },
  // ẩn tạm cho tới khi có handler: bulkremove, mute, ca
]);
console.log(`FE bot @${BOT_USER} running.`);

process.once("SIGINT", async () => { await bot.stop(); await close(); process.exit(0); });
process.once("SIGTERM", async () => { await bot.stop(); await close(); process.exit(0); });
await bot.start({ onStart: () => console.log("polling…") });
