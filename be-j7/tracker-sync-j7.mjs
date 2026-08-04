// tracker-sync-j7.mjs (BE j7) — đồng bộ danh sách account j7 cần stream.
// j7-list = main-feed (~1491, LUÔN auto stream) ∪ available pool (~6346, add FREE). Handle NGOÀI
// list -> bỏ (Bloom lo, đúng routing dual-source). Cũng lưu j7_list vào Mongo cho gate isJ7Covered (M4).
// Dùng CHUNG socket của J7Feed (get_all_watched_accounts + custom_accounts_*_available_batch).
import * as repo from "../shared/repo.mjs";

// account từ j7 có thể là string hoặc object {handle|username} -> handle lowercase, bỏ @.
const handles = (arr) => (arr || [])
  .map((a) => (typeof a === "string" ? a : (a && (a.handle || a.username)) || ""))
  .filter((h) => typeof h === "string" && h)
  .map((h) => h.replace(/^@/, "").toLowerCase());

export class TrackerSyncJ7 {
  constructor({ feed, adminIds = [] }) {
    this.feed = feed;
    this.adminIds = adminIds;
    this.added = new Set();   // pool handle MÌNH đã add (để tính universe đầy đủ + biết cái nào gỡ được)
    this.busy = false;
  }

  // interval mặc định 5 phút: get_all_watched_accounts trả ~7800 account, list đổi CHẬM (vài chục/ngày)
  // -> fetch dày (<1h) tốn kết nối + dễ rate-limit (theo reverse j7-reload). Reconcile vẫn đủ nhạy vì
  // Bloom cover account mới /add NGAY; j7 chỉ cần vào race trong ~5' (pins/unpins KOL mới trễ tối đa 5').
  start(intervalMs = 300000) {
    this.feed.on("all_watched_accounts_response", (r) =>
      this.reconcile(r).catch((e) => console.warn("[j7-sync]", e.message)));
    this.tick();
    this._t = setInterval(() => this.tick(), intervalMs);
    return this._t;
  }

  tick() { this.feed.emit("get_all_watched_accounts", { sessionId: this.feed.token }); }

  async reconcile(r) {
    if (!r || r.success === false) return;
    if (this.busy) return;
    this.busy = true;
    try {
      const main = handles(r.x?.accounts);
      const avail = handles(r.custom?.availableAccounts);        // pool CHƯA add (còn available)
      // Guard rỗng bất thường (transient / lỗi server): GIỮ j7_list cũ, đừng ghi đè kẻo mất coverage
      // -> gate isJ7Covered tắt -> Bloom double-fire profile. (best-practice reverse j7-reload.)
      if (!main.length) { console.warn("[j7-sync] main-feed rỗng — bỏ qua lần này (giữ j7_list cũ)"); return; }
      const added = handles(r.custom?.accounts);                 // pool đã add server-side (thường response không trả -> [] -> rơi về this.added)
      for (const h of added) this.added.add(h);

      const mainSet = new Set(main), availSet = new Set(avail);
      const pool = [...new Set([...avail, ...this.added])];       // universe pool = chưa-add ∪ đã-add
      const universe = new Set([...main, ...pool]);
      await repo.saveJ7List({ main, pool });                     // cho gate isJ7Covered (M4)
      // Capture list global Truth/IG (đến free cùng response) cho FE picker (M5).
      const truth = handles(r.truth?.accounts), ig = handles(r.ig?.accounts);
      if (truth.length || ig.length) await repo.saveJ7Platforms({ truth, ig });

      const desired = new Set(await repo.distinctHandles());
      const needAdd = [...desired].filter((h) => availSet.has(h));                        // pool, chưa stream
      const needRemove = [...this.added].filter((h) => !desired.has(h) && !mainSet.has(h)); // đã add, hết ai watch

      if (needAdd.length) {
        this.feed.emit("custom_accounts_add_available_batch", { sessionId: this.feed.token, accounts: needAdd });
        for (const h of needAdd) this.added.add(h);
      }
      if (needRemove.length) {
        this.feed.emit("custom_accounts_remove_available_batch", { sessionId: this.feed.token, accounts: needRemove });
        for (const h of needRemove) this.added.delete(h);
      }

      const covered = [...desired].filter((h) => universe.has(h)).length;
      console.log(`[j7-sync] cover ${covered}/${desired.size} | +add ${needAdd.length} | -rm ${needRemove.length} | bloom-only ${desired.size - covered} | main ${main.length} pool ${pool.length}`);
    } finally {
      this.busy = false;
    }
  }

  stop() { clearInterval(this._t); }
}
