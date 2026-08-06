// dispatch.mjs (be-core) — canonical event -> tìm user đang watch -> lọc theo settings -> gửi DM.
// DÙNG CHUNG cho BE Bloom + BE j7. markDelivered (deliveries) là trọng tài race: nguồn nào gọi
// trước thắng, nguồn sau bị duplicate key -> tự bỏ (không gửi trùng). dedupKey/render đều dùng chung.
import * as repo from "../shared/repo.mjs";
import { cfg } from "../shared/config.mjs";
import { KIND_TO_COL } from "../shared/settings.mjs";
import { buildMessage } from "./message.mjs";
import { dedupKey, J7_TRUNCATED } from "./events.mjs";
import { rememberTweet, enrichDelete } from "./tweet-cache.mjs";

// Field profile mà j7 SỞ HỮU (map từ 6 field j7). verified_badge/handle KHÔNG ở đây -> Bloom vẫn giữ.
const J7_PROFILE_FIELDS = new Set(["screenname", "bio", "geo", "profile_picture", "banner_picture", "url"]);

// Quality-gate cho tweet j7: event `tweet` đầu của j7 đôi khi là SNAPSHOT CHƯA ĐỦ — X cắt text dài/note
// tweet rồi chèn self-link `i/web/status/<id>`, video tới sau qua `tweet_update` (cả build-bot lẫn j7-kol
// đều drop). Không field nào chứa bản đầy đủ. -> Nếu j7 bị cắt VÀ Bloom đang track handle: BỎ bản j7,
// nhường Bloom (đầy đủ). j7 vẫn thắng (first-send) khi data sạch. Bloom không cover -> vẫn nhận bản j7.
const J7_TWEET_KINDS = new Set(["tweet", "retweet", "quote", "reply"]);   // J7_TRUNCATED: dùng chung từ events.mjs

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
      // j7 tweet bị X cắt (self-link i/web/status) + Bloom track handle -> GATE: KHÔNG gửi bản j7 (nhường
      // Bloom bản đầy đủ). Vẫn cho HIỆN monitor (tag ⏸) để QC thấy j7 CÓ nhận, khỏi tưởng "j7 rớt".
      let gated = false;
      if (e.source === "j7" && J7_TWEET_KINDS.has(e.kind) && J7_TRUNCATED.test(e.content || "")) {
        const tr = await repo.getTracked(handle);
        if (tr && tr.bloom_account_id != null) { gated = true; console.log(`[j7-gate] tweet cắt @${handle} -> nhường Bloom (không gửi bản j7)`); }
      }
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
            // dup ← X CHỈ khi nguồn KHÁC thắng trước. Nếu "winner" là CHÍNH nguồn này (twin re-emit cùng
            // nguồn chạy song song -> race 2 khoá tách nhau) thì KHÔNG phải dup chéo nguồn -> hiện 🏆.
            const tag = (race.won || race.firstSource === (e.source || "?")) ? `🏆 ${e.source || "?"}` : `dup ← ${race.firstSource}`;
            const gtag = gated ? " · ⏸cắt→bloom" : "";
            const head = `<b>[${e.source || "?"} · ${tag}${gtag}]</b> <code>${e.kind}${e.platform ? ":" + e.platform : ""}</code> @${handle}`;
            if (gated) {
              // j7 bị cắt + ĐÃ CHẶN (Bloom gửi bản đủ) -> KHÔNG show thân tin cắt (gây tưởng lỗi), chỉ ghi chú.
              tg.send(cfg.monitorChat, { text: head + "\n<i>⤷ j7 bị cắt, đã chặn — Bloom đã gửi bản đầy đủ ✓</i>" });
            } else {
              const m = buildMessage(e, { botUser, deleteButton: false });
              tg.send(cfg.monitorChat, { text: m ? head + "\n" + m.text : head, link_preview_options: m?.link_preview_options, reply_markup: m?.reply_markup });
            }
          }
        } catch (err) { console.warn("[monitor]", err.message); }
      }
      // MONITOR_ONLY (TEST): chỉ bắn monitor channel, KHÔNG thử DM user. Test DB clone watches user prod
      // nhưng họ chưa /start bot test -> DM trả 400 chat-not-found + ăn rate-limit làm nghẽn monitor.
      // Mặc định TẮT -> prod gửi DM bình thường (flow chung không đổi).
      if (gated || cfg.monitorOnly) return;   // gated: đã hiện monitor (tag ⏸), KHÔNG gửi DM -> Bloom lo bản đầy đủ
      let sent = 0;
      for (const { tgId, settings } of watchers) {
        if (!settings[colKey]) continue;                // user tắt loại này
        if (!(await repo.markDelivered(key, tgId, e.source))) continue; // đã gửi/nguồn kia thắng (hoặc nguồn kia thắng)
        const ev = applyMediaFilter(e, settings);
        // refId = tg_id user này -> forward ra ngoài, ai bấm link = referral của họ (join-points). Gate cfg.refForwardCta
        // (mặc định TẮT, đang research) -> null = KHÔNG gắn footer. Bật lại: REF_FWD_CTA=1.
        const msg = buildMessage(ev, { botUser, deleteButton: !!settings.delete_button, refId: cfg.refForwardCta ? tgId : null });
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
