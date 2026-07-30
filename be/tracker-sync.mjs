// tracker-sync.mjs — đồng bộ union(watches.handle) với pool Bloom qua REST tsunami.
// Gán mỗi handle vào 1 shard còn chỗ; untrack handle không còn ai watch; re-home handle
// của shard chết sang shard sống; cảnh báo admin khi pool đầy hoặc shard hết hạn.
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers, trackNames, untrackNames } from "./lib/tsunami.mjs";

const KEY_TTL = 10 * 60 * 1000;

export class TrackerSync {
  constructor({ pool, tg, adminIds = [] }) {
    this.pool = pool; this.tg = tg; this.adminIds = adminIds;
    this.keys = new Map();          // session -> {key, ts}
    this.busy = false; this.lastAlert = 0;
  }

  async keyFor(session) {
    const c = this.keys.get(session);
    if (c && Date.now() - c.ts < KEY_TTL) return c.key;
    const key = await handshake(session);
    this.keys.set(session, { key, ts: Date.now() });
    return key;
  }

  alert(msg) {
    console.warn("[tracker-sync]", msg);
    if (Date.now() - this.lastAlert < 60000) return;
    this.lastAlert = Date.now();
    for (const id of this.adminIds) this.tg.notify(id, `⚠️ <b>Pool Bloom</b>: ${msg}`);
  }

  // Shard còn nhiều chỗ nhất (đang sống). load tính từ map cục bộ để không lệch trong 1 lượt.
  pickShard(accounts, activeIds, load) {
    let best = null, bestFree = 0;
    for (const a of accounts) {
      if (!activeIds.has(a.id)) continue;
      const free = a.capacity - (load.get(a.id) || 0);
      if (free > bestFree) { best = a; bestFree = free; }
    }
    return best;
  }

  async reconcile() {
    if (this.busy) return; this.busy = true;
    try {
      const accounts = await repo.listBloomAccounts(true);
      const activeIds = new Set(accounts.filter((a) => this.pool.get(a.id)?.alive).map((a) => a.id));
      const accById = new Map(accounts.map((a) => [a.id, a]));
      const desired = new Set(await repo.distinctHandles());
      const load = new Map();
      for (const a of accounts) load.set(a.id, await repo.shardLoad(a.id));

      // 1) dọn: untrack handle không còn ai watch; cập nhật ref; đánh dấu re-home nếu shard chết.
      const needAssign = new Set();
      for (const t of await repo.allTracked()) {
        const ref = await repo.refCount(t.handle);
        if (ref === 0 || !desired.has(t.handle)) {
          await this.untrack(accById.get(t.bloom_account_id), t.handle).catch(() => {});
          await repo.deleteTracked(t.handle);
          if (t.bloom_account_id != null) load.set(t.bloom_account_id, Math.max(0, (load.get(t.bloom_account_id) || 1) - 1));
          continue;
        }
        await repo.setTrackedRef(t.handle, ref);
        if (t.bloom_account_id == null || !activeIds.has(t.bloom_account_id)) {
          needAssign.add(t.handle);
          if (t.bloom_account_id != null) load.set(t.bloom_account_id, Math.max(0, (load.get(t.bloom_account_id) || 1) - 1));
        }
      }
      // 2) handle mới chưa tracked
      const trackedSet = new Set((await repo.allTracked()).map((t) => t.handle));
      for (const h of desired) if (!trackedSet.has(h) || needAssign.has(h)) needAssign.add(h);

      if (!activeIds.size) { if (desired.size) this.alert("không có shard nào sống — cần cập nhật session Bloom."); return; }

      // 3) gán + track
      for (const h of needAssign) {
        const shard = this.pickShard(accounts, activeIds, load);
        if (!shard) { this.alert(`pool đầy — handle @${h} chưa track được. Thêm tài khoản Bloom hoặc tăng capacity.`); continue; }
        let xid = await repo.xidForHandle(h);
        try {
          const key = await this.keyFor(shard.session_token);
          if (!xid) { const s = await searchUsers(shard.session_token, key, [h]); xid = s.found[0]?.twitter_id || null; }
          await trackNames(shard.session_token, key, [h]);
          await repo.upsertTracked(h, xid, shard.id, await repo.refCount(h));
          load.set(shard.id, (load.get(shard.id) || 0) + 1);
          console.log(`[tracker-sync] track @${h} -> shard ${shard.id}`);
        } catch (e) {
          console.warn(`[tracker-sync] track @${h} lỗi:`, e.message);
        }
      }
    } finally { this.busy = false; }
  }

  async untrack(account, handle) {
    if (!account) return;
    const key = await this.keyFor(account.session_token);
    await untrackNames(account.session_token, key, [handle]);
    console.log(`[tracker-sync] untrack @${handle} (shard ${account.id})`);
  }

  start(intervalMs = 20000) {
    this.reconcile();
    this._timer = setInterval(() => this.reconcile(), intervalMs);
    return this._timer;
  }
  stop() { clearInterval(this._timer); }
}
