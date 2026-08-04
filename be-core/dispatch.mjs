// dispatch.mjs (be-core) — canonical event -> tìm user đang watch -> lọc theo settings -> gửi DM.
// DÙNG CHUNG cho BE Bloom + BE j7. markDelivered (deliveries) là trọng tài race: nguồn nào gọi
// trước thắng, nguồn sau bị duplicate key -> tự bỏ (không gửi trùng). dedupKey/render đều dùng chung.
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";
import { KIND_TO_COL } from "../shared/settings.mjs";
import { buildMessage } from "./message.mjs";
import { dedupKey } from "./events.mjs";
import { rememberTweet, enrichDelete } from "./tweet-cache.mjs";

// Field profile mà j7 SỞ HỮU (map từ 6 field j7). verified_badge/handle KHÔNG ở đây -> Bloom vẫn giữ.
const J7_PROFILE_FIELDS = new Set(["screenname", "bio", "geo", "profile_picture", "banner_picture", "url"]);

// Cache j7-coverage refresh 60s. CHỈ tin `main` (main-feed): response j7 trả main TƯƠI mỗi lần nên
// account bị j7 drop -> rớt khỏi main ngay -> gate nhả -> Bloom bù. KHÔNG dùng `pool`: pool gồm
// this.added mà response KHÔNG trả `custom.accounts` -> không phát hiện được pool-account bị drop ->
// nếu gate theo pool sẽ chặn Bloom trong khi j7 đã ngừng stream -> MẤT profile. Pool account vì thế
// KHÔNG bị gate (Bloom luôn bù); double được tránh bằng canon avatar bên j7 (dedup qua race).
// j7 down (list cũ >10') -> rỗng -> Bloom lo hết. j7 tắt hẳn -> rỗng -> hành vi Bloom-only.
let _j7cover = new Set(), _j7At = 0;
async function isJ7Covered(handle) {
  if (Date.now() - _j7At > 60000) {
    _j7At = Date.now();
    try {
      const d = await repo.getJ7List();
      _j7cover = (d && Date.now() - (d.updated_at || 0) < 600000) ? new Set(d.main || []) : new Set();
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

      // platform (Truth/IG): colKey = platform (settings.truth/ig), watcher lọc theo platform-watch.
      const isPlat = e.kind === "platform";
      const colKey = isPlat ? e.platform : KIND_TO_COL[e.kind];
      if (!colKey) return;                              // loại không map (vd pins) -> bỏ

      const key = dedupKey(e);
      const botUser = getBotUser();
      const watchers = await repo.watchersOfHandle(handle, isPlat ? e.platform : "x");

      // MONITOR firehose (TEST/QC): CHỈ handle CÓ user watch (theo watch-flow trong DB) — không bắn
      // handle không ai theo (vd ~1300 default Bloom). Vẫn bỏ qua per-user settings ("raw"). Cả 2 BE
      // gọi -> mỗi nguồn 1 dòng; nguồn tới trước = 🏆, sau = dup←winner. buildMessage FULL.
      if (cfg.monitorChat && watchers.length) {
        try {
          const race = await repo.monitorMark(key, e.source);
          if (race.firstShow) {                            // bỏ re-emit cùng nguồn (Bloom feed lặp) -> 1 dòng/nguồn/event
            const tag = race.won ? `🏆 ${e.source || "?"}` : `dup ← ${race.firstSource}`;
            const head = `<b>[${e.source || "?"} · ${tag}]</b> <code>${e.kind}${e.platform ? ":" + e.platform : ""}</code> @${handle}`;
            const m = buildMessage(e, { botUser, deleteButton: false });
            tg.send(cfg.monitorChat, { text: m ? head + "\n" + m.text : head, link_preview_options: m?.link_preview_options, reply_markup: m?.reply_markup });
          }
        } catch (err) { console.warn("[monitor]", err.message); }
      }
      // MONITOR_ONLY (TEST): chỉ bắn monitor channel, KHÔNG thử DM user. Test DB clone watches user prod
      // nhưng họ chưa /start bot test -> DM trả 400 chat-not-found + ăn rate-limit làm nghẽn monitor.
      // Mặc định TẮT -> prod gửi DM bình thường (flow chung không đổi).
      if (cfg.monitorOnly) return;
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
      // In target cho follow/unfollow: 2 dòng "followed @actor" trông giống nhau có thể là 2 TARGET
      // khác (lành tính) hay cùng target (dup) — thêm @target để tự phân biệt trong log.
      if (sent) {
        const extra = (e.kind === "followed" || e.kind === "unfollowed") && e.target ? ` → @${e.target}` : "";
        console.log(`[dispatch] ${e.kind} @${handle}${extra} -> ${sent} user`);
      }
    } catch (err) { console.warn("[dispatch]", err.message); }
  };
}
