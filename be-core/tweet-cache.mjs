// tweet-cache.mjs (be-core) — nhớ nội dung tweet để render event delete (nguồn không trả nội dung
// khi đã xoá). DÙNG CHUNG Bloom + j7: nguồn nào thấy tweet trước thì cache; delete từ nguồn nào
// cũng enrich được từ cache chung. TTL do Mongo tự prune (index seen_at). Ở đây chỉ ghi/đọc.
import * as repo from "../shared/repo.mjs";

// Lưu mọi tweet-like đã thấy.
export async function rememberTweet(e) {
  if (!["tweet", "retweet", "quote", "reply"].includes(e.kind) || !e.tweetId) return;
  await repo.cacheTweet({
    tweet_id: e.tweetId, author_handle: e.actor,
    text: e.content, media: { images: e.images || [], video: e.hasVideo },
    is_retweet: e.kind === "retweet", rt_source: e.target || null,
  });
}

// Bổ sung nội dung cho event delete từ cache nếu nguồn gửi thiếu.
export async function enrichDelete(e) {
  if (e.kind !== "deleted" || !e.tweetId) return e;
  if (e.content && (e.images?.length || !e.deletedIsRetweet)) return e; // đã đủ
  const c = await repo.getCachedTweet(e.tweetId);
  if (!c) return e;
  return {
    ...e,
    content: e.content || c.text || "",
    actor: e.actor || c.author_handle || null,
    deletedIsRetweet: e.deletedIsRetweet || !!c.is_retweet,
    images: e.images?.length ? e.images : (c.media?.images || []),
    hasVideo: e.hasVideo || !!c.media?.video,
  };
}
