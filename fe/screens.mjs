// screens.mjs — render text + inline keyboard cho từng màn (bám bot_build_spec.md §6).
// Trả { text, keyboard } với keyboard là grammy InlineKeyboard.
import { InlineKeyboard } from "grammy";
import { SETTINGS, OCR, byKey, label } from "../shared/settings.mjs";

const BOT_NAME = "Obscura Systems";

// Hết hạn CHỈ khi có expires_at và đã qua. Free & Whitelist (admin không đặt hạn) -> "Never";
// Pro (và Whitelist có hạn) -> ngày, hoặc EXPIRED nếu qua.
const isPlanExpired = (u) => !!u?.expires_at && u.expires_at < Date.now();
const fmtExp = (u) => {
  if (!u?.expires_at) return "Never";
  return isPlanExpired(u) ? "EXPIRED" : new Date(u.expires_at).toISOString().slice(0, 10);
};

// #1 Welcome
export function welcomeScreen(user, nWatched, botUser) {
  const expired = isPlanExpired(user);
  let text =
    `Welcome to ${BOT_NAME}, <b>${esc(user?.username || "there")}</b> 👋\n\n` +
    `📊 Your plan:\n` +
    `• Tier: <b>${esc(user?.tier || "Free")}</b>\n` +
    `• Limit: <b>${user?.account_limit ?? 0}</b> Accounts\n` +
    `• Exp: <b>${fmtExp(user)}</b>\n\n` +
    `Current Accounts Watched:\n` +
    `• <i>X</i>: <b>${nWatched}</b>\n\n` +
    `💡 <b>/add</b> &amp; <b>/remove</b> <b>&lt;username&gt;</b> for X`;
  if (expired) text += `\n\n⚠️ Your plan has expired. Use /subscribe to purchase a plan to continue using the service.`;
  const keyboard = new InlineKeyboard()
    .text("👀 X accounts", "viewAccounts").row()
    .text("🟣 Truth Social", "platmenu:truth").text("📸 Instagram", "platmenu:ig").row()
    .text("👥 Referrals", "referrals").row()
    .text("⚙️ Global Settings", "globalsettings");
  return { text, keyboard };
}

// 🟣📸 Truth/IG picker — master enable + chọn account từ list global (BE capture vào j7_platform).
const PLAT_META = { truth: { emoji: "🟣", name: "Truth Social" }, ig: { emoji: "📸", name: "Instagram" } };
export function platformScreen(platform, enabled, globalList, followed) {
  const m = PLAT_META[platform] || { emoji: "❓", name: platform };
  const kb = new InlineKeyboard();
  kb.text(`${enabled ? "✅" : "❌"} Enable ${m.name}`, `plat:en:${platform}`).row();
  let text = `${m.emoji} <b>${m.name}</b>\n\n`;
  if (!enabled) {
    text += `Turn on <b>Enable ${m.name}</b> to receive posts from the accounts you follow below.\n\n` +
      `<i>Currently OFF — you won't get ${m.name} notifications.</i>`;
  } else if (!globalList.length) {
    text += `No ${m.name} accounts available yet. Check back later.`;
  } else {
    text += `Tap to follow / unfollow. ✅ = you'll get their ${m.name} posts.\n` +
      `<b>${followed.size}</b>/${globalList.length} followed.`;
    for (const h of globalList) {
      const on = followed.has(String(h).toLowerCase());
      kb.text(`${on ? "✅" : "➕"} ${h}`, `plat:pk:${platform}:${h}`).row();
    }
  }
  kb.text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard: kb };
}

// #5 Referral
export function referralScreen(botUser, tgId, stats) {
  const text =
    `👥 <b>Your Referral Stats</b>\n\n` +
    `• Amount: <b>${stats.direct}</b>\n` +
    `• Indirect: <b>${stats.indirect}</b>\n` +
    `• Subscribed: <b>${stats.subscribed}</b>\n` +
    `• Earned: <b>${stats.points}</b> Points\n\n` +
    `<b>🔗 Tap To Copy Referral Link</b>\n` +
    `<code>https://t.me/${botUser}?start=${tgId}</code>`;
  const keyboard = new InlineKeyboard().text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard };
}

// #7 Global Settings (và dùng lại cho per-account)
const SETTINGS_TEXT =
  `⚙️ Global Settings ⚙️\n\n` +
  `📨 <b>Preset For New Accounts</b> ⇢ <i>Set default settings for when you add a new account. That way you don't have to set these every time.</i>\n\n` +
  `⚒ <b>Custom Notifications</b> ⇢ <i>Get alerted when a tracked account is suspended or deactivated.</i>\n\n` +
  `❌ = <b>Disabled</b> | Tap to enable/disable a setting.`;

// scope: {type:'g'} hoặc {type:'w', handle}. cb() dựng callback_data cho 1 khoá.
function settingsKeyboard(values, scope) {
  const cb = (key) => scope.type === "g" ? `tg:${key}` : `tw:${scope.handle}:${key}`;
  const on = (s) => !!values[s.col];
  const btn = (kb, s) => kb.text(label(s, on(s)), cb(s.key));
  const kb = new InlineKeyboard();

  if (!OCR.hidden) btn(kb, OCR).row();                  // OCR (ẩn cho tới khi wired)
  kb.text("---- New Accounts ----", "none").row();
  const newAcc = SETTINGS.filter((s) => s.group === "new" && !s.hidden);
  for (let i = 0; i < newAcc.length; i += 2) {
    btn(kb, newAcc[i]);
    if (newAcc[i + 1]) btn(kb, newAcc[i + 1]);
    kb.row();
  }
  kb.text("---- Custom Notifications ----", "none").row();
  const cn = SETTINGS.filter((s) => s.group === "cn" && !s.hidden);
  for (let i = 0; i < cn.length; i += 2) {
    btn(kb, cn[i]);
    if (cn[i + 1]) btn(kb, cn[i + 1]);
    kb.row();
  }
  if (scope.type === "g") kb.text("⬅️ Back", "home").text("ⓧ Close", "close");
  else kb.text("⬅️ Back", "viewAccounts").text("ⓧ Close", "close");
  return kb;
}

export function globalSettingsScreen(values) {
  return { text: SETTINGS_TEXT, keyboard: settingsKeyboard(values, { type: "g" }) };
}
export function accountSettingsScreen(handle, values) {
  const text = `⚙️ Settings for <b>@${esc(handle)}</b>\n\n<i>Override the preset for this account only.</i>\n\n❌ = <b>Disabled</b> | Tap to toggle.`;
  return { text, keyboard: settingsKeyboard(values, { type: "w", handle }) };
}

// 👀 X accounts — danh sách
export function accountsScreen(watches) {
  if (!watches.length) {
    return { text: "You are not watching any accounts yet.\n\nUse <b>/add &lt;username&gt;</b> to add one.", keyboard: new InlineKeyboard().text("⬅️ Back", "home").text("ⓧ Close", "close") };
  }
  const text = `👀 <b>Accounts You Watch</b> (${watches.length})\n\n` +
    watches.map((w) => `• <b>@${esc(w.handle)}</b>`).join("\n") +
    `\n\n<i>Tap ⚙️ to customize, 🗑 to unfollow.</i>`;
  const kb = new InlineKeyboard();
  for (const w of watches) {
    kb.text(`⚙️ ${w.handle}`, `acct:${w.handle}`).text(`🗑`, `rm:${w.handle}`).row();
  }
  kb.text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard: kb };
}

// /subscribe — bảng gói
export function subscribeScreen(user, price, days, limit) {
  const text =
    `💎 <b>Subscribe</b>\n\n` +
    `<b>Free</b> — watch a few accounts, basic features.\n\n` +
    `<b>Pro</b> — <b>${price}</b> ⭐ / ${days} days\n` +
    `• Watch up to <b>${limit}</b> accounts\n` +
    `• Unlock every notification type\n\n` +
    `Current status: <b>${esc(user?.tier || "Free")}</b> · Exp: <b>${fmtExp(user)}</b>`;
  const keyboard = new InlineKeyboard().text(`⭐ Buy Pro (${price})`, "buy:pro").row().text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard };
}

export function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export { byKey };
