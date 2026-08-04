// normalize.mjs (BE Bloom) — chuẩn hoá frame WS Bloom ({type,data}) -> canonical event.
// Phần RIÊNG của nguồn Bloom (parse shape frame Bloom). Render + event builder profile dùng
// chung ở be-core/message.mjs. j7 có normalize-j7.mjs riêng, cùng đổ về canonical schema này.
import { makeProfileEvent } from "../be-core/message.mjs";

const SUBTYPE = { TWEET: "tweet", RETWEET: "retweet", REPLY: "reply", QUOTE: "quote" };

const mediaOf = (m = {}) => ({
  images: (m.images || []).filter(Boolean),
  videos: (m.videos || []).filter(Boolean),
});

// Lấy handle từ object user (shape Bloom/X không nhất quán: handle | screen_name | username).
const uHandle = (u) => {
  const h = u && (u.handle || u.screen_name || u.username);
  return h ? String(h).replace(/^@/, "") : null;
};

// Chuẩn hoá 1 frame ({type,data}) -> event thống nhất, hoặc null nếu bỏ qua.
export function normalize(frame) {
  if (!frame || typeof frame !== "object") return null;
  const t = frame.type, d = frame.data || {};

  // ---- compliance: delete / suspend / deactivate ----
  if (t === "compliance") {
    const ev = d.event_type;
    if (ev === "delete") {
      const tc = d.tweet_content || {};
      let { images, videos } = mediaOf(tc.media);
      const isRt = tc.type === "RETWEET" || !!tc.retweeted_status;
      if (isRt && !images.length && !videos.length) ({ images, videos } = mediaOf(tc.parent_tweet?.media));
      return {
        kind: "deleted", deletedIsRetweet: isRt,
        authorId: d.author_id ? String(d.author_id) : null, actor: tc.author?.screen_name || null,
        content: tc.text || tc.parent_tweet?.text || "", tweetId: d.entity_id || null,
        target: null, parentId: null, images, hasVideo: videos.length > 0,
      };
    }
    if (ev === "user_suspend" || ev === "user_unsuspend")
      return { kind: "suspended", undo: ev === "user_unsuspend", authorId: d.author_id ? String(d.author_id) : null, actor: d.screen_name || d.author?.screen_name || null, content: "", images: [], hasVideo: false };
    if (ev === "user_delete" || ev === "user_undelete")
      return { kind: "deactivated", undo: ev === "user_undelete", authorId: d.author_id ? String(d.author_id) : null, actor: d.screen_name || d.author?.screen_name || null, content: "", images: [], hasVideo: false };
    return null;
  }

  // ---- activity: follow / unfollow / profile changes ----
  // Envelope thật (reverse từ ws.js): { type:"activity", data:{ event, activity:{ user_id, change:{before,after}, ... } } }
  // actor KHÔNG có screen_name trong frame -> resolve theo user_id ở dispatcher (tracked_handles).
  if (t === "activity") {
    const ev = d.event || d.type || "";
    const act = d.activity || {};
    const actorId = act.user_id != null ? String(act.user_id) : (d.author?.id != null ? String(d.author.id) : null);
    const before = act.change?.before, after = act.change?.after;

    if (ev === "follow.follow" || ev === "follow.unfollow") {
      const t2 = ev === "follow.follow" ? after : before;         // followed=after, unfollowed=before
      const tgt = (t2 && typeof t2 === "object") ? t2 : {};
      return {
        kind: ev === "follow.follow" ? "followed" : "unfollowed",
        authorId: actorId, actor: null,
        target: uHandle(tgt), targetUser: tgt, content: "",
        profileCard: profileCard(tgt), images: [], hasVideo: false,
      };
    }
    if (ev.startsWith("profile.update."))
      return makeProfileEvent(ev.slice("profile.update.".length), before, after, { authorId: actorId });
    return null;
  }

  // ---- tweet-likes (Bloom gửi mọi loại dưới frame "tweet"; sub-type ở data.type) ----
  if (!["tweet", "retweet", "quote", "reply"].includes(t)) return null;
  const a = d.author || {};
  const sub = t === "tweet" ? (SUBTYPE[d.type] || "tweet") : t;
  let { images, videos } = mediaOf(d.media);
  if (sub === "retweet" && !images.length && !videos.length) ({ images, videos } = mediaOf(d.parent_tweet?.media));
  const content = d.text || (sub === "retweet" ? (d.parent_tweet?.text || "") : "");
  return {
    kind: sub, authorId: a.id ? String(a.id) : null, actor: a.screen_name || null, actorName: a.name || "",
    content, tweetId: d.id || null,
    target: d.parent_tweet?.author?.screen_name || null, parentId: d.parent_tweet?.id || null,
    images, hasVideo: videos.length > 0, createdAt: d.tweet_created_at || null,
  };
}

// Profile card (blockquote) cho follow — theo send_like_source.md §6.
function profileCard(u) {
  const handle = uHandle(u);
  if (!handle) return "";
  const pm = u.public_metrics || {};
  const fol = u.friends_count ?? u.following_count ?? pm.following_count ?? "?";
  const fers = u.followers_count ?? pm.followers_count ?? "?";
  const bio = u.description ?? u.bio;
  const parts = [` ${u.name || handle} (${handle})`, `${fol} Following | ${fers} Followers`];
  if (bio) parts.push("", bio);
  const tail = [];
  if (u.location !== undefined) tail.push(`📍 ${u.location ?? "null"}`);
  if (u.url) tail.push(`🔗 ${u.url}`);
  if (tail.length) parts.push("", ...tail);
  return parts.join("\n");
}
