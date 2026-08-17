// screens.mjs — render text + inline keyboard cho từng màn (bám bot_build_spec.md §6).
// Trả { text, keyboard } với keyboard là grammy InlineKeyboard.
import { InlineKeyboard } from "grammy";
import { SETTINGS, OCR, byKey, label } from "../shared/settings.mjs";

const BOT_NAME = "Obscura Systems";

// Hết hạn CHỈ khi có expires_at và đã qua. Free & Whitelist (admin không đặt hạn) -> "Never";
// Pro (và Whitelist có hạn) -> ngày, hoặc EXPIRED nếu qua.
const isPlanExpired = (u) => !!u?.expires_at && u.expires_at < Date.now();
// Hiện THỜI GIAN CÒN LẠI (trial/gói). Whitelist (không hạn) -> "Never".
const fmtExp = (u) => {
  if (!u?.expires_at) return "Never";
  const ms = u.expires_at - Date.now();
  if (ms <= 0) return "EXPIRED";
  const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return d > 0 ? `${d}d ${h}h left` : h > 0 ? `${h}h ${m}m left` : `${m}m left`;
};

// #1 Welcome
export function welcomeScreen(user, nWatched, botUser) {
  const expired = isPlanExpired(user);
  let text =
    `Welcome to ${BOT_NAME}, <b>${esc(user?.username || "there")}</b> 👋\n\n` +
    `📊 Your plan:\n` +
    `• ID: <code>${user?.tg_id ?? "?"}</code> <i>(tap to copy)</i>\n` +
    `• Tier: <b>${user?.tier === "Free" ? "Free trial" : esc(user?.tier || "Free")}</b>\n` +
    `• Limit: <b>${user?.account_limit ?? 0}</b> X accounts\n` +
    `• Exp: <b>${fmtExp(user)}</b>\n\n` +
    `✅ 📸 <b>Instagram</b> &amp; 🟣 <b>Truth Social</b>: full access — just enable (not counted in your X limit)\n\n` +
    `Current Accounts Watched:\n` +
    `• <i>X</i>: <b>${nWatched}</b>\n\n` +
    `💡 <b>/add</b> &amp; <b>/remove</b> <b>&lt;username&gt;</b> for X`;
  if (expired) text += `\n\n⚠️ Your ${user?.tier === "Free" ? "free trial" : "plan"} has ended — accounts paused. Use /subscribe to continue.`;
  const keyboard = new InlineKeyboard()
    .text("👀 X accounts", "viewAccounts").row()
    .text("🟣 Truth Social", "platmenu:truth").text("📸 Instagram", "platmenu:ig").row()
    .text("👥 Referrals", "referrals").row()
    .text("⚙️ Global Settings", "globalsettings");
  return { text, keyboard };
}

// 🟣📸 Truth/IG picker — master enable + chọn account từ list global (BE capture vào j7_platform).
const PLAT_META = { truth: { emoji: "🟣", name: "Truth Social" }, ig: { emoji: "📸", name: "Instagram" } };

// TẠM THỜI: IG global ~65 quá nhiều -> chỉ show allowlist này (nhóm theo chủ đề). Bỏ/mở rộng khi cần.
const IG_CURATED = [
  { group: "Crypto", handles: ["a16z", "abtc", "binance", "binance.zh", "changpengzhao", "official_bonk_inu", "phantom", "solana"] },
  { group: "Meme / Animals", handles: ["balltze", "kabosumama", "knowyourmeme", "zoos", "natgeoanimals"] },
  { group: "AI", handles: ["chatgpt", "claudeai", "googlegemini", "grok", "meta.ai", "openai", "soraofficial"] },
];

// IG -> allowlist nhóm (lọc theo global nếu đã có data; global rỗng -> show cả allowlist). Truth -> phẳng.
function platformGroups(platform, globalList) {
  if (platform === "ig") {
    const avail = new Set((globalList || []).map((h) => String(h).toLowerCase()));
    return IG_CURATED
      .map((g) => ({ group: g.group, handles: avail.size ? g.handles.filter((h) => avail.has(h.toLowerCase())) : g.handles }))
      .filter((g) => g.handles.length);
  }
  return [{ group: null, handles: globalList || [] }];
}

// Danh sách handle ĐANG hiển thị ở picker (IG = curated, Truth = full) — cho Select/Clear All.
export function platformDisplayList(platform, globalList) {
  return platformGroups(platform, globalList).flatMap((g) => g.handles);
}

export function platformScreen(platform, enabled, globalList, followed) {
  const m = PLAT_META[platform] || { emoji: "❓", name: platform };
  const groups = platformGroups(platform, globalList);
  const total = groups.reduce((n, g) => n + g.handles.length, 0);
  const kb = new InlineKeyboard();
  kb.text(`${enabled ? "✅" : "❌"} Enable ${m.name}`, `plat:en:${platform}`).row();
  if (enabled && total) kb.text("☑️ Select All", `plat:all:${platform}`).text("🧹 Clear All", `plat:none:${platform}`).row();
  let text = `${m.emoji} <b>${m.name}</b>\n\n`;
  if (!enabled) {
    text += `Turn on <b>Enable ${m.name}</b> to receive posts from the accounts you follow below.\n\n` +
      `<i>Currently OFF — you won't get ${m.name} notifications.</i>`;
  } else if (!total) {
    text += `No ${m.name} accounts available yet. Check back later.`;
  } else {
    text += `Tap to follow / unfollow. ✅ = you'll get their ${m.name} posts.\n<b>${followed.size}</b> followed.\n\n` +
      // Nói RÕ giới hạn (support 17/8): X add account nào cũng được nên user tưởng IG/Truth cũng vậy —
      // thực tế post đến từ pool capture cố định, không stream account tuỳ ý.
      `<i>ℹ️ ${m.name} works differently from X: only the accounts listed here are available — custom accounts can't be added yet. Want one included? Tell us via /support.</i>`;
    for (const g of groups) {
      if (g.group) kb.text(`── ${g.group} ──`, "none").row();
      for (const h of g.handles) {
        const on = followed.has(String(h).toLowerCase());
        kb.text(`${on ? "✅" : "➕"} ${h}`, `plat:pk:${platform}:${h}`).row();
      }
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
    `<code>https://t.me/${botUser}?start=${tgId}</code>\n\n` +
    `<i>Earn points on every friend who joins & upgrades. Rewards coming soon.</i>`;
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
  const paused = watches.filter((w) => w.paused).length;
  const text = `👀 <b>Accounts You Watch</b> (${watches.length})\n\n` +
    watches.map((w) => `• <b>@${esc(w.handle)}</b>${w.paused ? " ⏸ <i>paused</i>" : ""}`).join("\n") +
    (paused ? `\n\n⏸ <b>${paused}</b> paused — no alerts. <b>/subscribe</b> to reactivate all.` : ``) +
    `\n\n<i>Tap ⚙️ to customize, 🗑 to unfollow.</i>`;
  const kb = new InlineKeyboard();
  for (const w of watches) {
    kb.text(`⚙️ ${w.handle}`, `acct:${w.handle}`).text(`🗑`, `rm:${w.handle}`).row();
  }
  kb.text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard: kb };
}

// /subscribe — bảng gói (Free/Pro/Whale + pack). Giá lấy từ cfg. Xem docs/PAYMENT_RESEARCH.md §2.
export function subscribeScreen(user, c) {
  const crypto = c.receiveSolAddresses?.length > 0 && c.solanaRpcUrls?.length > 0;   // chỉ nudge crypto khi đã bật
  const text =
    `💎 <b>Subscribe</b>\n\n` +
    `<b>Free trial</b> — <b>${c.freeLimit}</b> accounts for <b>${c.trialDays}</b> days. Full features to try.\n\n` +
    `<b>Pro</b> — <b>${c.proPriceStars}</b>⭐ / ${c.proDays}d\n` +
    `• Up to <b>${c.proLimit}</b> accounts · every notification type\n\n` +
    `<b>Whale</b> — <b>${c.whalePriceStars}</b>⭐ / ${c.whaleDays}d\n` +
    `• Up to <b>${c.whaleLimit}</b> accounts · best value per account\n\n` +
    `✅ 📸 <b>Instagram</b> &amp; 🟣 <b>Truth Social</b>: full access on <b>every</b> plan — just enable (limits above are for X only).\n\n` +
    `<i>Need more? Add <b>+${c.packSize}</b> accounts (${c.packPriceStars}⭐) anytime, until your plan expires.</i>\n` +
    (crypto ? `<i>💡 Pay with crypto for a better price.</i>\n` : ``) +
    `\nCurrent: <b>${esc(user?.tier || "Free")}</b> · Exp: <b>${fmtExp(user)}</b>`;
  const keyboard = new InlineKeyboard()
    .text(`Pro · ${c.proLimit} acc`, "plan:pro").text(`Whale · ${c.whaleLimit} acc`, "plan:whale").row()
    .text(`➕ Pack +${c.packSize} acc`, "plan:pack").row()
    .text("⬅️ Back", "home").text("ⓧ Close", "close");
  return { text, keyboard };
}

// Chọn phương thức thanh toán — nudge crypto giá tốt (KHÔNG nêu số cụ thể).
export function paymentMethodScreen(kind, c) {
  const name = kind === "pack" ? `Pack +${c.packSize}` : kind === "whale" ? "Whale" : "Pro";
  const text =
    `💳 <b>${name} — choose how to pay</b>\n\n` +
    `⭐ <b>Telegram Stars</b> — instant, in-app.\n` +
    `🪙 <b>Crypto</b> — <b>better price</b> 💸 · USDC / USDT / SOL on Solana.`;
  const keyboard = new InlineKeyboard()
    .text("⭐ Pay with Stars", `stars:${kind}`).row()
    .text("🪙 Crypto — better price 💸", `crypto:${kind}`).row()
    .text("⬅️ Back", "subscribe").text("ⓧ Close", "close");
  return { text, keyboard };
}

// Chọn coin (đều trên Solana)
export function cryptoCoinScreen(kind, c) {
  const name = kind === "pack" ? `Pack +${c.packSize}` : kind === "whale" ? "Whale" : "Pro";
  const text = `🪙 <b>${name} — pay with crypto</b>\n\nAll on <b>Solana</b> (low fees, fast). Pick a coin:`;
  const keyboard = new InlineKeyboard()
    .text("USDC", `pc:${kind}:usdc`).text("USDT", `pc:${kind}:usdt`).text("SOL", `pc:${kind}:sol`).row()
    .text("⬅️ Back", `plan:${kind}`).text("ⓧ Close", "close");
  return { text, keyboard };
}

// Màn invoice: địa chỉ + số tiền CHÍNH XÁC + hạn. Số lẻ cuối = định danh giao dịch.
export function cryptoInvoiceScreen(kind, coin, amount, address, expiresMin) {
  const text =
    `🪙 <b>Pay with ${coin} on Solana</b>\n\n` +
    `<b>Amount:</b> <code>${amount}</code> ${coin}  <i>(tap to copy)</i>\n` +
    `<b>To:</b> <code>${esc(address)}</code>\n\n` +
    `✅ <b>Auto-confirmed by this EXACT amount.</b> The final digits are your unique code — that's how we detect <i>your</i> payment automatically, with no extra step.\n` +
    `⚠️ Send it <b>to the last digit</b> — do <b>not</b> round or change it, or it won't auto-credit.\n` +
    `⏱ Valid ~<b>${expiresMin}</b> min · credited within ~1 min of on-chain confirmation.\n` +
    `<i>Didn't credit? Send</i> <code>/pay &lt;tx signature&gt;</code>.`;
  const keyboard = new InlineKeyboard()
    .text("⬅️ Change coin", `crypto:${kind}`).row()
    .text("🏠 Home", "home").text("ⓧ Close", "close");
  return { text, keyboard };
}

export function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
export { byKey };
