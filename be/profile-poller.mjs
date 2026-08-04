// profile-poller.mjs — TỰ dò đổi profile (avatar / display name / verified badge).
// Lý do: tracker-state của Bloom cập nhật quá chậm để phát frame profile.update kịp thời
// (thực đo: follow bắt trong ~6 phút, nhưng avatar cả tiếng không nhúc nhích). Nên ta dò riêng:
//   batch-search mọi handle (dữ liệu X tươi) -> so snapshot Mongo -> field lệch thì tổng hợp
//   event profileChanges bơm thẳng vào dispatcher (tái dùng render + lọc settings + DM).
// Dedup theo pc:<xid>:<field>:<newValue> nên nếu Bloom lỡ có bắn frame trùng cũng không gửi 2 lần.
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers } from "./lib/tsunami.mjs";
import { makeProfileEvent } from "../be-core/message.mjs";
import { canonAvatar } from "../be-core/canon.mjs";

const KEY_TTL = 10 * 60 * 1000;
const CHUNK = 50;              // search nhận batch; ~50 handle/request cho an toàn

// field trong kết quả search -> subtype profile.update tương ứng.
// (search KHÔNG trả bio/banner/url/geo nên chỉ dò được 3 field này — đủ giá trị nhất.)
const FIELDS = [
  { key: "avatar", sub: "profile_picture" },
  { key: "name", sub: "screenname" },
  { key: "verified", sub: "verified_badge" },
];
// Field feed (author trên mỗi tweet) mang đáng tin: avatar + name. verified để poll lo
// (feed không chắc có verified_type -> tránh flapping ∅↔giá trị).
const FEED_FIELDS = [
  { key: "avatar", sub: "profile_picture" },
  { key: "name", sub: "screenname" },
];

// canonAvatar (bỏ hậu tố kích cỡ để so ổn định) đã chuyển sang be-core/canon.mjs — dùng chung Bloom + j7.
const snapOf = (u) => ({
  x_user_id: u.id != null ? String(u.id) : null,
  avatar: canonAvatar(u.profile_image_url),
  name: u.name || null,
  handle: (u.handle || u.username || "") || null,
  verified: u.verified_type || "",
});

export class ProfilePoller {
  constructor({ pool, dispatch, adminIds = [] }) {
    this.pool = pool; this.dispatch = dispatch; this.adminIds = adminIds;
    this.keys = new Map(); this.busy = false; this._accounts = [];
    this.snap = new Map();        // handle -> snapshot mới nhất (mirror in-memory cho feed-driven)
  }

  // Feed-driven: gọi từ onFrame với mỗi frame. Lấy author trên tweet-like, diff avatar/name
  // ngay lập tức (không chờ poll). Bỏ qua nếu handle chưa được poll seed đầy đủ (tránh false verified).
  observeFrame(frame) {
    const t = frame?.type;
    if (!["tweet", "retweet", "quote", "reply"].includes(t)) return;
    const a = frame.data?.author;
    if (a && (a.screen_name || a.handle || a.username)) this.observe(a).catch(() => {});
  }

  async observe(u) {
    const handle = String(u.screen_name || u.handle || u.username || "").toLowerCase();
    if (!handle) return;
    const prev = this.snap.get(handle);
    if (!prev) return;              // chưa có baseline (poll chưa seed) -> để poll seed đầy đủ trước
    const cur = { avatar: canonAvatar(u.profile_image_url), name: u.name || null };
    const xid = u.id != null ? String(u.id) : prev.x_user_id;
    const prevVal = (f) => f.key === "avatar" ? canonAvatar(prev[f.key]) : (prev[f.key] ?? null);
    const diffs = FEED_FIELDS.filter((f) => cur[f.key] != null && prevVal(f) !== cur[f.key]);
    if (!diffs.length) return;
    for (const f of diffs) {
      const e = makeProfileEvent(f.sub, prevVal(f), cur[f.key], { authorId: xid, actor: handle });
      if (f.sub === "profile_picture") e.images = [cur.avatar];
      await this.dispatch(e);
      console.log(`[profile-feed] @${handle} ${f.sub}: ${prevVal(f) ?? "∅"} -> ${cur[f.key]}`);
    }
    const merged = { ...prev, ...cur };
    this.snap.set(handle, merged);
    await repo.setProfileSnap(handle, { avatar: merged.avatar, name: merged.name }).catch(() => {});
  }

  async keyFor(session) {
    const c = this.keys.get(session);
    if (c && Date.now() - c.ts < KEY_TTL) return c.key;
    const key = await handshake(session);
    this.keys.set(session, { key, ts: Date.now() });
    return key;
  }

  activeSession() {
    for (const a of this._accounts) if (this.pool.get(a.id)?.alive) return a.session_token;
    return null;
  }

  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      this._accounts = await repo.listBloomAccounts(true);
      const session = this.activeSession();
      if (!session) return;
      const handles = await repo.distinctHandles();
      if (!handles.length) return;
      const key = await this.keyFor(session);

      // 1) batch-search lấy profile tươi
      const live = new Map();  // handle(lower) -> user object
      for (let i = 0; i < handles.length; i += CHUNK) {
        const s = await searchUsers(session, key, handles.slice(i, i + CHUNK)).catch(() => ({ found: [] }));
        for (const u of s.found) {
          const h = String(u.handle || u.username || "").toLowerCase();
          if (h) live.set(h, u);
        }
      }
      if (!live.size) return;

      // 2) so với snapshot; field lệch -> bơm event. Lần đầu thấy 1 handle: seed im lặng.
      const snaps = await repo.getProfileSnaps([...live.keys()]);
      let changed = 0;
      for (const [h, u] of live) {
        const cur = snapOf(u);
        const prev = this.snap.get(h) || snaps.get(h);   // ưu tiên mirror in-memory (feed cập nhật giữa 2 lượt)
        if (!prev) { this.snap.set(h, cur); await repo.setProfileSnap(h, cur); continue; }   // seed, không bắn
        const prevVal = (f) => f.key === "avatar" ? canonAvatar(prev[f.key]) : (prev[f.key] ?? null);
        const diffs = FIELDS.filter((f) => cur[f.key] != null && prevVal(f) !== cur[f.key]);
        this.snap.set(h, { ...prev, ...cur });           // luôn cập nhật mirror (kể cả khi không đổi)
        if (!diffs.length) continue;
        for (const f of diffs) {
          const e = makeProfileEvent(f.sub, prevVal(f), cur[f.key], { authorId: cur.x_user_id, actor: h });
          if (f.sub === "profile_picture") e.images = [cur.avatar];
          await this.dispatch(e);
          changed++;
          console.log(`[profile-poll] @${h} ${f.sub}: ${prevVal(f) ?? "∅"} -> ${cur[f.key]}`);
        }
        await repo.setProfileSnap(h, cur);
      }
      if (changed) console.log(`[profile-poll] ${changed} thay đổi / ${live.size} account`);
    } catch (e) {
      console.warn("[profile-poll]", e.message);
    } finally { this.busy = false; }
  }

  start(intervalMs = 300000) {
    this.poll();
    this._t = setInterval(() => this.poll(), intervalMs);
    return this._t;
  }
  stop() { clearInterval(this._t); }
}
