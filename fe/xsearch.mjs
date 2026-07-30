// xsearch.mjs — FE dùng 1 session Bloom (từ pool) để validate handle X khi /add.
// Nếu pool trống -> bỏ qua validate (BE reconciler sẽ resolve x_user_id sau).
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers } from "../be/lib/tsunami.mjs";

let cache = null; // {session, key, ts}

async function keyFor(session) {
  if (cache && cache.session === session && Date.now() - cache.ts < 10 * 60 * 1000) return cache.key;
  const key = await handshake(session);
  cache = { session, key, ts: Date.now() };
  return key;
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
