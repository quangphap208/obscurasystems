// events.mjs (be-core) — khoá dedup ổn định cho 1 event (chưa gắn user).
// DÙNG CHUNG cho BE Bloom + BE j7: cùng 1 event logic -> CÙNG dedupKey -> ghi vào collection
// `deliveries` (_id = key:tg, unique atomic) cho "nguồn nào tới trước thắng" (cross-source race).
export function dedupKey(e) {
  if (e.kind === "deleted") return `del:${e.tweetId}:${e.authorId}`;
  if (e.kind === "followed" || e.kind === "unfollowed") return `${e.kind}:${e.authorId}:${e.target}`;
  if (e.kind === "profileChanges") return `pc:${e.authorId}:${e.field}:${e.newValue}`;
  if (e.kind === "affiliation") return `aff:${e.authorId}:${e.content}`;
  if (e.kind === "suspended" || e.kind === "deactivated") return `${e.kind}:${e.authorId}:${e.undo ? 1 : 0}`;
  return `${e.kind}:${e.tweetId}`;
}
