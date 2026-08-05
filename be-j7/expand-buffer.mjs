// expand-buffer.mjs — j7 gửi tweet 2 PHA (bằng chứng dump payload thật):
//   1) event `tweet`  = snapshot SỚM, thiếu: text cắt (kết thúc "…" hoặc chèn self-link i/web/status),
//      media rỗng, đôi khi SAI type (TWEET nhưng thật ra QUOTE).
//   2) event `tweet_update` cờ `isExpandedUpdate:true` = ĐẦY ĐỦ: full text + media + đúng type + quotedTweet.
// j7-kol + build-bot cũ DROP mọi update -> mất bản đầy đủ. Buffer này: GIỮ bản cắt ~WAIT ms, thay bằng
// expansion khi tới (huỷ bản cắt). Expansion không tới -> `fetchFull` fxtwitter (§8 J7_TRUNCATION.md:
// ~19% tweet cắt server KHÔNG BAO GIỜ sinh expansion) -> vẫn fail mới gửi bản cắt (gate lo nhường Bloom).
// Tweet KHÔNG cắt -> gửi NGAY (không trễ). `dispatched` TTL 60s: bỏ expansion tới trễ của tweet đã gửi
// (tránh dup do reclassify type: tweet:id vs quote:id là 2 dedupKey khác nhau).
import { J7_TRUNCATED } from "../be-core/events.mjs";
const WAIT_MS = 3000;

export function makeExpandBuffer({ dispatch, fetchFull }) {
  const pending = new Map();     // tweetId -> timer (bản cắt đang đợi expansion)
  const dispatched = new Map();  // tweetId -> timer quên (đã gửi -> bỏ expansion trễ)

  const markSent = (id) => {
    const old = dispatched.get(id); if (old) clearTimeout(old);
    dispatched.set(id, setTimeout(() => dispatched.delete(id), 60000));
  };
  const cancelPending = (id) => { const t = pending.get(id); if (t) { clearTimeout(t); pending.delete(id); } };

  return {
    // event tweet-like (đã normalize) + raw gốc (đọc text thô để bắt cắt).
    tweet(ev, raw) {
      const id = ev.tweetId;
      if (!id) return dispatch(ev);
      // RETWEET: LUÔN đợi expansion (bản đầu luôn hiển thị tweet gốc bị cắt + media rỗng, bất kể form text).
      // Còn lại: đợi nếu text CÓ dấu cắt (…/.../i-web-status/link-quote) — quote bị misclassify thành tweet.
      const incomplete = ev.kind === "retweet" || J7_TRUNCATED.test(ev.content || "") || J7_TRUNCATED.test(raw?.text || "");
      if (!incomplete) { markSent(id); return dispatch(ev); }   // đủ -> gửi ngay
      cancelPending(id);
      console.log(`[j7-buf] hold @${ev.actor || "?"} ${ev.kind} — đợi expansion (${WAIT_MS}ms)`);
      pending.set(id, setTimeout(() => {
        pending.delete(id); markSent(id);   // markSent TRƯỚC khi fetch: expansion tới trong lúc fetch -> bỏ (không dup)
        if (!fetchFull) {
          console.log(`[j7-buf] @${ev.actor || "?"} KHÔNG có expansion sau ${WAIT_MS}ms -> bản cắt (fallback -> gate/Bloom)`);
          return dispatch(ev);
        }
        Promise.resolve(fetchFull(ev)).then((full) => {
          if (full) { console.log(`[j7-fx] @${ev.actor || "?"} ${ev.kind} không expansion -> fxtwitter ✓ (bản đầy đủ)`); dispatch(full); }
          else { console.log(`[j7-fx] @${ev.actor || "?"} ${ev.kind} không expansion, fxtwitter ✗ -> bản cắt (fallback -> gate/Bloom)`); dispatch(ev); }
        }).catch(() => dispatch(ev));
      }, WAIT_MS));
    },
    // isExpandedUpdate (đã normalize thành tweet đầy đủ) -> thay bản cắt đang đợi.
    expanded(ev) {
      const id = ev.tweetId;
      if (id && dispatched.has(id)) return;   // bản đủ đã gửi -> bỏ (tránh dup reclassify)
      const wasPending = id && pending.has(id);
      if (id) { cancelPending(id); markSent(id); }
      if (wasPending) console.log(`[j7-buf] @${ev.actor || "?"} expansion ✓ -> gửi bản ĐẦY ĐỦ (j7 tự render)`);
      dispatch(ev);
    },
    stop() {
      for (const t of pending.values()) clearTimeout(t);
      for (const t of dispatched.values()) clearTimeout(t);
      pending.clear(); dispatched.clear();
    },
  };
}
