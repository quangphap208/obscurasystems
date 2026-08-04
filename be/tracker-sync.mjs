// tracker-sync.mjs — đồng bộ union(watches.handle) với pool Bloom qua REST tsunami.
// Gán mỗi handle vào 1 shard còn chỗ; untrack handle không còn ai watch; re-home handle
// của shard chết sang shard sống; cảnh báo admin khi pool đầy hoặc shard hết hạn.
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers, trackNames, untrackIds, fetchState } from "./lib/tsunami.mjs";
import { cfg } from "../shared/config.mjs";
import { slackAlert } from "../shared/slack.mjs";

const KEY_TTL = 10 * 60 * 1000;

export class TrackerSync {
  constructor({ pool, tg, adminIds = [] }) {
    this.pool = pool; this.tg = tg; this.adminIds = adminIds;
    this.keys = new Map();          // session -> {key, ts}
    this.busy = false; this.lastAlert = 0; this.lastSlack = 0;
  }

  async keyFor(session) {
    const c = this.keys.get(session);
    if (c && Date.now() - c.ts < KEY_TTL) return c.key;
    const key = await handshake(session);
    this.keys.set(session, { key, ts: Date.now() });
    return key;
  }

  // toSlack: chỉ các lỗi ĐÁNG BÁO XA (pool đầy, không shard sống, reconcile lỗi). Slack rate-limit 5'
  // riêng để pool-full không bị nuốt bởi 1 alert self-heal trước đó (2 mốc thời gian độc lập).
  alert(msg, toSlack = false) {
    console.warn("[tracker-sync]", msg);
    if (toSlack && Date.now() - this.lastSlack > 300000) {
      this.lastSlack = Date.now();
      slackAlert(`⚠️ *Bloom* tracker-sync: ${msg}`);
    }
    if (Date.now() - this.lastAlert < 60000) return;
    this.lastAlert = Date.now();
    for (const id of this.adminIds) this.tg.notify(id, `⚠️ <b>Source pool</b>: ${msg}`);
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
          await this.untrack(accById.get(t.bloom_account_id), t.x_user_id, t.handle).catch(() => {});
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

      if (!activeIds.size) { if (desired.size) this.alert("no live shard — a source session needs updating.", true); return; }

      // 3) gán + track
      for (const h of needAssign) {
        const shard = this.pickShard(accounts, activeIds, load);
        if (!shard) { this.alert(`pool full — @${h} could not be tracked. Add a source account or raise capacity.`, true); continue; }
        let xid = await repo.xidForHandle(h);
        try {
          const key = await this.keyFor(shard.session_token);
          if (!xid) { const s = await searchUsers(shard.session_token, key, [h]); xid = s.found[0]?.id || null; }
          await trackNames(shard.session_token, key, [h]);
          await repo.upsertTracked(h, xid, shard.id, await repo.refCount(h));
          load.set(shard.id, (load.get(shard.id) || 0) + 1);
          console.log(`[tracker-sync] track @${h} -> shard ${shard.id}`);
        } catch (e) {
          console.warn(`[tracker-sync] track @${h} lỗi:`, e.message);
        }
      }

      // 4) đối chiếu STATE THẬT của Bloom (không chỉ tin tracked_handles).
      const activeAccounts = accounts.filter((a) => activeIds.has(a.id));
      if (activeAccounts.length && desired.size) {
        // fetch state 1 lần / shard
        const states = new Map();
        for (const a of activeAccounts) {
          try { states.set(a.id, await fetchState(a.session_token, await this.keyFor(a.session_token))); }
          catch (e) { console.warn("[tracker-sync] fetchState lỗi shard", a.id, e.message); }
        }
        const visibleAll = new Set();
        for (const st of states.values())
          for (const x of st) if (!x.hidden) visibleAll.add(String(x.twitter_handle || "").toLowerCase());

        // 4a) SELF-HEAL: handle mình watch nhưng KHÔNG visible trên Bloom (track fail âm thầm / Bloom
        //     drop / sót từ account cũ) -> track lại trên shard đã gán (hoặc shard sống đầu tiên).
        const missing = [...desired].filter((h) => !visibleAll.has(h));
        if (missing.length) {
          const assign = new Map((await repo.allTracked()).map((t) => [t.handle, t.bloom_account_id]));
          const byShard = new Map();
          for (const h of missing) {
            let sid = assign.get(h);
            if (sid == null || !activeIds.has(sid)) sid = activeAccounts[0].id;
            (byShard.get(sid) || byShard.set(sid, []).get(sid)).push(h);
          }
          for (const [sid, hs] of byShard) {
            const a = accById.get(sid);
            try {
              const key = await this.keyFor(a.session_token);
              for (let i = 0; i < hs.length; i += 100) await trackNames(a.session_token, key, hs.slice(i, i + 100));
              console.log(`[tracker-sync] self-heal: track lại ${hs.length} handle thiếu trên shard ${sid}: ${hs.join(", ")}`);
              this.alert(`self-heal: track lại ${hs.length} account bị thiếu trên shard ${sid}.`);
            } catch (e) { console.warn("[tracker-sync] self-heal lỗi:", e.message); }
          }
        }

        // 4b) exclusive: giữ account Bloom CHỈ gồm handle mình watch (untrack phần thừa).
        if (cfg.sourceExclusive) {
          for (const a of activeAccounts) {
            const st = states.get(a.id); if (!st) continue;
            const orphanIds = st.filter((x) => x.twitter_handle && !x.hidden && !desired.has(String(x.twitter_handle).toLowerCase())).map((x) => x.twitter_id).filter(Boolean);
            if (!orphanIds.length) continue;
            try {
              const key = await this.keyFor(a.session_token);
              for (let i = 0; i < orphanIds.length; i += 100) await untrackIds(a.session_token, key, orphanIds.slice(i, i + 100)).catch(() => {});
              console.log(`[tracker-sync] exclusive: untrack ${orphanIds.length} orphan (shard ${a.id})`);
              this.alert(`exclusive: đã untrack ${orphanIds.length} account thừa (shard ${a.id}).`);
            } catch (e) { console.warn("[tracker-sync] exclusive lỗi:", e.message); }
          }
        }
      }
    } catch (e) {
      console.error("[tracker-sync] reconcile lỗi:", e.message);
      this.alert(`reconcile lỗi: ${e.message}`, true);
    } finally { this.busy = false; }
  }

  async untrack(account, id, handle) {
    if (!account || !id) return;                       // cần twitter_id để untrack
    const key = await this.keyFor(account.session_token);
    await untrackIds(account.session_token, key, [id]);
    console.log(`[tracker-sync] untrack @${handle} (id ${id}, shard ${account.id})`);
  }

  start(intervalMs = 20000) {
    this.reconcile();
    this._timer = setInterval(() => this.reconcile(), intervalMs);
    return this._timer;
  }
  stop() { clearInterval(this._timer); }
}
