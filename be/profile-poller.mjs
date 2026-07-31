// profile-poller.mjs — TỰ dò đổi profile (avatar / display name / verified badge).
// Lý do: tracker-state của Bloom cập nhật quá chậm để phát frame profile.update kịp thời
// (thực đo: follow bắt trong ~6 phút, nhưng avatar cả tiếng không nhúc nhích). Nên ta dò riêng:
//   batch-search mọi handle (dữ liệu X tươi) -> so snapshot Mongo -> field lệch thì tổng hợp
//   event profileChanges bơm thẳng vào dispatcher (tái dùng render + lọc settings + DM).
// Dedup theo pc:<xid>:<field>:<newValue> nên nếu Bloom lỡ có bắn frame trùng cũng không gửi 2 lần.
import * as repo from "../shared/repo.mjs";
import { handshake, searchUsers } from "./lib/tsunami.mjs";
import { makeProfileEvent } from "./lib/format.mjs";

const KEY_TTL = 10 * 60 * 1000;
const CHUNK = 50;              // search nhận batch; ~50 handle/request cho an toàn

// field trong kết quả search -> subtype profile.update tương ứng.
// (search KHÔNG trả bio/banner/url/geo nên chỉ dò được 3 field này — đủ giá trị nhất.)
const FIELDS = [
  { key: "avatar", sub: "profile_picture" },
  { key: "name", sub: "screenname" },
  { key: "verified", sub: "verified_badge" },
];

const snapOf = (u) => ({
  x_user_id: u.id != null ? String(u.id) : null,
  avatar: u.profile_image_url || null,
  name: u.name || null,
  handle: (u.handle || u.username || "") || null,
  verified: u.verified_type || "",
});

// ảnh preview: bỏ hậu tố _normal để lấy bản gốc (avatar search trả về là thumbnail 48px).
const fullImg = (url) => String(url || "").replace(/_normal(?=\.\w+($|\?))/, "");

export class ProfilePoller {
  constructor({ pool, dispatch, adminIds = [] }) {
    this.pool = pool; this.dispatch = dispatch; this.adminIds = adminIds;
    this.keys = new Map(); this.busy = false; this._accounts = [];
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
        const prev = snaps.get(h);
        if (!prev) { await repo.setProfileSnap(h, cur); continue; }   // seed, không bắn
        const diffs = FIELDS.filter((f) => cur[f.key] != null && (prev[f.key] ?? null) !== cur[f.key]);
        if (!diffs.length) continue;
        for (const f of diffs) {
          const e = makeProfileEvent(f.sub, prev[f.key] ?? null, cur[f.key], { authorId: cur.x_user_id, actor: h });
          if (f.sub === "profile_picture") e.images = [fullImg(cur.avatar)];
          await this.dispatch(e);
          changed++;
          console.log(`[profile-poll] @${h} ${f.sub}: ${prev[f.key] ?? "∅"} -> ${cur[f.key]}`);
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
