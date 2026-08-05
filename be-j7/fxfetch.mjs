// fxfetch.mjs — fix TRIỆT ĐỂ vụ cắt (docs/J7_TRUNCATION.md §8): ~19% tweet cắt KHÔNG BAO GIỜ có expansion
// (server j7 không sinh enrichment, đo 05-08-2026) -> hết WAIT_MS thì fetch bản đầy đủ từ fxtwitter
// thay vì gửi bản cắt. fxtwitter lỗi/timeout -> trả null, buffer gửi bản cắt như cũ (không tệ hơn).
// SOURCE-AGNOSTIC: chỉ thao tác trên canonical event -> dùng chung j7-kol-router + build-bot.
const TIMEOUT_MS = 4000;

// fxtwitter tweet object -> event nội bộ. Nền là `ev` (bản cắt đã normalize) — chỉ vá content/media/
// type/target, GIỮ actor/authorId/source gốc (với RT, fx `author` là người viết tweet GỐC, không phải actor).
// PURE — test không cần mạng.
export function mapFxTweet(ev, t) {
  if (!ev || !t || !t.id) return null;
  const photos = (t.media?.photos || []).map((p) => p?.url).filter(Boolean);
  const hasVideo = (t.media?.videos || []).length > 0;
  // fxtwitter resolve id của RT về tweet GỐC + cờ reposted_by = người RT.
  const isRt = ev.kind === "retweet" || !!t.reposted_by;
  const isQuote = !isRt && !!t.quote;
  const isReply = !isRt && !isQuote && (!!t.replying_to || ev.kind === "reply");
  const kind = isRt ? "retweet" : isQuote ? "quote" : isReply ? "reply" : "tweet";
  return {
    ...ev, kind,
    content: t.text || ev.content || "",
    images: photos.length ? photos : ev.images || [],
    hasVideo: hasVideo || !!ev.hasVideo,
    target: isRt ? (t.author?.screen_name || ev.target)
      : isQuote ? (t.quote?.author?.screen_name || ev.target)
      : isReply ? (t.replying_to || ev.target)
      : null,
    parentId: isRt ? (ev.parentId || ev.tweetId)                     // RT: normalize dùng chính id RT
      : isQuote ? (t.quote?.id ? String(t.quote.id) : ev.parentId)
      : isReply ? (t.replying_to_status ? String(t.replying_to_status) : ev.parentId)
      : null,
  };
}

// GET api.fxtwitter.com/status/<id> -> event đầy đủ, hoặc null (mọi lỗi/timeout -> để buffer fallback).
export async function fetchFullTweet(ev) {
  if (!ev?.tweetId) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.fxtwitter.com/status/${ev.tweetId}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.code !== 200 || !j.tweet) return null;
    return mapFxTweet(ev, j.tweet);
  } catch { return null; }
  finally { clearTimeout(timer); }
}
