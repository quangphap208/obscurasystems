// dispatcher.mjs — event Bloom -> tìm user đang watch -> lọc theo settings -> gửi DM.
import * as repo from "../shared/repo.mjs";
import { KIND_TO_COL } from "../shared/settings.mjs";
import { buildMessage } from "./lib/format.mjs";
import { rememberTweet, enrichDelete } from "./tweet-cache.mjs";

// Khoá dedup ổn định cho 1 event (chưa gắn user).
function dedupKey(e) {
  if (e.kind === "deleted") return `del:${e.tweetId}:${e.authorId}`;
  if (e.kind === "followed" || e.kind === "unfollowed") return `${e.kind}:${e.authorId}:${e.target}`;
  if (e.kind === "profileChanges") return `pc:${e.authorId}:${e.field}:${e.newValue}`;
  if (e.kind === "affiliation") return `aff:${e.authorId}:${e.content}`;
  if (e.kind === "suspended" || e.kind === "deactivated") return `${e.kind}:${e.authorId}:${e.undo ? 1 : 0}`;
  return `${e.kind}:${e.tweetId}`;
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
      if (Date.now() < warmupUntil) return;            // nuốt backlog lúc mới connect

      const colKey = KIND_TO_COL[e.kind];
      if (!colKey) return;                              // loại không map (vd pins) -> bỏ

      const key = dedupKey(e);
      const botUser = getBotUser();
      const watchers = await repo.watchersOfHandle(handle);
      let sent = 0;
      for (const { tgId, settings } of watchers) {
        if (!settings[colKey]) continue;                // user tắt loại này
        if (!(await repo.markDelivered(key, tgId))) continue; // đã gửi cho user này
        const ev = applyMediaFilter(e, settings);
        const msg = buildMessage(ev, { botUser });
        if (!msg) continue;
        tg.send(tgId, msg, { priority: e.kind === "deleted" });   // delete chen lên đầu hàng đợi
        sent++;
      }
      if (sent) console.log(`[dispatch] ${e.kind} @${handle} -> ${sent} user`);
    } catch (err) { console.warn("[dispatch]", err.message); }
  };
}
