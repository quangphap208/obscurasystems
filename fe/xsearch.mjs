// xsearch.mjs — FE dùng 1 session Bloom (từ pool) để validate handle X khi /add.
// Nếu pool trống -> bỏ qua validate (BE reconciler sẽ resolve x_user_id sau).
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers } from "../be/lib/tsunami.mjs";

let cache = null; // {session, key, ts}

// Trích username X từ: "elonmusk" | "@elonmusk" | link (x.com/twitter.com/fixupx/fx/vx/nitter,
// có hoặc không https, kèm /status/… hay ?query). Trả về handle lowercase hợp lệ, hoặc null.
const RESERVED = new Set(["i", "home", "explore", "search", "notifications", "messages",
  "settings", "compose", "intent", "hashtag", "share", "login", "signup"]);
export function parseHandle(input) {
  let s = String(input ?? "").trim();
  if (!s) return null;
  const m = s.match(/(?:^|\/\/)(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com|fixupx\.com|fxtwitter\.com|vxtwitter\.com|nitter\.[^/\s]+)\/(@?[A-Za-z0-9_]{1,15})/i);
  if (m) s = m[1];
  s = s.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(s) || RESERVED.has(s)) return null;
  return s;
}

async function keyFor(session) {
  if (cache && cache.session === session && Date.now() - cache.ts < 10 * 60 * 1000) return cache.key;
  const key = await handshake(session);
  cache = { session, key, ts: Date.now() };
  return key;
}

// Batch validate cho /bulkadd: N handle -> Map(handle -> {found, xid?, handle?}). 1 request search
// mỗi 50 handle (CHUNK an toàn như profile-poller). Pool trống / request lỗi -> Map rỗng (caller
// thêm KHÔNG validate, BE reconciler resolve x_user_id sau — cùng semantics resolveHandle skipped).
export async function resolveHandles(handles) {
  const out = new Map();
  const accounts = await repo.listBloomAccounts(true);
  if (!accounts.length) return out;
  const acc = accounts[0];
  try {
    const key = await keyFor(acc.session_token);
    for (let i = 0; i < handles.length; i += 50) {
      const chunk = handles.slice(i, i + 50);
      const { found } = await searchUsers(acc.session_token, key, chunk);
      const fmap = new Map((found || []).map((u) => {
        const h = String(u.twitter_handle || u.handle || u.username || u.screen_name || "").replace(/^@/, "").toLowerCase();
        return [h, u];
      }));
      for (const h of chunk) {
        const u = fmap.get(h);
        out.set(h, u
          ? { found: true, xid: u.twitter_id || u.id || null, handle: String(u.twitter_handle || u.handle || u.username || h).replace(/^@/, "") }
          : { found: false });
      }
    }
  } catch (e) { console.warn("[xsearch bulk]", e.message); out.clear(); }   // lỗi giữa chừng -> coi như skip validate toàn bộ
  return out;
}

// -> { skipped } | { found:false } | { found:true, xid, handle }
export async function resolveHandle(handle) {
  const accounts = await repo.listBloomAccounts(true);
  if (!accounts.length) return { skipped: true };
  const acc = accounts[0];
  try {
    const key = await keyFor(acc.session_token);
    const { found } = await searchUsers(acc.session_token, key, [handle]);
    const u = found[0];
    if (!u) return { found: false };
    return { found: true, xid: u.id || null, handle: (u.handle || u.username || handle).replace(/^@/, "") };
  } catch (e) {
    console.warn("[xsearch]", e.message);
    return { skipped: true };
  }
}
