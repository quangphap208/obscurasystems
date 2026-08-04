// events.mjs (be-core) — khoá dedup ổn định cho 1 event (chưa gắn user).
// DÙNG CHUNG cho BE Bloom + BE j7: cùng 1 event logic -> CÙNG dedupKey -> ghi vào collection
// `deliveries` (_id = key:tg, unique atomic) cho "nguồn nào tới trước thắng" (cross-source race).
export function dedupKey(e) {
  if (e.kind === "deleted") return `del:${e.tweetId}:${e.authorId}`;
  // target = handle: chuẩn hoá (bỏ @ + lowercase) để Bloom (giữ hoa/thường) & j7 (thô) ra CÙNG key.
  if (e.kind === "followed" || e.kind === "unfollowed") return `${e.kind}:${e.authorId}:${String(e.target || "").replace(/^@/, "").toLowerCase()}`;
  if (e.kind === "profileChanges") return `pc:${e.authorId}:${e.field}:${e.newValue}`;
  if (e.kind === "affiliation") return `aff:${e.authorId}:${e.content}`;
  if (e.kind === "suspended" || e.kind === "deactivated") return `${e.kind}:${e.authorId}:${e.undo ? 1 : 0}`;
  if (e.kind === "platform") return `plat:${e.platform}:${e.postId}`;   // Truth/IG (chỉ j7, không race)
  return `${e.kind}:${e.tweetId}`;
}

// Dấu hiệu snapshot tweet j7 CHƯA đủ (bản `tweet` đầu; bản đủ đến qua tweet_update isExpandedUpdate).
// Nhiều FORM cắt (đã gặp thực tế): kết thúc "…"(U+2026) hoặc "..."(ASCII); chèn self-link note-tweet
// `i/web/status`; hoặc kết thúc = link tweet được quote `<handle>/status/<id>` (quote bị misclassify
// thành TWEET). Dùng CHUNG: expand-buffer (đợi expansion) + dispatch gate (fallback nhường Bloom).
export const J7_TRUNCATED = /…\s*$|\.\.\.\s*$|(?:x|twitter)\.com\/i\/web\/status\/|(?:x|twitter)\.com\/[^\/\s]+\/status\/\d+\s*$/i;
