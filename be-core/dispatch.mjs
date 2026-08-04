// dispatch.mjs (be-core) — canonical event -> tìm user đang watch -> lọc theo settings -> gửi DM.
// DÙNG CHUNG cho BE Bloom + BE j7. markDelivered (deliveries) là trọng tài race: nguồn nào gọi
// trước thắng, nguồn sau bị duplicate key -> tự bỏ (không gửi trùng). dedupKey/render đều dùng chung.
import * as repo from "../shared/repo.mjs";
import { KIND_TO_COL } from "../shared/settings.mjs";
import { buildMessage } from "./message.mjs";
import { dedupKey } from "./events.mjs";
import { rememberTweet, enrichDelete } from "./tweet-cache.mjs";

// Field profile mà j7 SỞ HỮU (map từ 6 field j7). verified_badge/handle KHÔNG ở đây -> Bloom vẫn giữ.
const J7_PROFILE_FIELDS = new Set(["screenname", "bio", "geo", "profile_picture", "banner_picture", "url"]);

// Cache j7-coverage (main ∪ pool) refresh 60s. Nếu j7_list cũ >10' (j7 down) -> coi RỖNG để Bloom tự
// lo profile lại (fallback an toàn). j7 tắt hẳn -> luôn rỗng -> gate không kích hoạt -> hành vi Bloom-only.
let _j7cover = new Set(), _j7At = 0;
async function isJ7Covered(handle) {
  if (Date.now() - _j7At > 60000) {
    _j7At = Date.now();
    try {
      const d = await repo.getJ7List();
      _j7cover = (d && Date.now() - (d.updated_at || 0) < 600000)
        ? new Set([...(d.main || []), ...(d.pool || [])]) : new Set();
    } catch { /* lỗi -> giữ cache cũ */ }
  }
  return _j7cover.has(handle);
}

async function resolveHandle(e) {
  if (e.actor) return e.actor.toLowerCase();
  if (e.authorId) { const t = await repo.getTrackedByXid(e.authorId); if (t) return t.handle; }
  return null;
}

// Áp bộ lọc media theo settings: tắt photos/videos -> gỡ media (vẫn gửi text).
function applyMediaFilter(e, s) {
  let images = e.images || [], hasVideo = !!e.hasVideo;
  if (hasVideo && !s.videos) hasVideo = false;
  if (images.length && !s.photos) images = [];
  if (images === e.images && hasVideo === e.hasVideo) return e;
  return { ...e, images, hasVideo };
}

export function makeDispatcher({ tg, getBotUser, warmupUntil = 0 }) {
  return async function dispatch(e) {
    if (!e) return;
    try {
      await rememberTweet(e);
      if (e.kind === "deleted") e = await enrichDelete(e);

      const handle = await resolveHandle(e);
      if (!handle) return;
      if (!e.actor) e.actor = handle;                  // follow/profile: actor không có trong frame
      await repo.touchTracked(handle);
      // Source-preference: profile (6 field j7 sở hữu) -> j7 làm chủ. Account được j7 cover thì BỎ
      // profileChanges của Bloom/poller (giữ verified_badge/handle = field j7 không thấy). j7 tắt -> rỗng.
      if (e.source !== "j7" && e.kind === "profileChanges" && J7_PROFILE_FIELDS.has(e.field) && await isJ7Covered(handle)) return;
      if (Date.now() < warmupUntil) return;            // nuốt backlog lúc mới connect

      const colKey = KIND_TO_COL[e.kind];
      if (!colKey) return;                              // loại không map (vd pins) -> bỏ

      const key = dedupKey(e);
      const botUser = getBotUser();
      const watchers = await repo.watchersOfHandle(handle);
      let sent = 0;
      for (const { tgId, settings } of watchers) {
        if (!settings[colKey]) continue;                // user tắt loại này
        if (!(await repo.markDelivered(key, tgId, e.source))) continue; // đã gửi/nguồn kia thắng (hoặc nguồn kia thắng)
        const ev = applyMediaFilter(e, settings);
        const msg = buildMessage(ev, { botUser, deleteButton: !!settings.delete_button });
        if (!msg) continue;
        tg.send(tgId, msg, { priority: e.kind === "deleted" });   // delete chen lên đầu hàng đợi
        sent++;
      }
      if (sent) console.log(`[dispatch] ${e.kind} @${handle} -> ${sent} user`);
    } catch (err) { console.warn("[dispatch]", err.message); }
  };
}
