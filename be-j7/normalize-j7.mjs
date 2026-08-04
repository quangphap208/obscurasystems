// normalize-j7.mjs (BE j7) — chuẩn hoá event socket j7 -> CANONICAL event (khớp be/normalize.mjs
// của Bloom) để be-core/message.mjs render giống hệt & dedupKey khớp cho race cross-source.
// Reference shape: j7-kol-router/lib/format.mjs (normalize/normalizeActivity/normalizeProfile).
//
// PHẠM VI M2 (skeleton): emit tweet-like / deleted / follow / unfollow / suspend / deactivate
// + pin/unpin (dispatch tạm DROP do KIND_TO_COL chưa có pinned/unpinned — bật ở M4).
// CHƯA emit:
//   • profile / affiliation  -> đợi M4 (source-preference: j7 làm chủ, cần isJ7Covered + canon field)
//   • external (Truth/IG) / update(edit) -> ngoài phạm vi X-tracker dual-source.

import { makeProfileEvent } from "../be-core/message.mjs";

const urls = (arr) => (arr || []).map((m) => (typeof m === "string" ? m : m && m.url)).filter(Boolean);

// entry: map kind (từ j7feed.onEvent) -> canonical event | null
export function normalizeJ7(raw, kind) {
  if (!raw || typeof raw !== "object") return null;
  if (kind === "update" || kind === "external") return null;        // edit / multi-platform: bỏ
  if (kind === "affiliation") return null;                          // affiliation vẫn để Bloom lo (không double-fire)
  if (kind === "profile") return normProfile(raw);                  // -> MẢNG profileChanges (j7 làm chủ)
  if (kind === "deleted") return normDelete(raw);
  if (kind === "followed" || kind === "unfollowed") return normFollow(raw, kind);
  if (kind === "pinned" || kind === "unpinned") return normPin(raw, kind);
  if (kind === "deactivated" || kind === "suspended") return normLifecycle(raw, kind);
  return normTweet(raw);                                            // "tweet" | "initial"
}

// tweet / retweet / quote / reply — shape j7 gần trùng canonical.
function normTweet(raw) {
  const a = raw.author || {};
  const type = String(raw.type || "TWEET").toUpperCase();
  const sub = raw.isRetweet || type === "RETWEET" ? "retweet"
            : raw.isQuote   || type === "QUOTE"   ? "quote"
            : raw.isReply   || type === "REPLY"   ? "reply"
            : "tweet";
  let images = urls(raw.media && raw.media.images);
  let videos = urls(raw.media && raw.media.videos);
  // retweet: media nằm ở tweet gốc -> lấy originalMedia nếu bản thân rỗng
  if (sub === "retweet" && !images.length && !videos.length && raw.originalMedia) {
    images = urls(raw.originalMedia.images);
    videos = urls(raw.originalMedia.videos);
  }
  // j7: replyTo/quotedTweet là object PHẲNG {id,handle,...}; originalAuthor có .handle. Đọc cả 2 dạng.
  let target = null, parentId = null;
  if (sub === "reply")        { target = raw.replyTo?.handle     || raw.replyTo?.author?.handle     || null; parentId = raw.replyTo?.id || null; }
  else if (sub === "quote")   { target = raw.quotedTweet?.handle || raw.quotedTweet?.author?.handle || null; parentId = raw.quotedTweet?.id || null; }
  else if (sub === "retweet") { target = raw.originalAuthor?.handle || raw.originalAuthor?.author?.handle || null; parentId = raw.id || null; }
  const content = raw.text || (sub === "retweet" ? (raw.quotedTweet?.text || "") : "");
  return {
    kind: sub,
    authorId: a.id ? String(a.id) : null,
    actor: a.handle || null, actorName: a.name || "",
    content, tweetId: raw.id ? String(raw.id) : null,
    target, parentId: parentId ? String(parentId) : null,
    images, hasVideo: videos.length > 0,
    createdAt: raw.createdAt || null,
  };
}

function normDelete(e) {
  const s = e.tweet || e.deletedTweet || e || {};
  const a = s.author || {};
  const type = String(s.type || "TWEET").toUpperCase();
  const isRt = type === "RETWEET" || !!s.isRetweet;
  let images = urls(s.media && s.media.images);
  let videos = urls(s.media && s.media.videos);
  if (isRt && !images.length && !videos.length && s.originalMedia) {
    images = urls(s.originalMedia.images); videos = urls(s.originalMedia.videos);
  }
  const id = e.id || s.id || null;
  return {
    kind: "deleted", deletedIsRetweet: isRt,
    authorId: (e.author_id || a.id) ? String(e.author_id || a.id) : null,
    actor: a.handle || null, content: s.text || "",
    tweetId: id ? String(id) : null, target: null, parentId: null,
    images, hasVideo: videos.length > 0,
  };
}

// following_update { user, following } / unfollowing_update { user, unfollowing }
function normFollow(raw, kind) {
  const u = raw.user || {};
  const actor = u.handle || null;
  if (!actor) return null;
  const other = raw.following || raw.unfollowing || {};
  const p = other.profile || {};
  return {
    kind, actor, authorId: u.id ? String(u.id) : null,
    target: other.handle || null,
    tweetId: null, parentId: null, images: [], hasVideo: false,
    profileCard: profileCard(other, p),
  };
}

// profile_pinned/unpinned_update { user, pinned|unpinned:[tweetId|obj,...] }
function normPin(raw, kind) {
  const u = raw.user || {};
  const actor = u.handle || null;
  if (!actor) return null;
  const pinArr = (kind === "unpinned" ? raw.unpinned : raw.pinned) || [];
  const pin0 = pinArr[0];
  const pinObj = pin0 && typeof pin0 === "object" ? pin0 : null;
  const pinId = pinObj ? (pinObj.id ?? null) : (typeof pin0 === "string" ? pin0 : null);
  const isReply = pinObj ? (pinObj.isReply || String(pinObj.type || "").toUpperCase() === "REPLY") : false;
  return {
    kind, actor, authorId: u.id ? String(u.id) : null,
    target: isReply ? (pinObj.replyTo?.handle || pinObj.replyTo?.author?.handle || null) : null,
    content: pinObj?.text || "", pinnedIsReply: !!isReply,
    tweetId: pinId ? String(pinId) : null,
    parentId: pinObj?.replyTo?.id ? String(pinObj.replyTo.id) : null,
    images: [], hasVideo: false,
  };
}

// profile_deactivated_update / profile_suspended_update { user } — j7 không có biến "un-" -> undo=false.
function normLifecycle(raw, kind) {
  const u = raw.user || {};
  const actor = u.handle || null;
  if (!actor) return null;
  return { kind, undo: false, authorId: u.id ? String(u.id) : null, actor, content: "", images: [], hasVideo: false };
}

// profile_update -> MẢNG profileChanges (1 event / field đổi), map j7 field -> vocab canonical (Bloom)
// để dedupKey khớp + render giống. 6 field j7 sở hữu; verified_badge/@handle Bloom lo (j7 không thấy).
function normProfile(raw) {
  const u = raw.user || {};
  const p = u.profile || {};
  const b = raw.before?.profile || {};
  const actor = u.handle || null;
  if (!actor) return null;
  const xid = u.id ? String(u.id) : null;
  const bioNow = typeof p.description === "string" ? p.description : (p.description?.text || "");
  const bioOld = typeof b.description === "string" ? b.description : (b.description?.text || "");
  const out = [];
  const add = (field, ov, nv) => {
    if ((ov ?? null) === (nv ?? null)) return;
    out.push(makeProfileEvent(field, ov ?? null, nv ?? null, { authorId: xid, actor }));
  };
  add("screenname", b.name, p.name);            // display name
  add("bio", bioOld, bioNow);
  add("geo", b.location, p.location);           // location -> geo (vocab Bloom)
  add("profile_picture", b.avatar, p.avatar);   // avatar (makeProfileEvent tự set images)
  add("banner_picture", b.banner, p.banner);    // banner
  add("url", b.url?.url, p.url?.url);            // website -> url
  return out.length ? out : null;
}

// Profile card (blockquote) cho follow — dựng theo ĐÚNG format Bloom (send_like_source.md §6) để
// khi race follow, tin không lệch dù nguồn nào thắng.
function profileCard(other, p) {
  const handle = other.handle || null;
  if (!handle) return "";
  const name = p.name || other.name || "";
  const bio = typeof p.description === "string" ? p.description : (p.description?.text || "");
  const fol = p.followingCount ?? other.followingCount ?? "?";
  const fers = p.followersCount ?? other.followersCount ?? other.metrics?.followers ?? "?";
  const website = p.url?.url || p.website || "";
  const location = p.location;
  const parts = [` ${name || handle} (${handle})`, `${fol} Following | ${fers} Followers`];
  if (bio) parts.push("", bio);
  const tail = [];
  if (location !== undefined) tail.push(`📍 ${location ?? "null"}`);
  if (website) tail.push(`🔗 ${website}`);
  if (tail.length) parts.push("", ...tail);
  return parts.join("\n");
}
